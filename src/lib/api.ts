import type { ServerCapabilities } from '@/lib/store/server';
import { debugLog } from '@/lib/debug-log';
import { getSafeErrorCode, logHttpErrorMetadata } from '@/lib/api-log';
import {
  attachSafeJsonReader,
  buildTauriBinaryHeaders,
  buildTauriRequestInit,
  cancelResponseBodyQuietly,
  createIdleDeadline,
  createRequestDeadline,
  drainResponseBodyQuietly,
  getErrorMessage,
  isAbsoluteHttpUrl,
  isGatewayFailureStatus,
  isRetryableStatus,
  isTauriIpcAvailable,
  MokeApiError,
  readApiJson,
  readJsonResponse,
  resolveAppPlatform,
} from '@/lib/api-core';
import {
  classifyOfflineRangeResponse,
  hasEpubCentralDirectory,
  parseContentRange,
} from '@/lib/offline-book-core';
import {
  readCurrentUserResponse,
  type CurrentUserResult,
  type UserInfoResponse,
} from '@/lib/server-session';
import { discoverGeneralServerCapabilities } from '@/lib/server-capabilities';
import {
  cachedRequest,
  clearCurrentAccountMokeCache,
  getMokeCacheScope,
  invalidateMokeCacheTags,
} from '@/lib/moke-cache';
import {
  getNetworkQuality,
  reportNetworkFailure,
  reportNetworkSuccess,
} from '@/lib/network-health';
import { createTaskQueue } from '@/lib/image-queue';
import { normalizeCoverCacheKey } from '@/lib/cover-url';
import { shareInFlight } from '@/lib/shared-request';
import {
  authenticationFallbackDestination,
  clearDeviceCredential,
  emitAuthenticationRequired,
  loadDeviceCredential,
  type DeviceApiKeyInfo,
} from '@/lib/device-auth';
import {
  isRecoveryContextCurrent,
  responseNeedsSessionRecovery,
  SessionRecoveryCoordinator,
  type SessionRecoveryResult,
} from '@/lib/session-recovery';
export { getErrorMessage, MokeApiError, readApiJson, readJsonResponse } from '@/lib/api-core';

const appPlatform = resolveAppPlatform(process.env.NEXT_PUBLIC_APP_PLATFORM);
const isTauriApp = appPlatform === 'tauri';
const sessionRecoveryCoordinator = new SessionRecoveryCoordinator();

interface RequestDiagnostics {
  expectedStatuses?: readonly number[];
  skipSessionRecovery?: boolean;
  timeoutMs?: number;
  recoveryAttempt?: { attempted: boolean };
}

export interface WelcomeRequirement {
  err: string;
  msg?: string;
  needsAccessCode: boolean;
  passwordLoginApi: boolean;
  deviceApiKeyApi: boolean;
}

export interface DeviceApiKeyResponse {
  err: string;
  msg?: string;
  api_key?: string;
  api_key_info?: DeviceApiKeyInfo;
}

export interface DeviceApiKeyListResponse {
  err: string;
  msg?: string;
  api_keys: DeviceApiKeyInfo[];
}

function isRequestCancelled(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /request cancell?ed|aborted?/i.test(message);
}

function binaryTransferErrorDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function logBinaryTransferFailure(
  url: string,
  response: Response,
  error: unknown,
  receivedBytes: number,
): void {
  debugLog('error', 'download', `✗ GET ${url} 响应正文读取失败`, {
    status: response.status,
    receivedBytes,
    expectedBytes: Number(response.headers.get('content-length') || 0),
    contentRange: response.headers.get('content-range'),
    contentEncoding: response.headers.get('content-encoding'),
    error: binaryTransferErrorDetail(error),
  }, 'network');
}

function logOfflineWriteFailure(error: unknown, receivedBytes: number): void {
  debugLog('error', 'download', '✗ 下载内容写入本地文件失败', {
    receivedBytes,
    error: binaryTransferErrorDetail(error),
  });
}

async function validateDownloadedBook(blob: Blob, format: string): Promise<Blob> {
  if (format.toLowerCase() === 'epub' && !(await hasEpubCentralDirectory(blob))) {
    throw new Error('book.epub.invalid');
  }
  return blob;
}

