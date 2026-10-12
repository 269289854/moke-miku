import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  cachedRequest,
  clearMokeCache,
  getMokeCacheStats,
  invalidateMokeCacheTags,
  isStaleFallbackStatus,
  readMokeCacheState,
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

test('过期旧数据在预算耗尽后先返回 stale 正文，后台完成后触发 onBackgroundUpdate 且写入新鲜缓存', async () => {
  let now = 10_000;
  Date.now = () => now;

  let transportCalls = 0;
  let resolveNetwork;
  const transport = async () => {
    transportCalls++;
    if (transportCalls === 1) {
      return new Response('initial-data');
    }
    await new Promise((resolve) => { resolveNetwork = resolve; });
    return new Response('updated-data', {
      headers: { 'content-type': 'text/plain' },
    });
  };

  const url = 'https://books.test/api/budget-test';
  const testPolicy = policy({ ttlMs: 100, staleMs: 10_000 });

  // 1. 首次请求填充缓存
  const initRes = await cachedRequest(url, testPolicy, transport);
  assert.equal(await initRes.text(), 'initial-data');
  assert.equal(transportCalls, 1);

  // 2. 推进时间，使缓存过期但仍在 stale 窗口内
  now += 150;

  // 3. 第二次请求携带 revalidateBudgetMs: 20，网络挂起
  let backgroundCalls = 0;
  let backgroundResponseText = '';
  let backgroundResponseState = null;

  const resPromise = cachedRequest(url, testPolicy, transport, {
    revalidateBudgetMs: 20,
    onBackgroundUpdate: async (response) => {
      backgroundCalls++;
      backgroundResponseState = readMokeCacheState(response);
      backgroundResponseText = await response.text();
    },
  });

  const res = await resPromise;
  assert.equal(readMokeCacheState(res), 'stale');
  assert.equal(await res.text(), 'initial-data');
  assert.equal(transportCalls, 2);
  assert.equal(backgroundCalls, 0);

  // 4. 放行网络
  resolveNetwork();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(backgroundCalls, 1);
  assert.equal(backgroundResponseText, 'updated-data');
  assert.equal(backgroundResponseState, 'network');

  // 5. 随后请求应为新鲜命中，不访问网络
  const thirdRes = await cachedRequest(url, testPolicy, transport);
  assert.equal(readMokeCacheState(thirdRes), 'fresh');
  assert.equal(await thirdRes.text(), 'updated-data');
  assert.equal(transportCalls, 2);
});

