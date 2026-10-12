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

export type MokeCacheState = 'fresh' | 'stale' | 'revalidated' | 'network';
export type MokeNetworkQuality = 'good' | 'degraded' | 'offline';

export interface CachedRequestOptions {
  dedupe?: boolean;                 // 默认 true；false 时不加入共享请求（保留现有语义）
  signal?: AbortSignal | null;      // 调用方自己的取消信号
  revalidateBudgetMs?: number;      // 不传 = 一直等网络（旧行为）；传数字 = 有可用旧数据时最多等这么久
  onBackgroundUpdate?: (response: Response) => void;
  shouldStore?: (response: Response) => boolean | Promise<boolean>;
  getNetworkQuality?: () => MokeNetworkQuality;   // 不传视为 'good'
}

const CACHE_NAME = 'moke-cache-v1';
const KEY_PREFIX = 'https://moke-cache.invalid/v2/';
const FALLBACK_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const DESKTOP_LIMIT = 512 * 1024 * 1024;
const MOBILE_LIMIT = 128 * 1024 * 1024;
export const MEMORY_MAX_ENTRIES = 200;
export const MEMORY_MAX_BYTES = 24 * 1024 * 1024;
export const TOUCH_INTERVAL_MS = 15 * 60 * 1000;
export const LIMIT_ENFORCE_DELAY_MS = 10_000;

const memoryCache = new Map<string, Response>();
const memoryBackends = new Map<string, 'native' | 'cache' | 'memory'>();
let memoryTotalBytes = 0;
let nativeLimitTimer: ReturnType<typeof setTimeout> | null = null;
let cacheLimitTimer: ReturnType<typeof setTimeout> | null = null;

function getResponseSize(response: Response): number {
  const raw = response.headers?.get('x-moke-cache-size');
  const size = raw ? Number(raw) : 0;
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function memoryDelete(key: string): boolean {
  const existing = memoryCache.get(key);
  if (!existing) return false;
  memoryTotalBytes -= getResponseSize(existing);
  if (memoryTotalBytes < 0) memoryTotalBytes = 0;
  memoryCache.delete(key);
  memoryBackends.delete(key);
  return true;
}

function memoryGet(key: string): Response | undefined {
  const response = memoryCache.get(key);
  if (!response) return undefined;
  const backend = memoryBackends.get(key) || 'memory';
  memoryCache.delete(key);
  memoryCache.set(key, response);
  memoryBackends.delete(key);
  memoryBackends.set(key, backend);
  return response;
}

function memorySet(
  key: string,
  response: Response,
  backend: 'native' | 'cache' | 'memory',
): void {
  const existing = memoryCache.get(key);
  if (existing) {
    memoryTotalBytes -= getResponseSize(existing);
    if (memoryTotalBytes < 0) memoryTotalBytes = 0;
    memoryCache.delete(key);
    memoryBackends.delete(key);
  }

  const size = getResponseSize(response);
  memoryCache.set(key, response);
  memoryBackends.set(key, backend);
  memoryTotalBytes += size;

  while (memoryCache.size > MEMORY_MAX_ENTRIES || memoryTotalBytes > MEMORY_MAX_BYTES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    memoryDelete(oldestKey);
  }
}


interface ForegroundResult {
  response: Response;
  state: MokeCacheState;
}

interface SharedRequestEntry {
  key: string;
  controller: AbortController;
  foregroundPromise: Promise<ForegroundResult>;
  resolveForeground: (result: ForegroundResult) => void;
  rejectForeground: (error: unknown) => void;
  foregroundWaiters: number;
  isBackground: boolean;
  backgroundListeners: Set<(response: Response) => void>;
  staleResponse: Response | null;
  staleUntil: number;
  requestedBudgetMs?: number;
  budgetTimer: ReturnType<typeof setTimeout> | null;
  budgetAt?: number;
  networkDone: boolean;
  shouldStore?: (response: Response) => boolean | Promise<boolean>;
  enterBackground: () => void;
}

const inFlightRequests = new Map<string, SharedRequestEntry>();
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
    memoryDelete(key);
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
          memoryDelete(key);
        }
      }
    } while (nativeTrimRequested);
  })().finally(() => {
    nativeTrimPromise = null;
  });
  return nativeTrimPromise;
}