export async function request(
  url: string | URL,
  options?: RequestInit,
  diagnostics?: RequestDiagnostics,
): Promise<Response> {
  const urlStr = url.toString();
  const method = (options?.method || 'GET').toUpperCase();
  const { useServerStore } = await import('@/lib/store/server');
  const authenticationContext = useServerStore.getState();

  // 关键检测：Tauri 桌面端必须使用绝对 URL（http(s)://...），
  // 否则没有"当前域名"可拼接，会直接网络异常。
  if (!isAbsoluteHttpUrl(urlStr)) {
    debugLog(
      'error',
      'request',
      `Request rejected: ${method} ${urlStr}; missing absolute server URL`,
      'Connection information is unavailable.',
    );
    throw new Error('server.url.missing');
  }

  debugLog('info', 'request', `→ ${method} ${urlStr}`, {
    platform: isTauriApp ? 'tauri' : 'web',
    credentials: options?.credentials,
  });

  const deadline = typeof diagnostics?.timeoutMs === 'number'
    ? createRequestDeadline(options?.signal, diagnostics.timeoutMs)
    : undefined;
  const requestOptions = deadline
    ? { ...(options ?? {}), signal: deadline.signal }
    : options;

  let response: Response;
  const startedAt = Date.now();
  try {
    if (isTauriApp) {
      const internals = typeof window === 'undefined'
        ? undefined
        : (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      if (!isTauriIpcAvailable(internals)) {
        throw new MokeApiError(
          '应用的原生通信组件没有启动。请更新 Android System WebView，完全退出应用后重新打开。',
          'tauri.ipc.unavailable',
        );
      }
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
      // Tauri 桌面端：使用插件 fetch。需要显式放宽以兼容自建 Talebook 服务器：
      // - danger.acceptInvalidCerts: 允许自签名 / 内网 HTTPS 证书
      // - maxRedirections: 跟随登录后的重定向（与浏览器行为一致）
      response = await tauriFetch(urlStr, buildTauriRequestInit(requestOptions) as any);
    } else {
      response = await fetch(url, requestOptions);
    }
    deadline?.clear();
  } catch (e) {
    deadline?.clear();
    const elapsed = Date.now() - startedAt;
    const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);

    if (deadline?.timedOut()) {
      debugLog('error', 'request', `✗ ${method} ${urlStr} 响应超时 (${elapsed}ms)`, errMsg);
      reportNetworkFailure('timeout');
      throw new MokeApiError('服务器响应超时，请检查网络。', 'network.timeout');
    }

    if (isRequestCancelled(e)) {
      debugLog('info', 'request', `⊘ ${method} ${urlStr} 已取消 (${elapsed}ms)`);
      throw e;
    }

    if (!(e instanceof MokeApiError && e.code === 'tauri.ipc.unavailable')) {
      reportNetworkFailure('error');
    }

    debugLog('error', 'request', `✗ ${method} ${urlStr} 网络异常 (${elapsed}ms)`, errMsg);
    // 不在这里弹 toast：页面层各自 catch 后按业务文案提示，
    // 避免网络错误时页面 toast 与这里重复弹出两条。此处只记录日志。
    throw e;
  }

  if (isGatewayFailureStatus(response.status)) {
    reportNetworkFailure('gateway');
  } else {
    reportNetworkSuccess();
  }

  const elapsed = Date.now() - startedAt;
  const expectedStatus = diagnostics?.expectedStatuses?.includes(response.status) === true;
  const level = response.ok ? 'success' : expectedStatus ? 'info' : 'error';
  debugLog(level, 'request', `← ${response.status} ${method} ${urlStr} (${elapsed}ms)`, {
    status: response.status,
    contentType: response.headers.get('content-type'),
  });

  // 历史调用点仍有直接使用 response.json() 的情况。统一改为单次文本读取，
  // 使所有 JSON 入口都不再暴露底层流关闭/解析异常，且可保留纯文本网关原因。
  const readableResponse = attachSafeJsonReader(response);
  if (!diagnostics?.skipSessionRecovery && !diagnostics?.recoveryAttempt?.attempted
      && isRecoveryContextCurrent(authenticationContext, useServerStore.getState())
      && await responseNeedsSessionRecovery(readableResponse, urlStr)) {
    if (diagnostics?.recoveryAttempt) diagnostics.recoveryAttempt.attempted = true;
    const serverOrigin = new URL(urlStr).origin;
    const recovery = await restoreSessionFromStoredApiKey(serverOrigin);
    if (recovery === 'recovered') {
      return request(url, options, { ...diagnostics, skipSessionRecovery: true });
    }
    if (recovery === 'no_key' || recovery === 'invalid') {
      const state = useServerStore.getState();
      if (isRecoveryContextCurrent(authenticationContext, state)
          && state.serverUrl && new URL(state.serverUrl).origin === serverOrigin) {
        await clearCurrentAccountMokeCache(await getMokeCacheScope(urlStr));
        if (isRecoveryContextCurrent(authenticationContext, useServerStore.getState())) {
          emitAuthenticationRequired(authenticationFallbackDestination(Boolean(state.user)));
        }
      }
    }
  }
  return readableResponse;
}

