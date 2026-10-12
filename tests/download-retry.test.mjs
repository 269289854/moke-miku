import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRetryableDownloadError,
  runWithDownloadRetry,
} from '../src/lib/download-retry.ts';

test('isRetryableDownloadError 正确识别可重试与不可重试错误', () => {
  // AbortError 绝不重试
  assert.equal(isRetryableDownloadError(new DOMException('aborted', 'AbortError')), false);
  const customAbort = new Error('aborted');
  customAbort.name = 'AbortError';
  assert.equal(isRetryableDownloadError(customAbort), false);

  // TypeError 视为网络底层错误，可重试
  assert.equal(isRetryableDownloadError(new TypeError('Failed to fetch')), true);

  // 消息匹配
  assert.equal(isRetryableDownloadError(new Error('book.download.transfer_failed')), true);
  assert.equal(isRetryableDownloadError(new Error('book.download.stalled')), true);
  assert.equal(isRetryableDownloadError(new Error('book.download.incomplete')), true);
  assert.equal(isRetryableDownloadError(new Error('network.timeout')), true);

  // code 属性匹配
  assert.equal(isRetryableDownloadError({ code: 'book.download.transfer_failed' }), true);
  assert.equal(isRetryableDownloadError({ code: 'book.download.stalled' }), true);
  assert.equal(isRetryableDownloadError({ code: 'book.download.incomplete' }), true);
  assert.equal(isRetryableDownloadError({ code: 'network.timeout' }), true);

  // HTTP 状态码错误
  assert.equal(isRetryableDownloadError(new Error('http.408')), true);
  assert.equal(isRetryableDownloadError(new Error('http.429')), true);
  assert.equal(isRetryableDownloadError(new Error('http.500')), true);
  assert.equal(isRetryableDownloadError(new Error('http.502')), true);
  assert.equal(isRetryableDownloadError(new Error('http.503')), true);
  assert.equal(isRetryableDownloadError(new Error('http.524')), true);
  assert.equal(isRetryableDownloadError({ code: 'http.503' }), true);

  // 不可重试错误
  assert.equal(isRetryableDownloadError(new Error('book.download.storage_failed')), false);
  assert.equal(isRetryableDownloadError(new Error('book.epub.invalid')), false);
  assert.equal(isRetryableDownloadError(new Error('http.404')), false);
  assert.equal(isRetryableDownloadError(new Error('random error')), false);
  assert.equal(isRetryableDownloadError(null), false);
  assert.equal(isRetryableDownloadError(undefined), false);
});

test('可重试错误按 delaysMs 重试直到成功', async () => {
  let attempts = 0;
  const recordedDelays = [];
  const retries = [];

  const result = await runWithDownloadRetry(
    async (attemptIndex) => {
      attempts += 1;
      if (attemptIndex < 2) {
        throw new Error('book.download.stalled');
      }
      return 'downloaded';
    },
    {
      maxAttempts: 5,
      delaysMs: [1000, 2000, 3000, 4000],
      sleep: async (ms) => {
        recordedDelays.push(ms);
      },
      onRetry: (attemptIndex, error, delayMs) => {
        retries.push({ attemptIndex, message: error.message, delayMs });
      },
    },
  );

  assert.equal(result, 'downloaded');
  assert.equal(attempts, 3);
  assert.deepEqual(recordedDelays, [1000, 2000]);
  assert.deepEqual(retries, [
    { attemptIndex: 0, message: 'book.download.stalled', delayMs: 1000 },
    { attemptIndex: 1, message: 'book.download.stalled', delayMs: 2000 },
  ]);
});

test('达到 maxAttempts 后抛出最后一次错误，且超出 delaysMs 长度时复用最后一个延迟', async () => {
  let attempts = 0;
  const recordedDelays = [];

  await assert.rejects(
    () => runWithDownloadRetry(
      async (attemptIndex) => {
        attempts += 1;
        throw new Error(`book.download.incomplete-${attemptIndex}`);
      },
      {
        maxAttempts: 4,
        delaysMs: [100, 200], // 只有两个元素，第 3 次重试应复用 200
        isRetryable: () => true,
        sleep: async (ms) => {
          recordedDelays.push(ms);
        },
      },
    ),
    (error) => error instanceof Error && error.message === 'book.download.incomplete-3',
  );

  assert.equal(attempts, 4);
  assert.deepEqual(recordedDelays, [100, 200, 200]);
});

test('不可重试错误不重试，直接抛出', async () => {
  let attempts = 0;
  const recordedDelays = [];

  await assert.rejects(
    () => runWithDownloadRetry(
      async () => {
        attempts += 1;
        throw new Error('book.download.storage_failed');
      },
      {
        maxAttempts: 5,
        sleep: async (ms) => recordedDelays.push(ms),
      },
    ),
    (error) => error instanceof Error && error.message === 'book.download.storage_failed',
  );

  assert.equal(attempts, 1);
  assert.equal(recordedDelays.length, 0);
});

test('AbortError 绝不重试，原样抛出', async () => {
  let attempts = 0;
  const recordedDelays = [];

  await assert.rejects(
    () => runWithDownloadRetry(
      async () => {
        attempts += 1;
        throw new DOMException('paused', 'AbortError');
      },
      {
        maxAttempts: 5,
        sleep: async (ms) => recordedDelays.push(ms),
      },
    ),
    (error) => error.name === 'AbortError',
  );

  assert.equal(attempts, 1);
  assert.equal(recordedDelays.length, 0);
});

test('调用方信号已中止时不再发起重试', async () => {
  const controller = new AbortController();
  let attempts = 0;

  await assert.rejects(
    () => runWithDownloadRetry(
      async () => {
        attempts += 1;
        controller.abort();
        throw new Error('book.download.stalled');
      },
      {
        signal: controller.signal,
        maxAttempts: 5,
        sleep: async () => {},
      },
    ),
    (error) => error.message === 'book.download.stalled',
  );

  assert.equal(attempts, 1);
});

test('等待 sleep 期间 signal 中止会 reject AbortError', async () => {
  const controller = new AbortController();
  let attempts = 0;

  await assert.rejects(
    () => runWithDownloadRetry(
      async () => {
        attempts += 1;
        throw new Error('book.download.stalled');
      },
      {
        signal: controller.signal,
        maxAttempts: 3,
        sleep: async (_ms, signal) => {
          controller.abort();
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
        },
      },
    ),
    (error) => error.name === 'AbortError',
  );

  assert.equal(attempts, 1);
});

test('每次重试前都调用 waitForNetwork', async () => {
  let attempts = 0;
  const networkChecks = [];
  const recordedDelays = [];

  const result = await runWithDownloadRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('network.timeout');
      }
      return 'ok';
    },
    {
      maxAttempts: 4,
      delaysMs: [50, 50],
      sleep: async (ms) => recordedDelays.push(ms),
      waitForNetwork: async (signal) => {
        networkChecks.push(Boolean(signal));
      },
    },
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.equal(networkChecks.length, 2);
  assert.equal(recordedDelays.length, 2);
});

test('waitForNetwork 期间 signal 中止会中断并抛出 AbortError', async () => {
  const controller = new AbortController();
  let attempts = 0;

  await assert.rejects(
    () => runWithDownloadRetry(
      async () => {
        attempts += 1;
        throw new Error('book.download.stalled');
      },
      {
        signal: controller.signal,
        maxAttempts: 3,
        waitForNetwork: async (signal) => {
          controller.abort();
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
        },
        sleep: async () => {},
      },
    ),
    (error) => error.name === 'AbortError',
  );

  assert.equal(attempts, 1);
});
