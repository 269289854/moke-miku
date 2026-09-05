import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMokeAccountCacheScope,
  buildMokeSourceIdentity,
  normalizeOnlineFormat,
  readerCacheLimitForPlatform,
  selectPreferredBookFormat,
} from '../src/lib/moke-book-source.ts';

test('远程与本地来源共享不含凭据的稳定书籍标识', () => {
  const first = buildMokeSourceIdentity({
    serverUrl: 'HTTPS://Books.Example.test/',
    account: 'reader@example.test',
    bookId: '42',
    format: 'EPUB',
  });
  const second = buildMokeSourceIdentity({
    serverUrl: 'https://books.example.test',
    account: 'reader@example.test',
    bookId: '42',
    format: 'epub',
  });

  assert.deepEqual(first, second);
  assert.match(first.identity, /^moke[0-9a-f]{16}$/);
  assert.doesNotMatch(first.identity, /-/);
  assert.doesNotMatch(first.identity + first.cacheScope, /reader|example|42/i);
});

test('账户、书号和格式分别隔离来源标识', () => {
  const base = { serverUrl: 'https://books.test', account: 'a', bookId: '1', format: 'epub' };
  const identity = buildMokeSourceIdentity(base).identity;
  assert.notEqual(buildMokeSourceIdentity({ ...base, account: 'b' }).identity, identity);
  assert.notEqual(buildMokeSourceIdentity({ ...base, bookId: '2' }).identity, identity);
  assert.notEqual(buildMokeSourceIdentity({ ...base, format: 'pdf' }).identity, identity);
});

test('账户缓存作用域与来源标识使用同一稳定计算', () => {
  const input = {
    serverUrl: 'https://books.test/',
    account: 'reader',
    bookId: '42',
    format: 'epub',
  };
  assert.equal(
    buildMokeAccountCacheScope(input),
    buildMokeSourceIdentity(input).cacheScope,
  );
  assert.match(buildMokeAccountCacheScope(input), /^[0-9a-f]{16}$/);
});

test('在线格式与平台容量遵循首轮约束', () => {
  assert.equal(normalizeOnlineFormat(' EPUB '), 'epub');
  assert.equal(normalizeOnlineFormat('pdf'), 'pdf');
  assert.equal(normalizeOnlineFormat('txt'), null);
  assert.equal(readerCacheLimitForPlatform('android'), 384 * 1024 * 1024);
  assert.equal(readerCacheLimitForPlatform('ios'), 384 * 1024 * 1024);
  assert.equal(readerCacheLimitForPlatform('ohos'), 384 * 1024 * 1024);
  assert.equal(readerCacheLimitForPlatform('windows'), 1536 * 1024 * 1024);
});

test('multi-format books prefer online-readable EPUB and PDF formats', () => {
  assert.equal(
    selectPreferredBookFormat([{ format: 'TXT' }, { format: ' EPUB ' }]),
    'epub',
  );
  assert.equal(
    selectPreferredBookFormat([{ format: 'mobi' }, { format: 'PDF' }]),
    'pdf',
  );
  assert.equal(selectPreferredBookFormat([{ format: 'TXT' }]), 'txt');
  assert.equal(selectPreferredBookFormat([]), null);
});
