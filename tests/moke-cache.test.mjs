import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  cachedRequest,
  clearMokeCache,
  getMokeCacheStats,
  invalidateMokeCacheTags,
  selectMokeLruEvictions,
} from '../src/lib/moke-cache.ts';

class MemoryCache {
  entries = new Map();

  key(input) {
    return typeof input === 'string' ? input : input.url;
  }

  async match(input) {
    return this.entries.get(this.key(input))?.clone();
  }

  async put(input, response) {
    this.entries.set(this.key(input), response.clone());
  }

  async delete(input) {
    return this.entries.delete(this.key(input));
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

let cache;
let originalCaches;
let originalNow;

const policy = (overrides = {}) => ({
  kind: 'api',
  scope: 'server-a\naccount-a',
  ttlMs: 1_000,
  staleMs: 7_000,
  tags: ['account', 'library'],
  ...overrides,
});

beforeEach(async () => {
  originalCaches = globalThis.caches;
  originalNow = Date.now;
  cache = new MemoryCache();
  globalThis.caches = { open: async () => cache };
  await clearMokeCache();
});

afterEach(() => {
  Date.now = originalNow;
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
});

test('相同缓存键的并发请求只访问网络一次，随后命中新鲜缓存', async () => {
  let resolveTransport;
  let calls = 0;
  const transport = async () => {
    calls++;
    await new Promise((resolve) => { resolveTransport = resolve; });
    return new Response(JSON.stringify({ value: 42 }), {
      headers: { 'content-type': 'application/json', etag: '"v1"' },
    });
  };

  const first = cachedRequest('https://books.test/api/library', policy(), transport);
  const second = cachedRequest('https://books.test/api/library', policy(), transport);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  resolveTransport();

  assert.deepEqual(await (await first).json(), { value: 42 });
  assert.deepEqual(await (await second).json(), { value: 42 });
  assert.deepEqual(
    await (await cachedRequest('https://books.test/api/library', policy(), transport)).json(),
    { value: 42 },
  );
  assert.equal(calls, 1);
});

test('可取消调用可绕过并发合并，前一请求取消不会拖累替代请求', async () => {
  let rejectFirst;
  let resolveSecond;
  let calls = 0;
  const url = 'https://books.test/api/library?start=0&size=30';

  const first = cachedRequest(
    url,
    policy(),
    async () => {
      calls++;
      await new Promise((_, reject) => { rejectFirst = reject; });
      return new Response('unreachable');
    },
    { dedupe: false },
  );
  const second = cachedRequest(
    url,
    policy(),
    async () => {
      calls++;
      await new Promise((resolve) => { resolveSecond = resolve; });
      return new Response('replacement');
    },
    { dedupe: false },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  rejectFirst(new DOMException('The operation was aborted.', 'AbortError'));
  resolveSecond();

  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(await (await second).text(), 'replacement');
});

test('过期条目使用 ETag 条件验证，304 后继续返回缓存正文', async () => {
  let now = 1_000;
  Date.now = () => now;
  const seenHeaders = [];
  let calls = 0;
  const transport = async (headers) => {
    seenHeaders.push(new Headers(headers));
    calls++;
    if (calls === 1) {
      return new Response('cached-body', { headers: { etag: '"book-v1"' } });
    }
    return new Response(null, { status: 304, headers: { etag: '"book-v1"' } });
  };

  assert.equal(
    await (await cachedRequest('https://books.test/api/book/1', policy({ ttlMs: 100 }), transport)).text(),
    'cached-body',
  );
  now += 101;
  assert.equal(
    await (await cachedRequest('https://books.test/api/book/1', policy({ ttlMs: 100 }), transport)).text(),
    'cached-body',
  );
  assert.equal(seenHeaders[1].get('if-none-match'), '"book-v1"');
});

test('网络失败时最多在 stale 窗口内回退旧数据', async () => {
  let now = 2_000;
  Date.now = () => now;
  let fail = false;
  const transport = async () => {
    if (fail) throw new Error('offline');
    return new Response('offline-copy');
  };
  const cachePolicy = policy({ ttlMs: 100, staleMs: 1_000 });

  await cachedRequest('https://books.test/api/shelf', cachePolicy, transport);
  now += 101;
  fail = true;
  assert.equal(
    await (await cachedRequest('https://books.test/api/shelf', cachePolicy, transport)).text(),
    'offline-copy',
  );
  now += 1_000;
  await assert.rejects(
    () => cachedRequest('https://books.test/api/shelf', cachePolicy, transport),
    /offline/,
  );
});

test('HTTP 错误响应不写入缓存，用户重试会重新访问网络', async () => {
  let calls = 0;
  const url = 'https://books.test/api/library?start=30&size=30';
  const transport = async () => {
    calls++;
    if (calls === 1) return new Response('temporary failure', { status: 500 });
    return new Response('recovered');
  };

  assert.equal((await cachedRequest(url, policy(), transport)).status, 500);
  assert.equal(await (await cachedRequest(url, policy(), transport)).text(), 'recovered');
  assert.equal(calls, 2);
});

test('标签失效同时清理内存副本，即使 Cache Storage 暂时不可用', async () => {
  let calls = 0;
  const transport = async () => new Response(String(++calls));
  const url = 'https://books.test/api/library?page=1';

  assert.equal(await (await cachedRequest(url, policy(), transport)).text(), '1');
  delete globalThis.caches;
  await invalidateMokeCacheTags('server-a\naccount-a', ['library']);
  assert.equal(await (await cachedRequest(url, policy(), transport)).text(), '2');
});

test('缓存统计区分 API 与图片，按类型清理不会误删另一类', async () => {
  await cachedRequest('https://books.test/api/library', policy(), async () => new Response('api'));
  await cachedRequest(
    'https://books.test/cover.jpg',
    policy({ kind: 'image', tags: ['account'] }),
    async () => new Response('image'),
  );

  assert.deepEqual(await getMokeCacheStats(), {
    apiBytes: 3,
    imageBytes: 5,
    totalBytes: 8,
    entries: 2,
  });
  await clearMokeCache('image');
  assert.deepEqual(await getMokeCacheStats(), {
    apiBytes: 3,
    imageBytes: 0,
    totalBytes: 3,
    entries: 1,
  });
});

test('Cache Storage 不可用时仍统计并清理内存后备', async () => {
  delete globalThis.caches;
  await cachedRequest('https://books.test/api/library', policy(), async () => new Response('api'));

  assert.deepEqual(await getMokeCacheStats(), {
    apiBytes: 3,
    imageBytes: 0,
    totalBytes: 3,
    entries: 1,
  });
  await clearMokeCache();
  assert.deepEqual(await getMokeCacheStats(), {
    apiBytes: 0,
    imageBytes: 0,
    totalBytes: 0,
    entries: 0,
  });
});

test('持久缓存清理失败时不会向界面误报成功', async () => {
  globalThis.caches = {
    open: async () => {
      throw new Error('cache-open-failed');
    },
  };

  await assert.rejects(() => clearMokeCache(), /cache-open-failed/);
});

test('持久化响应仅保留内容验证所需头，不保存 Cookie 或鉴权头', async () => {
  await cachedRequest(
    'https://books.test/api/library',
    policy(),
    async () => new Response('api', {
      headers: {
        'content-type': 'application/json',
        etag: '"v1"',
        'last-modified': 'Tue, 01 Sep 2026 00:00:00 GMT',
        'set-cookie': 'session=secret',
        authorization: 'Bearer secret',
        'x-private-token': 'secret',
      },
    }),
  );

  const stored = await cache.match((await cache.keys())[0]);
  assert.equal(stored.headers.get('content-type'), 'application/json');
  assert.equal(stored.headers.get('etag'), '"v1"');
  assert.equal(stored.headers.get('last-modified'), 'Tue, 01 Sep 2026 00:00:00 GMT');
  assert.equal(stored.headers.get('set-cookie'), null);
  assert.equal(stored.headers.get('authorization'), null);
  assert.equal(stored.headers.get('x-private-token'), null);
});

test('清理期间完成的旧网络请求不会把响应重新写回缓存', async () => {
  let resolveTransport;
  let calls = 0;
  const transport = async () => {
    calls++;
    await new Promise((resolve) => { resolveTransport = resolve; });
    return new Response(`response-${calls}`);
  };

  const first = cachedRequest('https://books.test/api/library', policy(), transport);
  await new Promise((resolve) => setImmediate(resolve));
  await clearMokeCache();
  resolveTransport();
  assert.equal(await (await first).text(), 'response-1');

  const second = cachedRequest(
    'https://books.test/api/library',
    policy(),
    async () => new Response(`response-${++calls}`),
  );
  assert.equal(await (await second).text(), 'response-2');
  assert.equal(calls, 2);
});

test('LRU 只在超过 110% 时触发，并清理到不高于 90%', () => {
  const entries = [
    { key: 'oldest', size: 30, accessedAt: 1 },
    { key: 'middle', size: 30, accessedAt: 2 },
    { key: 'newest', size: 60, accessedAt: 3 },
  ];
  assert.deepEqual(selectMokeLruEvictions(entries, 110, 100), []);
  assert.deepEqual(selectMokeLruEvictions(entries, 120, 100), ['oldest']);
});
