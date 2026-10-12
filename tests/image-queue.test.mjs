import test from 'node:test';
import assert from 'node:assert/strict';

import { createTaskQueue } from '../src/lib/image-queue.ts';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('并发不超过上限', async () => {
  const queue = createTaskQueue({ concurrency: 2 });
  let maxActive = 0;

  const tasks = Array.from({ length: 6 }, (_, index) =>
    queue.run(async () => {
      maxActive = Math.max(maxActive, queue.active);
      assert.ok(queue.active <= 2, `active ${queue.active} exceeded concurrency 2`);
      await delay(20);
      return index;
    }),
  );

  const results = await Promise.all(tasks);
  assert.equal(results.length, 6);
  assert.equal(maxActive, 2);
  assert.equal(queue.active, 0);
  assert.equal(queue.pending, 0);
});

test('LIFO 顺序（并发 1 时依次入队 A、B、C，A 先执行，A 完成后执行 C 再 B）', async () => {
  const queue = createTaskQueue({ concurrency: 1, order: 'lifo' });
  const executedOrder = [];

  let resolveA;
  const gateA = new Promise((resolve) => {
    resolveA = resolve;
  });

  const promiseA = queue.run(async () => {
    executedOrder.push('A_start');
    await gateA;
    executedOrder.push('A_end');
    return 'A';
  });

  const promiseB = queue.run(async () => {
    executedOrder.push('B');
    return 'B';
  });

  const promiseC = queue.run(async () => {
    executedOrder.push('C');
    return 'C';
  });

  assert.equal(queue.pending, 2);
  assert.equal(queue.active, 1);

  resolveA();
  const results = await Promise.all([promiseA, promiseB, promiseC]);

  assert.deepEqual(results, ['A', 'B', 'C']);
  assert.deepEqual(executedOrder, ['A_start', 'A_end', 'C', 'B']);
  assert.equal(queue.pending, 0);
  assert.equal(queue.active, 0);
});

test('FIFO 选项按入队顺序依次执行', async () => {
  const queue = createTaskQueue({ concurrency: 1, order: 'fifo' });
  const executedOrder = [];

  let resolveA;
  const gateA = new Promise((resolve) => {
    resolveA = resolve;
  });

  const promiseA = queue.run(async () => {
    executedOrder.push('A_start');
    await gateA;
    executedOrder.push('A_end');
    return 'A';
  });

  const promiseB = queue.run(async () => {
    executedOrder.push('B');
    return 'B';
  });

  const promiseC = queue.run(async () => {
    executedOrder.push('C');
    return 'C';
  });

  resolveA();
  await Promise.all([promiseA, promiseB, promiseC]);

  assert.deepEqual(executedOrder, ['A_start', 'A_end', 'B', 'C']);
});

test('排队中任务的 signal 中止后被移除且 reject AbortError、不会被执行', async () => {
  const queue = createTaskQueue({ concurrency: 1 });
  let bExecuted = false;

  let resolveA;
  const gateA = new Promise((resolve) => {
    resolveA = resolve;
  });

  const promiseA = queue.run(async () => {
    await gateA;
    return 'A';
  });

  const controllerB = new AbortController();
  const promiseB = queue.run(
    async () => {
      bExecuted = true;
      return 'B';
    },
    { signal: controllerB.signal },
  );

  const promiseC = queue.run(async () => {
    return 'C';
  });

  assert.equal(queue.pending, 2);

  // Abort B while waiting in queue
  controllerB.abort();

  assert.equal(queue.pending, 1);
  await assert.rejects(promiseB, (err) => {
    assert.equal(err.name, 'AbortError');
    return true;
  });
  assert.equal(bExecuted, false);

  resolveA();
  const resultA = await promiseA;
  const resultC = await promiseC;

  assert.equal(resultA, 'A');
  assert.equal(resultC, 'C');
  assert.equal(bExecuted, false);
});

test('预先中止的 signal 立即 reject，任务不入队不执行', async () => {
  const queue = createTaskQueue({ concurrency: 1 });
  let executed = false;
  const controller = new AbortController();
  controller.abort();

  const promise = queue.run(
    async () => {
      executed = true;
      return 'val';
    },
    { signal: controller.signal },
  );

  await assert.rejects(promise, (err) => {
    assert.equal(err.name, 'AbortError');
    return true;
  });

  assert.equal(executed, false);
  assert.equal(queue.pending, 0);
  assert.equal(queue.active, 0);
});

test('setConcurrency 调大后立即补启动排队中的任务', async () => {
  const queue = createTaskQueue({ concurrency: 1 });
  const running = [];

  let resolveA;
  let resolveB;
  let resolveC;

  const gateA = new Promise((r) => { resolveA = r; });
  const gateB = new Promise((r) => { resolveB = r; });
  const gateC = new Promise((r) => { resolveC = r; });

  const promiseA = queue.run(async () => {
    running.push('A');
    await gateA;
    return 'A';
  });

  const promiseB = queue.run(async () => {
    running.push('B');
    await gateB;
    return 'B';
  });

  const promiseC = queue.run(async () => {
    running.push('C');
    await gateC;
    return 'C';
  });

  assert.equal(queue.active, 1);
  assert.equal(queue.pending, 2);
  assert.deepEqual(running, ['A']);

  // Concurrency increased from 1 to 3
  queue.setConcurrency(3);

  // Both B and C should have been started immediately
  assert.equal(queue.active, 3);
  assert.equal(queue.pending, 0);
  assert.ok(running.includes('B'));
  assert.ok(running.includes('C'));

  resolveA();
  resolveB();
  resolveC();

  const results = await Promise.all([promiseA, promiseB, promiseC]);
  assert.deepEqual(results, ['A', 'B', 'C']);
  assert.equal(queue.active, 0);
});

test('任务失败不影响后续任务正常执行', async () => {
  const queue = createTaskQueue({ concurrency: 1 });

  const promiseFail = queue.run(async () => {
    throw new Error('boom');
  });

  const promiseSuccess = queue.run(async () => {
    return 'success';
  });

  await assert.rejects(promiseFail, /boom/);
  const result = await promiseSuccess;
  assert.equal(result, 'success');
  assert.equal(queue.active, 0);
  assert.equal(queue.pending, 0);
});