async function performStoredApiKeyRecovery(serverUrl: string): Promise<SessionRecoveryResult> {
  const { useServerStore } = await import('@/lib/store/server');
  const state = useServerStore.getState();
  if (!state.serverUrl || new URL(state.serverUrl).origin !== new URL(serverUrl).origin) return 'unavailable';
  const credential = await loadDeviceCredential(serverUrl);
  if (!isRecoveryContextCurrent(state, useServerStore.getState())) return 'unavailable';
  if (!credential) return 'no_key';
  if (state.user && credential.accountUsername !== state.user.username) return 'no_key';

  try {
    const signInResponse = await request(`${serverUrl}/api/user/api_key/sign_in`, {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${credential.apiKey}` },
    }, { skipSessionRecovery: true });
    const signIn = await readJsonResponse<DeviceApiKeyResponse>(signInResponse);
    if (!isRecoveryContextCurrent(state, useServerStore.getState())) return 'unavailable';
    if (!signInResponse.ok || signIn.err !== 'ok') {
      if (signIn.err === 'api_key.invalid') {
        if ((await loadDeviceCredential(serverUrl)) !== credential
            || !isRecoveryContextCurrent(state, useServerStore.getState())) return 'unavailable';
        await clearDeviceCredential(serverUrl);
        return 'invalid';
      }
      return 'unavailable';
    }

    const userResponse = await request(`${serverUrl}/api/user/info`, {
      credentials: 'include',
    }, { skipSessionRecovery: true });
    const current = await readCurrentUserResponse(userResponse);
    if (!current.isLogin || !current.user) return 'unavailable';

    if (!isRecoveryContextCurrent(state, useServerStore.getState())) return 'unavailable';
    try {
      await clearCurrentAccountMokeCache();
    } catch (error) {
      console.warn('[session-recovery] failed to clear stale account cache:', error);
    }
    if (!isRecoveryContextCurrent(state, useServerStore.getState())) return 'unavailable';
    useServerStore.getState().setConnected('', current.user);
    return 'recovered';
  } catch (error) {
    debugLog('warn', 'session-recovery', '设备密钥恢复会话失败', getErrorMessage(error));
    return 'unavailable';
  }
}

export async function restoreSessionFromStoredApiKey(serverUrl: string): Promise<SessionRecoveryResult> {
  const serverOrigin = new URL(serverUrl).origin;
  return sessionRecoveryCoordinator.run(serverOrigin, () => performStoredApiKeyRecovery(serverOrigin));
}

function delayWithSignal(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
        onAbort = undefined;
      }
    };

    onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

/** Cache a read-only JSON response while keeping all writes and auth endpoints uncached. */
export async function requestCachedJson(
  url: string,
  options: RequestInit | undefined,
  ttlMs: number,
  staleMs = 7 * 24 * 60 * 60 * 1000,
  extra?: {
    onBackgroundUpdate?: (response: Response) => void;
    revalidateBudgetMs?: number;
  },
): Promise<Response> {
  if ((options?.method || 'GET').toUpperCase() !== 'GET') return request(url, options);
  const scope = await getMokeCacheScope(url);
  const parsed = new URL(url);
  const tags = ['account'];
  if (parsed.pathname === '/api/shelf') tags.push('shelf');
  if (parsed.pathname === '/api/library') tags.push('library');
  if (parsed.pathname === '/api/search') tags.push('search');
  const detailMatch = parsed.pathname.match(/^\/api\/book\/([^/]+)$/);
  if (detailMatch?.[1]) tags.push(`book:${detailMatch[1]}`);

  const onBackgroundUpdateWrapped = extra?.onBackgroundUpdate
    ? (response: Response) => {
        try {
          extra.onBackgroundUpdate!(attachSafeJsonReader(response));
        } catch {}
      }
    : undefined;

  const shouldStore = async (response: Response): Promise<boolean> => {
    try {
      const text = await response.clone().text();
      const data = JSON.parse(text);
      if (typeof data === 'object' && data !== null) {
        if (!('err' in data) || (data as { err?: unknown }).err === 'ok') {
          return true;
        }
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };

  const response = await cachedRequest(
    url,
    { kind: 'api', scope, ttlMs, staleMs, tags },
    async (conditionalHeaders, sharedSignal) => {
      const recoveryAttempt = { attempted: false };
      const send = () => {
        const headers = new Headers(options?.headers);
        conditionalHeaders.forEach((value, key) => headers.set(key, value));
        return request(url, { ...options, headers, signal: sharedSignal }, {
          timeoutMs: 20_000,
          recoveryAttempt,
        });
      };

      let firstResponse: Response;
      try {
        firstResponse = await send();
      } catch (e) {
        if (
          !isRequestCancelled(e) &&
          getNetworkQuality() !== 'offline' &&
          !sharedSignal.aborted
        ) {
          const jitterMs = 600 + Math.random() * 300;
          await delayWithSignal(jitterMs, sharedSignal);
          return send();
        }
        throw e;
      }

      if (
        isRetryableStatus(firstResponse.status) &&
        getNetworkQuality() !== 'offline' &&
        !sharedSignal.aborted
      ) {
        // Drain instead of cancel: cancelling a Tauri body can race its eager pull.
        await drainResponseBodyQuietly(firstResponse);
        const jitterMs = 600 + Math.random() * 300;
        await delayWithSignal(jitterMs, sharedSignal);
        return send();
      }

      return firstResponse;
    },
    {
      signal: options?.signal ?? undefined,
      revalidateBudgetMs: extra?.revalidateBudgetMs ?? 1200,
      onBackgroundUpdate: onBackgroundUpdateWrapped,
      shouldStore,
      getNetworkQuality,
    },
  );

  return attachSafeJsonReader(response);
}

const imageTaskQueue = createTaskQueue({ concurrency: 4, order: 'lifo' });

/**
 * 通过带认证的 request 获取图片资源的 Blob。
 * 经由规范化的缓存键缓存、网络质量并发限流的 LIFO 队列请求。
 */
export async function fetchImageBlob(
  imageUrl: string,
  options?: { signal?: AbortSignal | null },
): Promise<Blob> {
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error('image.url.invalid');
  }
  const startedAt = Date.now();
  debugLog('info', 'image', `→ GET ${imageUrl}`);
  try {
    const scope = await getMokeCacheScope();
    const cacheKey = normalizeCoverCacheKey(imageUrl);
    const response = await cachedRequest(
      cacheKey,
      {
        kind: 'image',
        scope,
        ttlMs: 30 * 24 * 60 * 60 * 1000,
        staleMs: 365 * 24 * 60 * 60 * 1000,
        tags: ['account'],
      },
      (headers, sharedSignal) => {
        const quality = getNetworkQuality();
        imageTaskQueue.setConcurrency(quality === 'good' ? 4 : 2);
        return imageTaskQueue.run(
          () =>
            request(
              imageUrl,
              { credentials: 'include', headers, signal: sharedSignal },
              { timeoutMs: 20_000 },
            ),
          { signal: sharedSignal },
        );
      },
      {
        signal: options?.signal ?? undefined,
        revalidateBudgetMs: 0,
        getNetworkQuality,
      },
    );
    if (!response.ok) {
      debugLog(
        'error',
        'image',
        `✗ ${response.status} 封面/图片加载失败 ${imageUrl} (${Date.now() - startedAt}ms)`,
        response.status === 401 ? '未授权：登录会话可能未携带或已失效' : `HTTP ${response.status}`,
      );
      throw new Error(`image.http.${response.status}`);
    }
    const blob = await response.blob();
    debugLog(
      'success',
      'image',
      `← 图片加载成功 ${imageUrl} (${Date.now() - startedAt}ms)`,
      { type: blob.type, size: blob.size },
    );
    return blob;
  } catch (e) {
    const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    debugLog('error', 'image', `✗ 图片加载异常 ${imageUrl}`, errMsg);
    throw e;
  }
}

/**
 * 通过带认证的 request 获取图片资源，返回可直接用于 <img src> 的 object URL。
 *
 * 为什么需要它：在 Tauri 桌面端，前端运行在自定义协议（tauri://localhost），
 * 与 http(s):// 服务器跨源。<img src> 由 WebView 直接发起，绕过 tauriFetch 插件，
 * 也拿不到登录后由 Rust 侧 cookie jar 维护的 session，因此会 401。
 * 这里改为用 request()（Tauri 下走 tauriFetch、自动带认证）拉取字节再转 blob。
 *
 * 调用方负责在不再使用时 URL.revokeObjectURL 释放。
 */
export async function fetchImageObjectUrl(
  imageUrl: string,
  options?: { signal?: AbortSignal | null },
): Promise<string> {
  const blob = await fetchImageBlob(imageUrl, options);
  return URL.createObjectURL(blob);
}

export async function welcomeCheck(code?: string): Promise<{ err: string; msg?: string }> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const body = new URLSearchParams();

  if (code) {
    body.append('invite_code', code);
  }

  const response = await request(
    `${serverUrl}/api/welcome`,
    {
      method: code ? 'POST' : 'GET',
      body: code ? body : undefined,
      credentials: 'include',
    },
    code ? undefined : { timeoutMs: 15_000 },
  );
  return readJsonResponse(response);
}

interface SharedUserInfoSnapshot {
  status: number;
  statusText: string;
  headers: [string, string][];
  text: string;
}

function createResponseFromUserInfoSnapshot(snapshot: SharedUserInfoSnapshot): Response {
  const body = snapshot.status === 204 || snapshot.status === 304 ? null : snapshot.text;
  const response = new Response(body, {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
  return attachSafeJsonReader(response);
}

function hasHeaderEntries(headers?: HeadersInit): boolean {
  if (!headers) return false;
  if (headers instanceof Headers) {
    let count = 0;
    headers.forEach(() => {
      count += 1;
    });
    return count > 0;
  }
  if (Array.isArray(headers)) return headers.length > 0;
  return Object.keys(headers).length > 0;
}

async function fetchSharedUserInfo(serverUrl: string): Promise<Response> {
  const snapshot = await shareInFlight(
    `user-info\n${serverUrl}`,
    3_000,
    async () => {
      const upstream = await request(
        `${serverUrl}/api/user/info`,
        {
          credentials: 'include',
        },
        { timeoutMs: 15_000 },
      );
      const text = await upstream.text();
      const headers: [string, string][] = [];
      upstream.headers.forEach((value, name) => {
        headers.push([name, value]);
      });
      return {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
        text,
      };
    },
  );

  return createResponseFromUserInfoSnapshot(snapshot);
}

export async function fetchCurrentUser(): Promise<CurrentUserResult> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const response = await fetchSharedUserInfo(serverUrl);
  return readCurrentUserResponse(response);
}

export async function signInWithPassword({
  username,
  password,
  rememberDevice,
  deviceId,
  deviceName,
  captchaData,
}: {
  username: string;
  password: string;
  rememberDevice: boolean;
  deviceId?: string;
  deviceName?: string;
  captchaData?: any;
}): Promise<DeviceApiKeyResponse> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const body = new URLSearchParams();
  body.append('username', username);
  body.append('password', password);
  if (rememberDevice) {
    body.append('remember_device', 'true');
    body.append('device_id', deviceId || '');
    body.append('device_name', deviceName || 'Moke');
  }
  if (captchaData) {
    if (typeof captchaData === 'string') {
      body.append('captcha_code', captchaData);
    } else {
      Object.keys(captchaData).forEach((key) => body.append(key, captchaData[key]));
    }
  }
  const response = await request(`${serverUrl}/api/user/sign_in`, {
    method: 'POST',
    body,
    credentials: 'include',
    connectTimeout: 20_000,
  } as RequestInit & { connectTimeout: number }, { skipSessionRecovery: true });
  return readJsonResponse<DeviceApiKeyResponse>(response);
}

export async function signInWithDeviceApiKey(apiKey: string): Promise<DeviceApiKeyResponse> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const response = await request(`${serverUrl}/api/user/api_key/sign_in`, {
    method: 'POST',
    credentials: 'include',
    headers: { Authorization: `Bearer ${apiKey}` },
  }, { skipSessionRecovery: true });
  return readJsonResponse<DeviceApiKeyResponse>(response);
}

export async function fetchDeviceApiKeys(): Promise<DeviceApiKeyListResponse> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const response = await request(`${serverUrl}/api/user/api_keys`, { credentials: 'include' });
  return readJsonResponse<DeviceApiKeyListResponse>(response);
}

export async function createDeviceApiKey(
  password: string,
  deviceId: string,
  deviceName: string,
): Promise<DeviceApiKeyResponse> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const body = new URLSearchParams({ password, device_id: deviceId, device_name: deviceName });
  const response = await request(`${serverUrl}/api/user/api_keys`, {
    method: 'POST',
    credentials: 'include',
    body,
  });
  return readJsonResponse<DeviceApiKeyResponse>(response);
}

export async function revokeDeviceApiKey(keyId: number): Promise<{ err: string; msg?: string }> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const response = await request(`${serverUrl}/api/user/api_keys/${keyId}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  return readJsonResponse(response);
}

export async function fetchServerInfo(): Promise<{ err: string; msg?: string; title: string; version: string }> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  if (!serverUrl) {
    // 未连接服务器时直接返回空信息，避免发起无前缀 URL 的请求
    return { err: 'no_server', title: '', version: '' };
  }
  const scope = await getMokeCacheScope(serverUrl);
  const response = await cachedRequest(
    `${serverUrl}/api/moke-cache/server-info`,
    {
      kind: 'api',
      scope,
      ttlMs: 10 * 60 * 1000,
      staleMs: 7 * 24 * 60 * 60 * 1000,
      tags: ['account', 'server-info'],
    },
    async (conditionalHeaders, signal) => {
      const hasConditionalHeaders = hasHeaderEntries(conditionalHeaders);
      const upstream = hasConditionalHeaders
        ? await request(
            `${serverUrl}/api/user/info`,
            {
              credentials: 'include',
              headers: conditionalHeaders,
              signal,
            },
            { timeoutMs: 15_000 },
          )
        : await fetchSharedUserInfo(serverUrl);
      if (upstream.status === 304) return upstream;
      const data = await readJsonResponse<UserInfoResponse>(upstream.clone());
      return new Response(JSON.stringify({
        err: data.err,
        msg: data.msg,
        title: data.sys?.title || '',
        version: data.sys?.version || '',
      }), {
        status: upstream.status,
        headers: {
          'content-type': 'application/json',
          ...(upstream.headers.get('etag') ? { etag: upstream.headers.get('etag')! } : {}),
          ...(upstream.headers.get('last-modified')
            ? { 'last-modified': upstream.headers.get('last-modified')! }
            : {}),
        },
      });
    },
  );
  const data = await readJsonResponse<{ err: string; msg?: string; title: string; version: string }>(response);

  return {
    err: data.err,
    msg: data.msg,
    title: data.title || '',
    version: data.version || '',
  };
}

export async function invalidateBookReadCaches(serverUrl: string, bookId: string): Promise<void> {
  const scope = await getMokeCacheScope(serverUrl);
  await invalidateMokeCacheTags(scope, ['shelf', 'library', 'search', `book:${bookId}`]);
}

export async function invalidateLibraryReadCaches(serverUrl: string): Promise<void> {
  const scope = await getMokeCacheScope(serverUrl);
  await invalidateMokeCacheTags(scope, ['library', 'search']);
}

async function probeJsonEndpoint(serverUrl: string, path: string): Promise<boolean> {
  try {
    const response = await request(
      `${serverUrl}${path}`,
      {
        credentials: 'include',
      },
      { timeoutMs: 15_000 },
    );

    if (response.status === 404 || response.status === 405) return false;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return response.ok;

    const data = await readJsonResponse<any>(response).catch(() => null);
    const err = typeof data?.err === 'string' ? data.err : '';

    if (!err) return response.ok;
    if (err === 'page.not_found' || err === 'handler.not_found' || err === 'api.not_found') return false;
    return true;
  } catch (error) {
    debugLog('warn', 'capabilities', `能力探测失败: ${path}`, getErrorMessage(error));
    return false;
  }
}

async function findSampleBookId(serverUrl: string): Promise<string | null> {
  const candidates = ['/api/library?size=1', '/api/shelf'];

  for (const path of candidates) {
    try {
      const response = await request(
        `${serverUrl}${path}`,
        { credentials: 'include' },
        { timeoutMs: 15_000 },
      );
      if (!response.ok) continue;

      const data = await readJsonResponse<any>(response).catch(() => null);
      const books = data?.books || data?.items || data?.data?.books || data?.data?.items;
      if (Array.isArray(books) && books.length > 0 && books[0]?.id != null) {
        return String(books[0].id);
      }
    } catch (error) {
      debugLog('warn', 'capabilities', `样本书籍探测失败: ${path}`, getErrorMessage(error));
    }
  }

  return null;
}

export async function discoverServerCapabilities(serverUrl: string): Promise<ServerCapabilities> {
  const infoResponse = await fetchSharedUserInfo(serverUrl);
  const info = await readJsonResponse<UserInfoResponse>(infoResponse).catch(() => ({} as UserInfoResponse));

  return discoverGeneralServerCapabilities({
    version: info.sys?.version || '',
    findSampleBookId: () => findSampleBookId(serverUrl),
    probeJsonEndpoint: (path) => probeJsonEndpoint(serverUrl, path),
    // The current Talebook contract has no HEAD/limit endpoint for annotations.
    // Do not download and discard a sample book's complete annotation list here.
    // The detail panel's first useful data load doubles as its one-shot probe.
  });
}

export async function validateServerConnection(serverUrl: string): Promise<{ err: string; msg?: string }> {
  const maxRetries = 1;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.log('[validateServerConnection] retry attempt', attempt);
      await new Promise(r => setTimeout(r, 1500));
    }

    let response: Response;

    try {
      response = await request(
        `${serverUrl}/api/user/info`,
        {
          credentials: 'include',
        },
        { timeoutMs: 15_000 },
      );
    } catch (e) {
      if (e instanceof MokeApiError && e.code === 'tauri.ipc.unavailable') {
        console.error('[validateServerConnection] Tauri IPC unavailable');
        return { err: e.code, msg: e.message };
      }
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error('[validateServerConnection] network error:', errorMsg);
      debugLog('error', 'validate', `连接失败 (尝试 ${attempt + 1}/${maxRetries + 1})`, errorMsg);
      if (attempt < maxRetries) continue;
      return {
        err: 'network.error',
        msg: `无法连接到服务器，请检查地址和网络 (${errorMsg})`,
      };
    }

    console.log('[validateServerConnection] status=%s content-type=%s', response.status, response.headers.get('content-type'));

    let data: UserInfoResponse;
    try {
      data = await readJsonResponse<UserInfoResponse>(response, '服务器返回内容无效，不像是可用的 Talebook 服务。');
    } catch (e) {
      logHttpErrorMetadata('validateServerConnection invalid response', response.status, e);
      if (attempt < maxRetries) continue;
      return {
        err: e instanceof MokeApiError ? e.code : 'server.invalid_response',
        msg: getErrorMessage(e, '服务器返回内容无效，不像是可用的 Talebook 服务。'),
      };
    }

    if (!response.ok) {
      logHttpErrorMetadata('validateServerConnection', response.status, data);
      if (attempt < maxRetries) continue;
      return {
        err: data.err || `http.${response.status}`,
        msg: data.msg || '服务器响应异常，请确认服务已正常启动',
      };
    }

    if (data.err !== 'ok' && data.err !== 'not_invited' && data.err !== 'user.need_login' && data.err !== 'not_installed') {
      console.error('[validateServerConnection] unexpected err=%s', getSafeErrorCode(data));
      if (attempt < maxRetries) continue;
      return {
        err: data.err || 'server.invalid',
        msg: data.msg || '服务器校验失败，请确认这是 Talebook 服务',
      };
    }

    console.log('[validateServerConnection] OK err=%s', getSafeErrorCode(data));
    return { err: 'ok' };
  }

  return { err: 'server.invalid_response', msg: '服务器校验失败' };
}