test('弱网降级状态下立即返回 stale 旧数据，忽略大预算', async () => {
  let now = 10_000;
  Date.now = () => now;

  let transportCalls = 0;
  let resolveNetwork;
  const transport = async () => {
    transportCalls++;
    if (transportCalls === 1) return new Response('v1');
    await new Promise((resolve) => { resolveNetwork = resolve; });
    return new Response('v2');
  };

  const url = 'https://books.test/api/degraded-test';
  const testPolicy = policy({ ttlMs: 100, staleMs: 10_000 });

  await cachedRequest(url, testPolicy, transport);
  now += 150;

  const res = await cachedRequest(url, testPolicy, transport, {
    revalidateBudgetMs: 10_000,
    getNetworkQuality: () => 'degraded',
  });

  assert.equal(readMokeCacheState(res), 'stale');
  assert.equal(await res.text(), 'v1');
  assert.equal(transportCalls, 2);

  resolveNetwork();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test('后台阶段网络返回 304 不触发 onBackgroundUpdate，且刷新新鲜期', async () => {
  let now = 10_000;
  Date.now = () => now;

  let transportCalls = 0;
  let resolveNetwork;
  const transport = async () => {
    transportCalls++;
    if (transportCalls === 1) {
      return new Response('body-v1', { headers: { etag: '"etag-1"' } });
    }
    await new Promise((resolve) => { resolveNetwork = resolve; });
    return new Response(null, { status: 304, headers: { etag: '"etag-1"' } });
  };

  const url = 'https://books.test/api/304-background-test';
  const testPolicy = policy({ ttlMs: 100, staleMs: 10_000 });

  await cachedRequest(url, testPolicy, transport);
  now += 150;

  let backgroundCalls = 0;
  const res = await cachedRequest(url, testPolicy, transport, {
    revalidateBudgetMs: 20,
    onBackgroundUpdate: () => {
      backgroundCalls++;
    },
  });

  assert.equal(readMokeCacheState(res), 'stale');
  assert.equal(await res.text(), 'body-v1');

  resolveNetwork();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(backgroundCalls, 0);

  const freshRes = await cachedRequest(url, testPolicy, transport);
  assert.equal(readMokeCacheState(freshRes), 'fresh');
  assert.equal(await freshRes.text(), 'body-v1');
  assert.equal(transportCalls, 2);
});

test('网络返回 503 时在有旧数据时回退 stale，无旧数据时返回 503 原响应', async () => {
  let now = 10_000;
  Date.now = () => now;

  const urlWithCache = 'https://books.test/api/503-with-cache';
  const urlNoCache = 'https://books.test/api/503-no-cache';
  const testPolicy = policy({ ttlMs: 100, staleMs: 10_000 });

  await cachedRequest(urlWithCache, testPolicy, async () => new Response('cached-good'));
  now += 150;

  const resFallback = await cachedRequest(urlWithCache, testPolicy, async () =>
    new Response('service unavailable', { status: 503 }),
  );
  assert.equal(readMokeCacheState(resFallback), 'stale');
  assert.equal(await resFallback.text(), 'cached-good');

  const resNoCache = await cachedRequest(urlNoCache, testPolicy, async () =>
    new Response('service unavailable', { status: 503 }),
  );
  assert.equal(readMokeCacheState(resNoCache), 'network');
  assert.equal(resNoCache.status, 503);
  assert.equal(await resNoCache.text(), 'service unavailable');
});

test('shouldStore 返回 false 时本次返回响应但不写入缓存，下一次仍访问网络', async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return new Response(JSON.stringify({ err: 'user.need_login' }));
  };

  const url = 'https://books.test/api/need-login';
  const shouldStore = async (res) => {
    const data = await res.json();
    return data.err === 'ok';
  };

  const firstRes = await cachedRequest(url, policy(), transport, { shouldStore });
  assert.equal(readMokeCacheState(firstRes), 'network');
  assert.deepEqual(await firstRes.json(), { err: 'user.need_login' });
  assert.equal(calls, 1);

  const secondRes = await cachedRequest(url, policy(), transport, { shouldStore });
  assert.equal(readMokeCacheState(secondRes), 'network');
  assert.deepEqual(await secondRes.json(), { err: 'user.need_login' });
  assert.equal(calls, 2);
});

test('单个调用方中止会中止 transport；合并调用方中仅一个中止不会影响另一个', async () => {
  const urlSingle = 'https://books.test/api/cancel-single';
  let singleTransportSignal;
  const singleController = new AbortController();

  const singlePromise = cachedRequest(
    urlSingle,
    policy(),
    async (_, signal) => {
      singleTransportSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response('single-res');
    },
    { signal: singleController.signal },
  );

  await new Promise((resolve) => setImmediate(resolve));
  singleController.abort();

  await assert.rejects(singlePromise, { name: 'AbortError' });
  assert.equal(singleTransportSignal.aborted, true);

  const urlMerged = 'https://books.test/api/cancel-merged';
  let mergedTransportSignal;
  let resolveMerged;
  const caller1Controller = new AbortController();

  const caller1 = cachedRequest(
    urlMerged,
    policy(),
    async (_, signal) => {
      mergedTransportSignal = signal;
      await new Promise((resolve) => { resolveMerged = resolve; });
      return new Response('merged-ok');
    },
    { signal: caller1Controller.signal },
  );
  const caller2 = cachedRequest(
    urlMerged,
    policy(),
    async () => new Response('unreachable'),
  );

  await new Promise((resolve) => setImmediate(resolve));
  caller1Controller.abort();

  await assert.rejects(caller1, { name: 'AbortError' });
  assert.equal(mergedTransportSignal.aborted, false);

  resolveMerged();
  const caller2Res = await caller2;
  assert.equal(await caller2Res.text(), 'merged-ok');
});

