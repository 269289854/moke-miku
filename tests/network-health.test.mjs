import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetNetworkHealthForTests,
  getNetworkQuality,
  reportNetworkFailure,
  reportNetworkSuccess,
  subscribeNetworkRecovery,
  waitForNetworkRecovery,
} from '../src/lib/network-health.ts';

test.beforeEach(() => {
  __resetNetworkHealthForTests();
});

test('初始为 good；连续 1 次失败仍 good；连续 2 次失败为 degraded', () => {
  let currentTime = 10_000;
  __resetNetworkHealthForTests({ now: () => currentTime, online: () => true });

  assert.equal(getNetworkQuality(), 'good');

  reportNetworkFailure('error');
  assert.equal(getNetworkQuality(), 'good');

  reportNetworkFailure('timeout');
  assert.equal(getNetworkQuality(), 'degraded');
});

test('degraded 后时钟前进 30_001ms → good；再失败 1 次（计数已为 3）→ degraded', () => {
  let currentTime = 10_000;
  __resetNetworkHealthForTests({ now: () => currentTime, online: () => true });

  reportNetworkFailure('error');
  reportNetworkFailure('timeout');
  assert.equal(getNetworkQuality(), 'degraded');

  currentTime += 30_001;
  assert.equal(getNetworkQuality(), 'good');

  reportNetworkFailure('gateway');
  assert.equal(getNetworkQuality(), 'degraded');
});

test('成功后清零为 good，并且在之前为 degraded 时恰好通知一次恢复监听器；之前为 good 时不通知', () => {
  let currentTime = 10_000;
  __resetNetworkHealthForTests({ now: () => currentTime, online: () => true });

  let notifications = 0;
  subscribeNetworkRecovery(() => {
    notifications += 1;
  });

  reportNetworkSuccess();
  assert.equal(notifications, 0);
  assert.equal(getNetworkQuality(), 'good');

  reportNetworkFailure('error');
  reportNetworkFailure('error');
  assert.equal(getNetworkQuality(), 'degraded');

  reportNetworkSuccess();
  assert.equal(notifications, 1);
  assert.equal(getNetworkQuality(), 'good');
});

test('online 函数返回 false → offline；此时 reportNetworkSuccess 会通知恢复（之前非 good）', () => {
  let isOnline = false;
  __resetNetworkHealthForTests({ now: () => 10_000, online: () => isOnline });

  let notifications = 0;
  subscribeNetworkRecovery(() => {
    notifications += 1;
  });

  assert.equal(getNetworkQuality(), 'offline');

  reportNetworkSuccess();
  assert.equal(notifications, 1);
  assert.equal(getNetworkQuality(), 'offline');

  isOnline = true;
  assert.equal(getNetworkQuality(), 'good');
});

test('取消订阅后不再收到通知；某个监听器抛异常不影响其他监听器', () => {
  __resetNetworkHealthForTests({ now: () => 10_000, online: () => true });

  let firstCalls = 0;
  let secondCalls = 0;
  let thirdCalls = 0;

  const unsubscribeFirst = subscribeNetworkRecovery(() => {
    firstCalls += 1;
  });

  subscribeNetworkRecovery(() => {
    secondCalls += 1;
    throw new Error('listener failure');
  });

  subscribeNetworkRecovery(() => {
    thirdCalls += 1;
  });

  reportNetworkFailure('error');
  reportNetworkFailure('error');
  reportNetworkSuccess();

  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  assert.equal(thirdCalls, 1);

  unsubscribeFirst();

  reportNetworkFailure('error');
  reportNetworkFailure('error');
  reportNetworkSuccess();

  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 2);
  assert.equal(thirdCalls, 2);
});

test('waitForNetworkRecovery：good 时立即完成', async () => {
  __resetNetworkHealthForTests({ now: () => 10_000, online: () => true });
  assert.equal(getNetworkQuality(), 'good');

  let resolved = false;
  await waitForNetworkRecovery().then(() => {
    resolved = true;
  });
  assert.equal(resolved, true);
});

test('waitForNetworkRecovery：degraded 时在 reportNetworkSuccess 后完成', async () => {
  __resetNetworkHealthForTests({ now: () => 10_000, online: () => true });
  reportNetworkFailure('error');
  reportNetworkFailure('error');
  assert.equal(getNetworkQuality(), 'degraded');

  let resolved = false;
  const promise = waitForNetworkRecovery().then(() => {
    resolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolved, false);

  reportNetworkSuccess();
  await promise;
  assert.equal(resolved, true);
});

test('waitForNetworkRecovery：maxWaitMs 到期完成', async () => {
  __resetNetworkHealthForTests({ now: () => 10_000, online: () => true });
  reportNetworkFailure('error');
  reportNetworkFailure('error');
  assert.equal(getNetworkQuality(), 'degraded');

  const start = Date.now();
  await waitForNetworkRecovery(undefined, 20);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 15);
  assert.equal(getNetworkQuality(), 'degraded');
});

test('waitForNetworkRecovery：signal 在等待中中止时 reject 且 error.name === "AbortError"', async () => {
  __resetNetworkHealthForTests({ now: () => 10_000, online: () => true });
  reportNetworkFailure('error');
  reportNetworkFailure('error');

  const controller = new AbortController();
  const promise = waitForNetworkRecovery(controller.signal);

  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    },
  );
});

test('waitForNetworkRecovery：signal 已预先中止时立即 reject 且 error.name === "AbortError"', async () => {
  __resetNetworkHealthForTests({ now: () => 10_000, online: () => true });
  reportNetworkFailure('error');
  reportNetworkFailure('error');

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    waitForNetworkRecovery(controller.signal),
    (error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    },
  );
});
