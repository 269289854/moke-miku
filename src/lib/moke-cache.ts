'use client';

export type MokeCacheKind = 'api' | 'image';

export interface MokeCachePolicy {
  kind: MokeCacheKind;
  scope: string;
  ttlMs: number;
  staleMs?: number;
  tags?: string[];
}

export interface MokeCacheStats {
  apiBytes: number;
  imageBytes: number;
  totalBytes: number;
  entries: number;
}

const CACHE_NAME = 'moke-cache-v1';
const KEY_PREFIX = 'https://moke-cache.invalid/v2/';
const FALLBACK_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const DESKTOP_LIMIT = 512 * 1024 * 1024;
const MOBILE_LIMIT = 128 * 1024 * 1024;
const memoryCache = new Map<string, Response>();
const memoryBackends = new Map<string, 'native' | 'cache' | 'memory'>();
const pendingRequests = new Map<string, Promise<Response>>();
let limitPromise: Promise<number> | null = null;
let nativeTrimPromise: Promise<void> | null = null;
let nativeTrimRequested = false;
let cacheEpoch = 0;

export interface MokeLruEntry {
  key: string;
  size: number;
  accessedAt: number;
}

export function selectMokeLruEvictions(
  entries: MokeLruEntry[],
  totalBytes: number,
  limitBytes: number,
): string[] {
  if (totalBytes <= Math.floor(limitBytes * 1.1)) return [];
  const ordered = [...entries].sort((left, right) => left.accessedAt - right.accessedAt);
  const target = Math.floor(limitBytes * 0.9);
  const evictions: string[] = [];
  let remaining = totalBytes;
  for (const entry of ordered) {
    if (remaining <= target) break;
    evictions.push(entry.key);
    remaining -= entry.size;
  }
  return evictions;
}

function fnv1a(value: string, seed = 2166136261): string {
  let hash = seed >>> 0;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function opaqueId(value: string): string {
  return fnv1a(value, 0x811c9dc5) + fnv1a(value, 0x9e3779b9);
}

function cacheUrl(policy: MokeCachePolicy, requestUrl: string): string {
  return KEY_PREFIX + policy.kind + '/' + opaqueId(policy.scope + '\n' + requestUrl);
}

function scopedTag(scope: string, tag: string): string {
  return fnv1a(`${scope}\n${tag}`, 0x811c9dc5);
}

async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined' || typeof Response === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function buildStoredResponse(response: Response, policy: MokeCachePolicy): Promise<Response> {
  const copy = response.clone();
  const body = await copy.arrayBuffer();
  const now = Date.now();
  const headers = new Headers();
  for (const name of ['content-type', 'etag', 'last-modified']) {
    const value = copy.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('content-length', String(body.byteLength));
  headers.set('x-moke-cache-kind', policy.kind);
  headers.set('x-moke-cache-created', String(now));
  headers.set('x-moke-cache-accessed', String(now));
  headers.set('x-moke-cache-expires', String(now + policy.ttlMs));
  headers.set('x-moke-cache-stale-until', String(now + (policy.staleMs ?? FALLBACK_STALE_MS)));
  headers.set('x-moke-cache-size', String(body.byteLength));
  if (policy.tags?.length) {
    headers.set('x-moke-cache-tags', policy.tags.map((tag) => scopedTag(policy.scope, tag)).join(','));
  }
  return new Response(body, { status: copy.status, statusText: copy.statusText, headers });
}

async function getCacheLimit(): Promise<number> {
  if (limitPromise) return limitPromise;
  limitPromise = (async () => {
    if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return DESKTOP_LIMIT;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const platform = await invoke<string>('moke_runtime_platform');
      return ['android', 'ios', 'ohos'].includes(platform) ? MOBILE_LIMIT : DESKTOP_LIMIT;
    } catch {
      return MOBILE_LIMIT;
    }
  })();
  return limitPromise;
}