test('后台模式期间新加入的调用方立即拿到旧数据，并收到后台更新回调', async () => {
  let now = 10_000;
  Date.now = () => now;

  let calls = 0;
  let resolveNetwork;
  const transport = async () => {
    calls++;
    if (calls === 1) return new Response('v1');
    await new Promise((resolve) => { resolveNetwork = resolve; });
    return new Response('v2');
  };

  const url = 'https://books.test/api/join-background';
  const testPolicy = policy({ ttlMs: 100, staleMs: 10_000 });

  await cachedRequest(url, testPolicy, transport);
  now += 150;

  let firstUpdateText = '';
  let secondUpdateText = '';

  const firstRes = await cachedRequest(url, testPolicy, transport, {
    revalidateBudgetMs: 20,
    onBackgroundUpdate: async (res) => {
      firstUpdateText = await res.text();
    },
  });

  assert.equal(readMokeCacheState(firstRes), 'stale');
  assert.equal(await firstRes.text(), 'v1');

  const secondRes = await cachedRequest(url, testPolicy, transport, {
    onBackgroundUpdate: async (res) => {
      secondUpdateText = await res.text();
    },
  });

  assert.equal(readMokeCacheState(secondRes), 'stale');
  assert.equal(await secondRes.text(), 'v1');

  resolveNetwork();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(firstUpdateText, 'v2');
  assert.equal(secondUpdateText, 'v2');
});

test('状态头正确标记 fresh/network/revalidated，且持久缓存副本不含 x-moke-cache-state', async () => {
  let now = 10_000;
  Date.now = () => now;

  let calls = 0;
  const transport = async () => {
    calls++;
    if (calls === 1) {
      return new Response('content-1', { headers: { etag: '"v1"' } });
    }
    return new Response(null, { status: 304, headers: { etag: '"v1"' } });
  };

  const url = 'https://books.test/api/state-headers';
  const testPolicy = policy({ ttlMs: 100, staleMs: 10_000 });

  const netRes = await cachedRequest(url, testPolicy, transport);
  assert.equal(readMokeCacheState(netRes), 'network');

  const stored = await cache.match((await cache.keys())[0]);
  assert.equal(stored.headers.get('x-moke-cache-state'), null);

  const freshRes = await cachedRequest(url, testPolicy, transport);
  assert.equal(readMokeCacheState(freshRes), 'fresh');

  now += 150;
  const revalidatedRes = await cachedRequest(url, testPolicy, transport);
  assert.equal(readMokeCacheState(revalidatedRes), 'revalidated');

  const storedAfter304 = await cache.match((await cache.keys())[0]);
  assert.equal(storedAfter304.headers.get('x-moke-cache-state'), null);
});

test('isStaleFallbackStatus 正确识别全部可恢复状态码', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]) {
    assert.equal(isStaleFallbackStatus(status), true, `status ${status} should be fallback`);
  }
  for (const status of [200, 201, 304, 400, 401, 403, 404, 501, 528, 529]) {
    assert.equal(isStaleFallbackStatus(status), false, `status ${status} should not be fallback`);
  }
});