export async function checkWelcomeRequirement(serverUrl: string): Promise<WelcomeRequirement> {
  let response: Response;

  try {
    response = await request(
      `${serverUrl}/api/welcome`,
      {
        credentials: 'include',
      },
      { timeoutMs: 15_000 },
    );
  } catch (e) {
    console.error('[checkWelcomeRequirement] network error:', e);
    return {
      err: 'network.error',
      msg: '无法检查访问码状态，请检查服务器连接',
      needsAccessCode: false,
      passwordLoginApi: false,
      deviceApiKeyApi: false,
    };
  }

  let data: { err?: string; msg?: string; welcome?: string; auth?: { password_login?: boolean; device_api_key?: boolean } };

  try {
    data = await readJsonResponse(response, '服务器返回内容无效，无法确认访问码状态。');
  } catch (e) {
    logHttpErrorMetadata('checkWelcomeRequirement invalid response', response.status, e);
    return {
      err: e instanceof MokeApiError ? e.code : 'server.invalid_response',
      msg: getErrorMessage(e, '服务器返回内容无效，无法确认访问码状态。'),
      needsAccessCode: false,
      passwordLoginApi: false,
      deviceApiKeyApi: false,
    };
  }

  if (!response.ok) {
    logHttpErrorMetadata('checkWelcomeRequirement', response.status, data);
    return {
      err: data.err || `http.${response.status}`,
      msg: data.msg || '访问码状态检查失败',
      needsAccessCode: false,
      passwordLoginApi: false,
      deviceApiKeyApi: false,
    };
  }

  console.log('[checkWelcomeRequirement] err=%s', getSafeErrorCode(data));

  if (data.err === 'ok') {
    return {
      err: 'ok',
      msg: data.welcome || data.msg,
      needsAccessCode: true,
      passwordLoginApi: data.auth?.password_login === true,
      deviceApiKeyApi: data.auth?.device_api_key === true,
    };
  }

  return {
    err: 'ok',
    msg: data.msg,
    needsAccessCode: false,
    passwordLoginApi: data.auth?.password_login === true,
    deviceApiKeyApi: data.auth?.device_api_key === true,
  };
}