export function scheduleCacheLimitEnforcement(backend: 'native' | 'cache'): void {
  if (backend === 'native') {
    if (nativeLimitTimer) {
      clearTimeout(nativeLimitTimer);
      nativeLimitTimer = null;
    }
    const timer = setTimeout(async () => {
      nativeLimitTimer = null;
      try {
        await enforceNativeCacheLimit();
      } catch {}
    }, LIMIT_ENFORCE_DELAY_MS);
    timer.unref?.();
    nativeLimitTimer = timer;
  } else {
    if (cacheLimitTimer) {
      clearTimeout(cacheLimitTimer);
      cacheLimitTimer = null;
    }
    const timer = setTimeout(async () => {
      cacheLimitTimer = null;
      try {
        const cache = await openCache();
        if (cache) {
          await enforceCacheLimit(cache);
        }
      } catch {}
    }, LIMIT_ENFORCE_DELAY_MS);
    timer.unref?.();
    cacheLimitTimer = timer;
  }
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
        scheduleCacheLimitEnforcement('native');
      }
    }
    const cache = await openCache();
    if (backend !== 'native' && cache) {
      await cache.put(key, stored.clone());
      backend = 'cache';
      scheduleCacheLimitEnforcement('cache');
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
    memorySet(key, stored.clone(), backend);
  } catch {
    // Cache failure must never break the network request.
  }
}

interface CacheMatch {
  response: Response;
  backend: 'native' | 'cache' | 'memory';
}

async function matchResponse(key: string): Promise<CacheMatch | null> {
  const memory = memoryGet(key);
  if (memory) {
    return { response: memory.clone(), backend: memoryBackends.get(key) || 'memory' };
  }
  if (isNativeCacheEnabled()) {
    const { matchNativeCacheResponse } = await import('@/lib/moke-native-cache');
    const response = await matchNativeCacheResponse(key);
    if (response) {
      memorySet(key, response.clone(), 'native');
      return { response, backend: 'native' };
    }
  }
  const cache = await openCache();
  if (cache) {
    try {
      const response = await cache.match(key);
      if (response) {
        memorySet(key, response.clone(), 'cache');
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
    memorySet(key, touched, match.backend);
  } catch {}
}

export function readMokeCacheState(response: Response): MokeCacheState | null {
  const value = response?.headers?.get?.('x-moke-cache-state');
  if (value === 'fresh' || value === 'stale' || value === 'revalidated' || value === 'network') {
    return value;
  }
  return null;
}

export function isStaleFallbackStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status >= 520 && status <= 527) ||
    status === 530
  );
}

function buildResponseWithState(response: Response, state: MokeCacheState): Response {
  const copy = response.clone();
  const headers = new Headers(copy.headers);
  headers.set('x-moke-cache-state', state);
  const isNullBody = copy.status === 101 || copy.status === 204 || copy.status === 205 || copy.status === 304;
  return new Response(isNullBody ? null : copy.body, {
    status: copy.status,
    statusText: copy.statusText,
    headers,
  });
}

async function drainResponseBodyQuietly(response: Response): Promise<void> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return;
    while (!(await reader.read()).done) {
      // discard
    }
  } catch {
    // Disposal errors must not mask the cache fallback.
  }
}

function createSharedRequestEntry(key: string): SharedRequestEntry {
  const controller = new AbortController();
  let resolveForeground!: (result: ForegroundResult) => void;
  let rejectForeground!: (error: unknown) => void;
  const foregroundPromise = new Promise<ForegroundResult>((resolve, reject) => {
    resolveForeground = resolve;
    rejectForeground = reject;
  });
  foregroundPromise.catch(() => {});

  const entry: SharedRequestEntry = {
    key,
    controller,
    foregroundPromise,
    resolveForeground,
    rejectForeground,
    foregroundWaiters: 0,
    isBackground: false,
    backgroundListeners: new Set(),
    staleResponse: null,
    staleUntil: 0,
    requestedBudgetMs: undefined,
    budgetTimer: null,
    networkDone: false,
    enterBackground: () => {
      if (entry.isBackground || entry.networkDone || !entry.staleResponse) return;
      entry.isBackground = true;
      if (entry.budgetTimer) {
        clearTimeout(entry.budgetTimer);
        entry.budgetTimer = null;
      }
      entry.resolveForeground({
        response: entry.staleResponse.clone(),
        state: 'stale',
      });
    },
  };

  return entry;
}

function scheduleBudget(entry: SharedRequestEntry, budgetMs: number): void {
  if (entry.isBackground || entry.networkDone || !entry.staleResponse) return;
  if (budgetMs <= 0) {
    entry.enterBackground();
    return;
  }
  const triggerAt = Date.now() + budgetMs;
  if (entry.budgetTimer && entry.budgetAt !== undefined && entry.budgetAt <= triggerAt) {
    return;
  }
  if (entry.budgetTimer) {
    clearTimeout(entry.budgetTimer);
    entry.budgetTimer = null;
  }
  entry.budgetAt = triggerAt;
  entry.budgetTimer = setTimeout(() => {
    entry.budgetTimer = null;
    entry.enterBackground();
  }, budgetMs);
}

