import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  notifyStaleContent,
  __resetStaleNoticeForTests,
  STALE_CONTENT_MESSAGE,
  STALE_NOTICE_INTERVAL_MS,
} from '../src/lib/stale-notice.ts';

beforeEach(() => {
  __resetStaleNoticeForTests();
});

test('首次调用触发 show 且返回 true', () => {
  const calls = [];
  const result = notifyStaleContent((msg) => calls.push(msg), 1_000_000);
  assert.equal(result, true);
  assert.deepEqual(calls, [STALE_CONTENT_MESSAGE]);
});

test('59_999ms 内再次调用不触发', () => {
  const calls = [];
  const show = (msg) => calls.push(msg);

  const baseTime = 1_000_000;
  assert.equal(notifyStaleContent(show, baseTime), true);
  assert.equal(calls.length, 1);

  const secondResult = notifyStaleContent(show, baseTime + STALE_NOTICE_INTERVAL_MS - 1);
  assert.equal(secondResult, false);
  assert.equal(calls.length, 1);
});

test('60_000ms 后再次触发', () => {
  const calls = [];
  const show = (msg) => calls.push(msg);

  const baseTime = 1_000_000;
  assert.equal(notifyStaleContent(show, baseTime), true);
  assert.equal(calls.length, 1);

  const secondResult = notifyStaleContent(show, baseTime + STALE_NOTICE_INTERVAL_MS);
  assert.equal(secondResult, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [STALE_CONTENT_MESSAGE, STALE_CONTENT_MESSAGE]);
});

test('重置测试状态后可立即再次触发', () => {
  const calls = [];
  const show = (msg) => calls.push(msg);

  const baseTime = 1_000_000;
  assert.equal(notifyStaleContent(show, baseTime), true);
  assert.equal(calls.length, 1);

  __resetStaleNoticeForTests();

  assert.equal(notifyStaleContent(show, baseTime + 100), true);
  assert.equal(calls.length, 2);
});

test('未提供 now 时默认使用当前时间', () => {
  const calls = [];
  const result = notifyStaleContent((msg) => calls.push(msg));
  assert.equal(result, true);
  assert.deepEqual(calls, [STALE_CONTENT_MESSAGE]);
});