export async function submitWelcomeCode(code: string, captchaData?: any): Promise<{ err: string; msg?: string }> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  debugLog('info', 'submitCode', `读取到 serverUrl="${serverUrl}"`, { isEmpty: !serverUrl });
  const body = new URLSearchParams();
  body.append('invite_code', code);

  if (captchaData) {
    if (typeof captchaData === 'string') {
      body.append('captcha_code', captchaData);
    } else {
      Object.keys(captchaData).forEach(key => {
        body.append(key, captchaData[key]);
      });
    }
  }

  const response = await request(`${serverUrl}/api/welcome`, {
    method: 'POST',
    body,
    credentials: 'include',
  });

  const result = await readJsonResponse<{ err: string; msg?: string }>(response);
  console.log('[submitWelcomeCode] err=%s', getSafeErrorCode(result));
  return result;
}

export async function downloadBookBlob(
  bookId: string | number,
  format = 'epub',
  options?: { onProgress?: (progress: number) => void; signal?: AbortSignal },
): Promise<Blob> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const url = `${serverUrl}/api/book/${bookId}.${format}`;

  try {
    const response = await request(url, {
      ...(isTauriApp
        ? ({
            method: 'GET',
            headers: buildTauriBinaryHeaders(),
            connectTimeout: 30_000,
            signal: options?.signal,
          } as any)
        : { credentials: 'include', signal: options?.signal }),
    });

    if (!response.ok) {
      throw new Error(`http.${response.status}`);
    }

    const total = Number(response.headers.get('content-length') || 0);
    const reader = response.body?.getReader();

    if (!reader) {
      const blob = await response.blob();
      options?.onProgress?.(99);
      return validateDownloadedBook(blob, format);
    }

    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      if (!value) continue;

      chunks.push(value);
      received += value.length;

      if (total > 0) {
        options?.onProgress?.(Math.min(99, Math.round((received / total) * 100)));
      }
    }

    options?.onProgress?.(99);

    return validateDownloadedBook(new Blob(chunks as BlobPart[], {
      type: response.headers.get('content-type') || 'application/octet-stream',
    }), format);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    throw new Error(reason || 'network.error');
  }
}

