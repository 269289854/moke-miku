import test from 'node:test';
import assert from 'node:assert/strict';

import { shareInFlight, __resetSharedRequestsForTests } from '../src/lib/shared-request.ts';

test.beforeEach(() => {
  __resetSharedRequestsForTests();
});

test('并发调用同一 key 只执行一次 run，并返回同一个 promise', async () => {
  let runs = 0;
  let finish;
  const barrier = new Promise((resolve) => {
    finish = resolve;
  });

  const run = async () => {
    runs += 1;
    await barrier;
    return 'data-1';
  };

  const p1 = shareInFlight('key-concurrent', 1000, run);
  const p2 = shareInFlight('key-concurrent', 1000, run);
  const p3 = shareInFlight('key-concurrent', 1000, run);

  assert.equal(p1, p2);
  assert.equal(p2, p3);
  assert.equal(runs, 1);

  finish();

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1, 'data-1');
  assert.equal(r2, 'data-1');
  assert.equal(r3, 'data-1');
  assert.equal(runs, 1);
});

test('成功后在 ttl 毫秒内复用同一 promise 且不再调用 run', async () => {
  let runs = 0;
  let currentTime = 1000;
  const mockNow = () => currentTime;

  const run = async () => {
    runs += 1;
    return `run-${runs}`;
  };

  const p1 = shareInFlight('key-ttl', 500, run, mockNow);
  const r1 = await p1;
  assert.equal(r1, 'run-1');
  assert.equal(runs, 1);

  currentTime = 1300;
  const p2 = shareInFlight('key-ttl', 500, run, mockNow);
  assert.equal(p1, p2);
  const r2 = await p2;
  assert.equal(r2, 'run-1');
  assert.equal(runs, 1);
});

test('ttl 过后重新执行 run，过期条目被替换', async () => {
  let runs = 0;
  let currentTime = 1000;
  const mockNow = () => currentTime;

  const run = async () => {
    runs += 1;
    return `run-${runs}`;
  };

  const p1 = shareInFlight('key-expire', 500, run, mockNow);
  const r1 = await p1;
  assert.equal(r1, 'run-1');
  assert.equal(runs, 1);

  currentTime = 1500;
  const p2 = shareInFlight('key-expire', 500, run, mockNow);
  assert.notEqual(p1, p2);
  const r2 = await p2;
  assert.equal(r2, 'run-2');
  assert.equal(runs, 2);

  currentTime = 2001;
  const p3 = shareInFlight('key-expire', 500, run, mockNow);
  assert.notEqual(p2, p3);
  const r3 = await p3;
  assert.equal(r3, 'run-3');
  assert.equal(runs, 3);
});

test('run 失败（reject）时立即移除 key，下一次调用重新执行', async () => {
  let runs = 0;
  const run = async () => {
    runs += 1;
    if (runs === 1) {
      throw new Error('network error');
    }
    return 'recovered';
  };

  await assert.rejects(
    shareInFlight('key-fail', 1000, run),
    /network error/,
  );
  assert.equal(runs, 1);

  const result = await shareInFlight('key-fail', 1000, run);
  assert.equal(result, 'recovered');
  assert.equal(runs, 2);
});

test('并发失败调用共享同一 rejection，完成后 key 被清除', async () => {
  let runs = 0;
  let finish;
  const barrier = new Promise((_, reject) => {
    finish = reject;
  });

  const run = async () => {
    runs += 1;
    await barrier;
    return 'ok';
  };

  const p1 = shareInFlight('key-concurrent-fail', 1000, run);
  const p2 = shareInFlight('key-concurrent-fail', 1000, run);
  assert.equal(p1, p2);

  finish(new Error('concurrent failure'));

  await assert.rejects(p1, /concurrent failure/);
  await assert.rejects(p2, /concurrent failure/);
  assert.equal(runs, 1);

  const p3 = shareInFlight('key-concurrent-fail', 1000, async () => {
    runs += 1;
    return 'second-attempt';
  });
  assert.notEqual(p1, p3);
  assert.equal(await p3, 'second-attempt');
  assert.equal(runs, 2);
});

test('不同 key 之间互不影响', async () => {
  let runsA = 0;
  let runsB = 0;

  const runA = async () => {
    runsA += 1;
    return `a-${runsA}`;
  };

  const runB = async () => {
    runsB += 1;
    return `b-${runsB}`;
  };

  const pa1 = shareInFlight('key-a', 1000, runA);
  const pb1 = shareInFlight('key-b', 1000, runB);

  assert.notEqual(pa1, pb1);
  const [ra1, rb1] = await Promise.all([pa1, pb1]);
  assert.equal(ra1, 'a-1');
  assert.equal(rb1, 'b-1');
  assert.equal(runsA, 1);
  assert.equal(runsB, 1);
});

test('__resetSharedRequestsForTests 可清空已缓存的条目', async () => {
  let runs = 0;
  const run = async () => {
    runs += 1;
    return `run-${runs}`;
  };

  const r1 = await shareInFlight('key-reset', 100_000, run);
  assert.equal(r1, 'run-1');
  assert.equal(runs, 1);

  __resetSharedRequestsForTests();

  const r2 = await shareInFlight('key-reset', 100_000, run);
  assert.equal(r2, 'run-2');
  assert.equal(runs, 2);
});

test('run 同步抛出异常时也能够正常 reject 并移除 key', async () => {
  let runs = 0;
  const run = () => {
    runs += 1;
    if (runs === 1) {
      throw new Error('sync throw');
    }
    return Promise.resolve('ok');
  };

  await assert.rejects(
    shareInFlight('key-sync-throw', 1000, run),
    /sync throw/,
  );
  assert.equal(runs, 1);

  const r2 = await shareInFlight('key-sync-throw', 1000, run);
  assert.equal(r2, 'ok');
  assert.equal(runs, 2);
});