async function enforceCacheLimit(cache: Cache): Promise<void> {
  const limit = await getCacheLimit();
  const requests = new Map<string, Request>();
  const entries: MokeLruEntry[] = [];
  let total = 0;
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (!response) continue;
    const size = Number(response.headers.get('x-moke-cache-size') || 0);
    if (!Number.isFinite(size) || size < 0) continue;
    total += size;
    requests.set(request.url, request);
    entries.push({ key: request.url, size, accessedAt: Number(response.headers.get('x-moke-cache-accessed') || 0) });
  }
  for (const key of selectMokeLruEvictions(entries, total, limit)) {
    const request = requests.get(key);
    if (request) await cache.delete(request);
    memoryCache.delete(key);
    memoryBackends.delete(key);
  }
}

function isNativeCacheEnabled(): boolean {
  return process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';
}

async function enforceNativeCacheLimit(): Promise<void> {
  if (nativeTrimPromise) {
    nativeTrimRequested = true;
    return nativeTrimPromise;
  }
  nativeTrimPromise = (async () => {
    const { deleteNativeCacheKeys, getNativeCacheEntries } = await import(
      '@/lib/moke-native-cache'
    );
    do {
      nativeTrimRequested = false;
      const entries = await getNativeCacheEntries();
      if (!entries) return;
      const total = entries.reduce((sum, entry) => sum + entry.size, 0);
      const evictions = selectMokeLruEvictions(entries, total, await getCacheLimit());
      if (evictions.length > 0) {
        await deleteNativeCacheKeys(evictions);
        for (const key of evictions) {
          memoryCache.delete(key);
          memoryBackends.delete(key);
        }
      }
    } while (nativeTrimRequested);
  })().finally(() => {
    nativeTrimPromise = null;
  });
  return nativeTrimPromise;
}

async function putResponse(
  key: string,
  response: Response,
  policy: MokeCachePolicy,
  expectedEpoch = cacheEpoch,
): Promise<void> {
  if (!response.ok || expectedEpoch !== cacheEpoch) return;
  try {
    const stored = await buildStoredResponse(response, policy);
    if (expectedEpoch !== cacheEpoch) return;
    let backend: 'native' | 'cache' | 'memory' = 'memory';
    if (isNativeCacheEnabled()) {
      const { putNativeCacheResponse } = await import('@/lib/moke-native-cache');
      if (expectedEpoch !== cacheEpoch) return;
      if (await putNativeCacheResponse(key, stored.clone())) {
        backend = 'native';
        void enforceNativeCacheLimit().catch(() => undefined);
      }
    }
    const cache = await openCache();
    if (backend !== 'native' && cache) {
      await cache.put(key, stored.clone());
      backend = 'cache';
      void enforceCacheLimit(cache).catch(() => undefined);
    }
    if (expectedEpoch !== cacheEpoch) {
      if (backend === 'native') {
        const { deleteNativeCacheKeys } = await import('@/lib/moke-native-cache');
        await deleteNativeCacheKeys([key]);
      } else if (backend === 'cache' && cache) {
        await cache.delete(key);
      }
      return;
    }
    memoryCache.set(key, stored.clone());
    memoryBackends.set(key, backend);
  } catch {
    // Cache failure must never break the network request.
  }
}

interface CacheMatch {
  response: Response;
  backend: 'native' | 'cache' | 'memory';
}

async function matchResponse(key: string): Promise<CacheMatch | null> {
  const memory = memoryCache.get(key);
  if (memory) {
    return { response: memory.clone(), backend: memoryBackends.get(key) || 'memory' };
  }
  if (isNativeCacheEnabled()) {
    const { matchNativeCacheResponse } = await import('@/lib/moke-native-cache');
    const response = await matchNativeCacheResponse(key);
    if (response) {
      memoryCache.set(key, response.clone());
      memoryBackends.set(key, 'native');
      return { response, backend: 'native' };
    }
  }
  const cache = await openCache();
  if (cache) {
    try {
      const response = await cache.match(key);
      if (response) {
        memoryCache.set(key, response.clone());
        memoryBackends.set(key, 'cache');
        return { response, backend: 'cache' };
      }
    } catch {}
  }
  return null;
}