const BOOK_TAIL_WINDOW = 22 + 0xffff + 4096;

function keepTailBytes(tail: Uint8Array, chunk: Uint8Array, windowSize: number): Uint8Array {
  const combinedLength = tail.length + chunk.length;
  if (combinedLength <= windowSize) {
    const combined = new Uint8Array(combinedLength);
    combined.set(tail, 0);
    combined.set(chunk, tail.length);
    return combined;
  }

  const result = new Uint8Array(windowSize);
  if (chunk.length >= windowSize) {
    result.set(chunk.subarray(chunk.length - windowSize));
    return result;
  }
  const tailKeep = windowSize - chunk.length;
  result.set(tail.subarray(tail.length - tailKeep), 0);
  result.set(chunk, tailKeep);
  return result;
}

/** 流式下载：把响应体逐块交给 write()，仅保留文件尾部用于 EPUB 校验，
 *  避免把整本书累积在内存中（大书/低内存设备 OOM）。 */
export async function streamBookDownload(
  bookId: string | number,
  format = 'epub',
  options: {
    write: (chunk: Uint8Array) => Promise<void>;
    onProgress?: (progress: number) => void;
    onTransfer?: (receivedBytes: number, totalBytes: number | null) => void;
    signal?: AbortSignal;
    resumeFrom?: number;
    onRangeReset?: () => Promise<void>;
    /** Tauri validates the completed on-disk tail, including bytes from an earlier range. */
    validateEpub?: boolean;
    stallTimeoutMs?: number;
    expectedTotalBytes?: number | null;
  },
): Promise<{ mimeType: string; size: number; sourceSignature?: string; resumed: boolean }> {
  const stallTimeoutMs = options.stallTimeoutMs ?? 45_000;
  const deadline = createIdleDeadline(options.signal, stallTimeoutMs);
  let url = '';

  try {
    const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
    url = `${serverUrl}/api/book/${bookId}.${format}`;
    const requestedOffset = Math.max(0, options.resumeFrom || 0);
    const headers = new Headers();
    if (requestedOffset > 0) headers.set('Range', `bytes=${requestedOffset}-`);

    const fetchDownload = (requestHeaders: Headers) => request(
      url,
      {
        ...(isTauriApp
          ? ({
              method: 'GET',
              headers: buildTauriBinaryHeaders(requestHeaders),
              connectTimeout: 30_000,
              signal: deadline.signal,
            } as any)
          : { credentials: 'include', signal: deadline.signal, headers: requestHeaders }),
      },
      requestHeaders.has('Range') ? { expectedStatuses: [416] } : undefined,
    );
    let response = await fetchDownload(headers);
    let contentRange = parseContentRange(response.headers.get('content-range'));
    let rangeMode = classifyOfflineRangeResponse(requestedOffset, response.status, contentRange);
    if (
      rangeMode === 'resume' &&
      typeof options.expectedTotalBytes === 'number' &&
      options.expectedTotalBytes > 0 &&
      typeof contentRange?.total === 'number' &&
      contentRange.total !== options.expectedTotalBytes
    ) {
      rangeMode = 'retry-full';
    }
    if (!response.ok && rangeMode !== 'retry-full') throw new Error(`http.${response.status}`);
    if (rangeMode === 'retry-full') {
      if (response.status === 416) {
        await drainResponseBodyQuietly(response);
      } else {
        await cancelResponseBodyQuietly(response);
      }
      await options.onRangeReset?.();
      deadline.touch();
      response = await fetchDownload(new Headers());
      if (!response.ok) throw new Error(`http.${response.status}`);
      contentRange = parseContentRange(response.headers.get('content-range'));
      rangeMode = classifyOfflineRangeResponse(0, response.status, contentRange);
    }
    if (rangeMode === 'invalid') throw new Error('book.download.range.invalid');
    const resumed = rangeMode === 'resume';
    let received = resumed ? requestedOffset : 0;
    if (rangeMode === 'restart') await options.onRangeReset?.();
    const responseLength = Number(response.headers.get('content-length') || 0);
    const total = contentRange?.total ?? (responseLength > 0 ? received + responseLength : null);
    const sourceSignature = response.headers.get('etag') || response.headers.get('last-modified') || undefined;
    const reader = response.body?.getReader();

    if (!reader) {
      let blob: Blob;
      try {
        blob = await response.blob();
      } catch (error) {
        if (deadline.timedOut()) throw new Error('book.download.stalled');
        if (isRequestCancelled(error)) throw error;
        logBinaryTransferFailure(url, response, error, 0);
        throw new Error('book.download.transfer_failed');
      }

      try {
        await options.write(new Uint8Array(await blob.arrayBuffer()));
      } catch (error) {
        logOfflineWriteFailure(error, blob.size);
        throw new Error('book.download.storage_failed');
      }
      received += blob.size;
      options.onTransfer?.(received, total);
      options.onProgress?.(99);
      if (total != null && received !== total) throw new Error('book.download.incomplete');
      if (options.validateEpub !== false && format.toLowerCase() === 'epub' && !(await hasEpubCentralDirectory(blob))) {
        throw new Error('book.epub.invalid');
      }
      return { mimeType: response.headers.get('content-type') || 'application/octet-stream', size: received, sourceSignature, resumed };
    }

    let tail: Uint8Array = new Uint8Array(0);
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (deadline.timedOut()) throw new Error('book.download.stalled');
        if (isRequestCancelled(error)) throw error;
        logBinaryTransferFailure(url, response, error, received);
        throw new Error('book.download.transfer_failed');
      }

      const { done, value } = result;
      if (done) break;
      if (!value) continue;

      deadline.touch();

      try {
        await options.write(value);
      } catch (error) {
        try {
          await reader.cancel(error);
        } catch {
          // 原始写入错误更有诊断价值，取消失败不覆盖它。
        }
        logOfflineWriteFailure(error, received);
        throw new Error('book.download.storage_failed');
      }
      received += value.length;
      tail = keepTailBytes(tail, value, BOOK_TAIL_WINDOW);
      options.onTransfer?.(received, total);
      if (total && total > 0) options.onProgress?.(Math.min(99, Math.round((received / total) * 100)));
    }
    options.onProgress?.(99);
    if (total != null && received !== total) throw new Error('book.download.incomplete');
    if (options.validateEpub !== false && format.toLowerCase() === 'epub' && !(await hasEpubCentralDirectory(new Blob([tail])))) {
      throw new Error('book.epub.invalid');
    }
    return {
      mimeType: response.headers.get('content-type') || 'application/octet-stream',
      size: received,
      sourceSignature,
      resumed,
    };
  } catch (error) {
    if (deadline.timedOut()) {
      throw new Error('book.download.stalled');
    }
    if (options.signal?.aborted) {
      if ((error as { name?: string })?.name === 'AbortError') {
        throw error;
      }
      throw new DOMException('Aborted', 'AbortError');
    }
    if (error instanceof Error && (error.message.startsWith('book.') || error.message.startsWith('http.'))) {
      throw error;
    }
    if (error instanceof MokeApiError && error.code === 'tauri.ipc.unavailable') {
      throw error;
    }
    debugLog('error', 'download', `✗ 下载请求异常 ${url || bookId}`, binaryTransferErrorDetail(error));
    throw new Error('book.download.transfer_failed');
  } finally {
    deadline.clear();
  }
}