test('唯一调用方中止后（transport 仍挂起），立刻对同一 URL 发起新请求应触发新 transport 并成功', async () => {
  let calls = 0;
  let firstTransportSignal;
  let secondResolve;

  const transport = async (_, signal) => {
    calls++;
    if (calls === 1) {
      firstTransportSignal = signal;
      // 挂起不返回，模拟慢请求
      await new Promise(() => {});
    }
    await new Promise((resolve) => { secondResolve = resolve; });
    return new Response('replacement-success');
  };

  const url = 'https://books.test/api/abort-race-test';
  const controller = new AbortController();

  const firstPromise = cachedRequest(
    url,
    policy(),
    transport,
    { signal: controller.signal },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  // 1. 中止唯一调用方
  controller.abort();
  await assert.rejects(firstPromise, { name: 'AbortError' });
  assert.equal(firstTransportSignal.aborted, true);

  // 2. 此时第一个 transport 仍然挂起未完成/未抛出，立刻对同一 URL 发起新请求
  const secondPromise = cachedRequest(
    url,
    policy(),
    transport,
  );

  await new Promise((resolve) => setImmediate(resolve));
  // 必须触发了第二次 transport 调用，而不是复用第一个被中止的 entry
  assert.equal(calls, 2);

  secondResolve();
  const secondRes = await secondPromise;
  assert.equal(await secondRes.text(), 'replacement-success');
});

test('删除 globalThis.caches 后写入 205 个不同键，条目数 <= 200，淘汰最早写入项，保留最近访问项', async () => {
  delete globalThis.caches;

  const networkCounts = new Map();
  const makeTransport = (id) => async () => {
    networkCounts.set(id, (networkCounts.get(id) || 0) + 1);
    return new Response(JSON.stringify({ id, text: `item-${id}` }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  const urlFor = (id) => `https://books.test/api/items/${id}`;

  // 1. 写入前 50 个不同键 (1..50)
  for (let i = 1; i <= 50; i++) {
    await cachedRequest(urlFor(i), policy(), makeTransport(i));
  }

  // 2. 访问键 1，将其移至 LRU 末尾（最近使用）
  const res1 = await cachedRequest(urlFor(1), policy(), makeTransport(1));
  assert.equal(await (await res1).json().then((d) => d.id), 1);
  assert.equal(networkCounts.get(1), 1, '键 1 命中内存缓存，未访问网络');

  // 3. 继续写入 51..205，总计 205 个不同键
  for (let i = 51; i <= 205; i++) {
    await cachedRequest(urlFor(i), policy(), makeTransport(i));
  }

  // 4. 验证内存条目数 <= 200 (此处达到上限 200)
  const stats = await getMokeCacheStats();
  assert.ok(stats.entries <= 200, `entries 应 <= 200，实际为 ${stats.entries}`);
  assert.equal(stats.entries, 200);

  // 5. 最早写入且未被重新访问的键（如键 2）已被淘汰，再次请求时访问网络
  assert.equal(networkCounts.get(2), 1);
  await cachedRequest(urlFor(2), policy(), makeTransport(2));
  assert.equal(networkCounts.get(2), 2, '键 2 被淘汰后重新请求应访问网络');

  // 6. 早期写入但在后续被访问过的键 1 保留在缓存中，再次请求不访问网络
  await cachedRequest(urlFor(1), policy(), makeTransport(1));
  assert.equal(networkCounts.get(1), 1, '键 1 仍保留在内存缓存中，未访问网络');
});

test('内存缓存字节上限：总字节超过 24MB 时淘汰最旧响应', async () => {
  delete globalThis.caches;

  const networkCounts = new Map();
  // 构造 10MB 正文
  const payload10MB = 'x'.repeat(10 * 1024 * 1024);

  const makeTransport = (id) => async () => {
    networkCounts.set(id, (networkCounts.get(id) || 0) + 1);
    return new Response(payload10MB, {
      headers: { 'content-type': 'text/plain' },
    });
  };

  const url1 = 'https://books.test/api/big/1';
  const url2 = 'https://books.test/api/big/2';
  const url3 = 'https://books.test/api/big/3';

  // 1. 写入第 1 个 10MB 响应 (总字节 ~10MB <= 24MB)
  await cachedRequest(url1, policy(), makeTransport(1));
  assert.equal(networkCounts.get(1), 1);

  // 2. 写入第 2 个 10MB 响应 (总字节 ~20MB <= 24MB)
  await cachedRequest(url2, policy(), makeTransport(2));
  assert.equal(networkCounts.get(2), 1);

  let stats = await getMokeCacheStats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.totalBytes, 20 * 1024 * 1024);

  // 3. 写入第 3 个 10MB 响应 (总字节达 30MB > 24MB，淘汰最旧的 url1，余 20MB <= 24MB)
  await cachedRequest(url3, policy(), makeTransport(3));
  assert.equal(networkCounts.get(3), 1);

  stats = await getMokeCacheStats();
  assert.ok(stats.totalBytes <= 24 * 1024 * 1024, `totalBytes 应 <= 24MB，实际为 ${stats.totalBytes}`);
  assert.equal(stats.entries, 2);
  assert.equal(stats.totalBytes, 20 * 1024 * 1024);

  // 4. 较新的 url2 与 url3 仍保留在缓存中，请求不访问网络
  await cachedRequest(url2, policy(), makeTransport(2));
  assert.equal(networkCounts.get(2), 1, 'url2 保留在缓存中，不访问网络');
  await cachedRequest(url3, policy(), makeTransport(3));
  assert.equal(networkCounts.get(3), 1, 'url3 保留在缓存中，不访问网络');

  // 5. 最旧的 url1 已被淘汰，重新请求时访问网络（再次写入会按 LRU 淘汰 url2）
  await cachedRequest(url1, policy(), makeTransport(1));
  assert.equal(networkCounts.get(1), 2, 'url1 被淘汰后重新请求应访问网络');
});

test('touch 节流：新鲜命中且 accessed 距今不足 15 分钟时，cache.put 调用次数不增加', async () => {
  let now = 10_000;
  Date.now = () => now;

  let putCount = 0;
  const originalPut = cache.put.bind(cache);
  cache.put = async (input, response) => {
    putCount++;
    return originalPut(input, response);
  };

  const url = 'https://books.test/api/touch-throttle-test';
  // 有效期 30 分钟 (30 * 60 * 1000)
  const testPolicy = policy({ ttlMs: 30 * 60 * 1000 });

  // 1. 首次请求：网络获取并写入缓存，此时 cache.put 应被调用 1 次
  await cachedRequest(url, testPolicy, async () => new Response('initial-data'));
  assert.equal(putCount, 1);

  // 2. 5 分钟后发起第二次请求（依然处于新鲜期，且距上次 accessed 仅 5 分钟 < 15 分钟）
  now += 5 * 60 * 1000;
  const secondRes = await cachedRequest(url, testPolicy, async () => new Response('unreachable'));
  assert.equal(readMokeCacheState(secondRes), 'fresh');
  assert.equal(await secondRes.text(), 'initial-data');

  // 等待可能触发的微任务/异步操作执行完毕
  await new Promise((resolve) => setTimeout(resolve, 30));
  // putCount 不应增加，仍为 1
  assert.equal(putCount, 1, '5 分钟内新鲜命中不应触发 touchResponse / cache.put');

  // 3. 距最初访问经过 16 分钟（总计 16 分钟 >= 15 分钟），且仍在 30 分钟新鲜期内
  now += 11 * 60 * 1000;
  const thirdRes = await cachedRequest(url, testPolicy, async () => new Response('unreachable'));
  assert.equal(readMokeCacheState(thirdRes), 'fresh');
  assert.equal(await thirdRes.text(), 'initial-data');

  // 等待 touchResponse 完成写盘
  await new Promise((resolve) => setTimeout(resolve, 30));
  // putCount 应增加为 2
  assert.equal(putCount, 2, '超过 15 分钟的新鲜命中应触发 touchResponse / cache.put');

  // 4. 紧接着再请求一次（距上次 touch < 15 分钟），putCount 不应增加
  now += 1_000;
  const fourthRes = await cachedRequest(url, testPolicy, async () => new Response('unreachable'));
  assert.equal(readMokeCacheState(fourthRes), 'fresh');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(putCount, 2, '刚 touch 后的新鲜命中不应再次触发 cache.put');
});

test('限额检查 scheduleCacheLimitEnforcement 尾部节流，写入后不立即触发全量扫描', async () => {
  let keysCalls = 0;
  const originalKeys = cache.keys.bind(cache);
  cache.keys = async () => {
    keysCalls++;
    return originalKeys();
  };

  const url1 = 'https://books.test/api/throttle-limit/1';
  const url2 = 'https://books.test/api/throttle-limit/2';

  // 连续发起两次写入，触发两次 scheduleCacheLimitEnforcement('cache')
  await cachedRequest(url1, policy(), async () => new Response('data-1'));
  await cachedRequest(url2, policy(), async () => new Response('data-2'));

  // 写入后立即检查：因为 10 秒尾部节流，enforceCacheLimit 不应立即扫描 keys
  assert.equal(keysCalls, 0, '限额检查已节流，写入后不应立即执行 keys 扫描');
});