function requestBudgetOnEntry(
  entry: SharedRequestEntry,
  revalidateBudgetMs: number,
  getNetworkQuality?: () => MokeNetworkQuality,
): void {
  if (entry.isBackground || entry.networkDone) return;
  const quality = getNetworkQuality ? getNetworkQuality() : 'good';
  const budgetMs = quality === 'good' ? revalidateBudgetMs : 0;
  if (entry.requestedBudgetMs === undefined || budgetMs < entry.requestedBudgetMs) {
    entry.requestedBudgetMs = budgetMs;
  }
  if (entry.staleResponse) {
    scheduleBudget(entry, budgetMs);
  }
}

function joinSharedRequest(
  entry: SharedRequestEntry,
  options: CachedRequestOptions,
): Promise<Response> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }

  if (entry.isBackground && entry.staleResponse) {
    if (options.onBackgroundUpdate) {
      entry.backgroundListeners.add(options.onBackgroundUpdate);
    }
    return Promise.resolve(buildResponseWithState(entry.staleResponse, 'stale'));
  }

  if (options.onBackgroundUpdate) {
    entry.backgroundListeners.add(options.onBackgroundUpdate);
  }

  if (options.revalidateBudgetMs !== undefined) {
    requestBudgetOnEntry(entry, options.revalidateBudgetMs, options.getNetworkQuality);
  }

  if (entry.isBackground && entry.staleResponse) {
    return Promise.resolve(buildResponseWithState(entry.staleResponse, 'stale'));
  }

  entry.foregroundWaiters++;

  const signal = options.signal;
  if (!signal) {
    return entry.foregroundPromise.then(({ response, state }) =>
      buildResponseWithState(response, state),
    );
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      entry.foregroundWaiters--;
      if (entry.foregroundWaiters === 0 && !entry.isBackground && !entry.networkDone) {
        if (entry.budgetTimer) {
          clearTimeout(entry.budgetTimer);
          entry.budgetTimer = null;
        }
        if (inFlightRequests.get(entry.key) === entry) {
          inFlightRequests.delete(entry.key);
        }
        entry.controller.abort();
      }
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    entry.foregroundPromise.then(
      ({ response, state }) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(buildResponseWithState(response, state));
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

async function executeNetwork(
  key: string,
  policy: MokeCachePolicy,
  transport: (headers: Headers, signal: AbortSignal) => Promise<Response>,
  entry: SharedRequestEntry,
  dedupe: boolean,
  cached: Response | null,
  options: CachedRequestOptions,
  requestEpoch: number,
): Promise<void> {
  const conditionalHeaders = new Headers();
  const etag = cached?.headers.get('etag');
  const lastModified = cached?.headers.get('last-modified');
  if (etag) conditionalHeaders.set('If-None-Match', etag);
  if (lastModified) conditionalHeaders.set('If-Modified-Since', lastModified);

  try {
    const response = await transport(conditionalHeaders, entry.controller.signal);

    if (response.status === 304 && cached) {
      if (requestEpoch !== cacheEpoch) {
        throw new DOMException('Cache scope changed.', 'AbortError');
      }
      await putResponse(key, cached.clone(), policy, requestEpoch);
      if (!entry.isBackground) {
        entry.resolveForeground({ response: cached.clone(), state: 'revalidated' });
      }
      return;
    }

    const now = Date.now();
    const hasStale = requestEpoch === cacheEpoch && Boolean(cached && entry.staleUntil > now);
    if (isStaleFallbackStatus(response.status) && hasStale && entry.staleResponse) {
      await drainResponseBodyQuietly(response);
      if (!entry.isBackground) {
        entry.resolveForeground({ response: entry.staleResponse.clone(), state: 'stale' });
      }
      return;
    }

    if (response.ok) {
      let allowStore = true;
      const shouldStoreFn = entry.shouldStore || options.shouldStore;
      if (shouldStoreFn) {
        try {
          allowStore = await shouldStoreFn(response.clone());
        } catch {
          allowStore = true;
        }
      }
      if (allowStore) {
        await putResponse(key, response.clone(), policy, requestEpoch);
      }
      if (!entry.isBackground) {
        entry.resolveForeground({ response: response.clone(), state: 'network' });
      } else {
        if (response.status === 200 && allowStore && requestEpoch === cacheEpoch) {
          for (const listener of entry.backgroundListeners) {
            try {
              listener(buildResponseWithState(response, 'network'));
            } catch {}
          }
        }
      }
      return;
    }

    if (!entry.isBackground) {
      entry.resolveForeground({ response: response.clone(), state: 'network' });
    }
  } catch (error) {
    const now = Date.now();
    const hasStale = requestEpoch === cacheEpoch && Boolean(cached && entry.staleUntil > now);
    if (hasStale && entry.staleResponse) {
      if (!entry.isBackground) {
        entry.resolveForeground({ response: entry.staleResponse.clone(), state: 'stale' });
      }
      return;
    }
    if (!entry.isBackground) {
      entry.rejectForeground(error);
    }
  } finally {
    entry.networkDone = true;
    if (entry.budgetTimer) {
      clearTimeout(entry.budgetTimer);
      entry.budgetTimer = null;
    }
    if (dedupe && inFlightRequests.get(key) === entry) {
      inFlightRequests.delete(key);
    }
  }
}

export function cachedRequest(
  requestUrl: string,
  policy: MokeCachePolicy,
  transport: (headers: Headers, signal: AbortSignal) => Promise<Response>,
  options: CachedRequestOptions = {},
): Promise<Response> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }

  const key = cacheUrl(policy, requestUrl);
  const dedupe = options.dedupe !== false;

  if (dedupe) {
    const existing = inFlightRequests.get(key);
    if (existing) {
      return joinSharedRequest(existing, options);
    }
  }

  const entry = createSharedRequestEntry(key);
  entry.shouldStore = options.shouldStore;
  if (dedupe) {
    inFlightRequests.set(key, entry);
  }

  const resultPromise = joinSharedRequest(entry, options);

  (async () => {
    const requestEpoch = cacheEpoch;
    let match: CacheMatch | null = null;
    try {
      match = await matchResponse(key);
    } catch {
      match = null;
    }

    const cached = match?.response || null;
    const now = Date.now();
    const expiresAt = Number(cached?.headers.get('x-moke-cache-expires') || 0);
    const staleUntil = Number(cached?.headers.get('x-moke-cache-stale-until') || 0);

    if (cached && expiresAt > now) {
      const rawAccessed = cached.headers.get('x-moke-cache-accessed');
      const accessedAt = rawAccessed ? Number(rawAccessed) : 0;
      if (match && (!Number.isFinite(accessedAt) || accessedAt <= 0 || now - accessedAt >= TOUCH_INTERVAL_MS)) {
        void touchResponse(key, match);
      }
      entry.resolveForeground({ response: cached, state: 'fresh' });
      entry.networkDone = true;
      if (dedupe && inFlightRequests.get(key) === entry) {
        inFlightRequests.delete(key);
      }
      return;
    }

    const hasStale = Boolean(cached && staleUntil > now);
    entry.staleResponse = hasStale && cached ? cached.clone() : null;
    entry.staleUntil = staleUntil;

    if (hasStale && entry.requestedBudgetMs !== undefined) {
      scheduleBudget(entry, entry.requestedBudgetMs);
    }

    await executeNetwork(key, policy, transport, entry, dedupe, cached, options, requestEpoch);
  })().catch((err) => {
    if (!entry.isBackground && !entry.networkDone) {
      entry.rejectForeground(err);
    }
    entry.networkDone = true;
    if (entry.budgetTimer) {
      clearTimeout(entry.budgetTimer);
      entry.budgetTimer = null;
    }
    if (dedupe && inFlightRequests.get(key) === entry) {
      inFlightRequests.delete(key);
    }
  });

  return resultPromise;
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
  if (nativeLimitTimer) {
    clearTimeout(nativeLimitTimer);
    nativeLimitTimer = null;
  }
  if (cacheLimitTimer) {
    clearTimeout(cacheLimitTimer);
    cacheLimitTimer = null;
  }
  let clearError: unknown = null;
  for (const [key, response] of [...memoryCache.entries()]) {
    if (!kind || response.headers.get('x-moke-cache-kind') === kind) {
      memoryDelete(key);
    }
  }
  if (!kind) {
    memoryTotalBytes = 0;
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
  for (const [key, response] of [...memoryCache.entries()]) {
    if (response.headers.get('x-moke-cache-kind') !== 'api') continue;
    const entryTags = (response.headers.get('x-moke-cache-tags') || '').split(',');
    if (entryTags.some((tag) => wanted.has(tag))) {
      memoryDelete(key);
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
        memoryDelete(request.url);
      }
    }
  } catch {}
}

export async function clearCurrentAccountMokeCache(scopeOverride?: string): Promise<void> {
  cacheEpoch++;
  // New account requests must not join a refresh from the previous session.
  inFlightRequests.clear();
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
  for (const [key, response] of [...memoryCache.entries()]) {
    const tags = (response.headers.get('x-moke-cache-tags') || '').split(',');
    if (tags.includes(marker)) {
      memoryDelete(key);
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