async function touchResponse(key: string, match: CacheMatch): Promise<void> {
  try {
    const accessedAt = Date.now();
    const headers = new Headers(match.response.headers);
    headers.set('x-moke-cache-accessed', String(accessedAt));
    const touched = new Response(await match.response.clone().arrayBuffer(), {
      status: match.response.status,
      statusText: match.response.statusText,
      headers,
    });
    if (match.backend === 'native') {
      const { touchNativeCacheResponse } = await import('@/lib/moke-native-cache');
      await touchNativeCacheResponse(key, accessedAt);
    } else if (match.backend === 'cache') {
      const cache = await openCache();
      if (cache) await cache.put(key, touched.clone());
    }
    memoryCache.set(key, touched);
    memoryBackends.set(key, match.backend);
  } catch {}
}

export async function cachedRequest(
  requestUrl: string,
  policy: MokeCachePolicy,
  transport: (headers: Headers) => Promise<Response>,
  options: { dedupe?: boolean } = {},
): Promise<Response> {
  const key = cacheUrl(policy, requestUrl);
  const dedupe = options.dedupe !== false;
  if (dedupe) {
    const existing = pendingRequests.get(key);
    if (existing) return (await existing).clone();
  }

  const work = (async () => {
    const requestEpoch = cacheEpoch;
    const match = await matchResponse(key);
    const cached = match?.response || null;
    const now = Date.now();
    const expiresAt = Number(cached?.headers.get('x-moke-cache-expires') || 0);
    const staleUntil = Number(cached?.headers.get('x-moke-cache-stale-until') || 0);
    if (cached && expiresAt > now) {
      if (match) void touchResponse(key, match);
      return cached;
    }

    const conditionalHeaders = new Headers();
    const etag = cached?.headers.get('etag');
    const lastModified = cached?.headers.get('last-modified');
    if (etag) conditionalHeaders.set('If-None-Match', etag);
    if (lastModified) conditionalHeaders.set('If-Modified-Since', lastModified);
    try {
      const response = await transport(conditionalHeaders);
      if (response.status === 304 && cached) {
        await putResponse(key, cached.clone(), policy, requestEpoch);
        return cached;
      }
      if (response.ok) await putResponse(key, response, policy, requestEpoch);
      return response;
    } catch (error) {
      if (cached && staleUntil > now) return cached;
      throw error;
    }
  })();

  if (!dedupe) return (await work).clone();

  pendingRequests.set(key, work);
  try {
    return (await work).clone();
  } finally {
    if (pendingRequests.get(key) === work) pendingRequests.delete(key);
  }
}

export async function getMokeCacheScope(serverUrl?: string): Promise<string> {
  let configuredServer = serverUrl || '';
  let account = 'anonymous';
  try {
    const { useServerStore } = await import('@/lib/store/server');
    const state = useServerStore.getState();
    configuredServer ||= state.serverUrl;
    account = String(state.user?.id || state.user?.username || state.user?.name || 'anonymous');
  } catch {}
  try {
    configuredServer = new URL(configuredServer).origin;
  } catch {
    configuredServer = configuredServer.replace(/\/+$/, '');
  }
  return configuredServer + '\n' + account;
}

export async function getMokeCacheStats(): Promise<MokeCacheStats> {
  const stats: MokeCacheStats = { apiBytes: 0, imageBytes: 0, totalBytes: 0, entries: 0 };
  const seen = new Set<string>();
  const add = (key: string, response: Response) => {
    if (seen.has(key)) return;
    const size = Number(response.headers.get('x-moke-cache-size') || 0);
    if (!Number.isFinite(size) || size < 0) return;
    const kind = response.headers.get('x-moke-cache-kind');
    seen.add(key);
    stats.entries++;
    stats.totalBytes += size;
    if (kind === 'api') stats.apiBytes += size;
    if (kind === 'image') stats.imageBytes += size;
  };

  if (isNativeCacheEnabled()) {
    const { getNativeCacheEntries } = await import('@/lib/moke-native-cache');
    const entries = await getNativeCacheEntries();
    if (entries) {
      for (const entry of entries) {
        add(
          entry.key,
          new Response(null, {
            headers: {
              'x-moke-cache-kind': entry.kind,
              'x-moke-cache-size': String(entry.size),
            },
          }),
        );
      }
    }
  }
  const cache = await openCache();
  if (cache) {
    try {
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (response) add(request.url, response);
      }
    } catch {}
  }
  for (const [key, response] of memoryCache) add(key, response);
  return stats;
}

export async function clearMokeCache(kind?: MokeCacheKind): Promise<void> {
  cacheEpoch++;
  let clearError: unknown = null;
  for (const [key, response] of memoryCache) {
    if (!kind || response.headers.get('x-moke-cache-kind') === kind) {
      memoryCache.delete(key);
      memoryBackends.delete(key);
    }
  }
  if (isNativeCacheEnabled()) {
    const { clearNativeCache } = await import('@/lib/moke-native-cache');
    if (!(await clearNativeCache(kind))) {
      clearError = new Error('Failed to clear the native HTTP cache');
    }
  }

  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_NAME);
      for (const request of await cache.keys()) {
        if (!kind) {
          await cache.delete(request);
          continue;
        }
        const response = await cache.match(request);
        if (response?.headers.get('x-moke-cache-kind') === kind) await cache.delete(request);
      }
    } catch (error) {
      clearError ??= error;
    }
  }

  if (clearError) throw clearError;
}

export async function invalidateMokeCacheTags(scope: string, tags: string[]): Promise<void> {
  cacheEpoch++;
  const wanted = new Set(tags.map((tag) => scopedTag(scope, tag)));
  if (isNativeCacheEnabled()) {
    const { deleteNativeCacheKeys, getNativeCacheEntries } = await import('@/lib/moke-native-cache');
    const entries = await getNativeCacheEntries();
    if (entries) {
      await deleteNativeCacheKeys(
        entries
          .filter((entry) => entry.kind === 'api' && entry.tags.some((tag) => wanted.has(tag)))
          .map((entry) => entry.key),
      );
    }
  }
  for (const [key, response] of memoryCache) {
    if (response.headers.get('x-moke-cache-kind') !== 'api') continue;
    const entryTags = (response.headers.get('x-moke-cache-tags') || '').split(',');
    if (entryTags.some((tag) => wanted.has(tag))) {
      memoryCache.delete(key);
      memoryBackends.delete(key);
    }
  }
  const cache = await openCache();
  if (!cache) return;
  try {
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (!response || response.headers.get('x-moke-cache-kind') !== 'api') continue;
      const entryTags = (response.headers.get('x-moke-cache-tags') || '').split(',');
      if (entryTags.some((tag) => wanted.has(tag))) {
        await cache.delete(request);
        memoryCache.delete(request.url);
        memoryBackends.delete(request.url);
      }
    }
  } catch {}
}

export async function clearCurrentAccountMokeCache(scopeOverride?: string): Promise<void> {
  cacheEpoch++;
  const scope = scopeOverride ?? await getMokeCacheScope();
  const marker = scopedTag(scope, 'account');
  if (isNativeCacheEnabled()) {
    const { deleteNativeCacheKeys, getNativeCacheEntries } = await import('@/lib/moke-native-cache');
    const entries = await getNativeCacheEntries();
    if (entries) {
      await deleteNativeCacheKeys(
        entries.filter((entry) => entry.tags.includes(marker)).map((entry) => entry.key),
      );
    }
  }
  for (const [key, response] of memoryCache) {
    const tags = (response.headers.get('x-moke-cache-tags') || '').split(',');
    if (tags.includes(marker)) {
      memoryCache.delete(key);
      memoryBackends.delete(key);
    }
  }
  const cache = await openCache();
  if (!cache) return;
  try {
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      const tags = (response?.headers.get('x-moke-cache-tags') || '').split(',');
      if (tags.includes(marker)) await cache.delete(request);
    }
  } catch {}
}
