import { isSingleWebviewRuntime } from './moke-reader.ts';

type RequestLike = (url: string, init?: RequestInit) => Promise<Response>;
const READ_RECORD_TIMEOUT_MS = 10_000;
/**
 * Record-before-navigation must not noticeably delay opening the reader: the
 * request is best-effort, so bound it much tighter than the desktop path.
 */
export const READ_RECORD_NAV_TIMEOUT_MS = 3_000;

export type BookReadAuthenticationDestination = '/access' | '/login';

interface TimeoutGuard {
  signal: AbortSignal | undefined;
  expired: Promise<never>;
  cleanup: () => void;
}

/**
 * Bound the whole request even on WebViews without `AbortSignal.timeout` or
 * `AbortController`. The explicit timer can be cleared as soon as the request
 * settles, unlike a fire-and-forget fallback signal.
 */
function buildTimeoutGuard(timeoutMs: number): TimeoutGuard {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('book.read_record.timeout'));
      controller?.abort();
    }, timeoutMs);
  });

  return {
    signal: controller?.signal,
    expired,
    cleanup: () => clearTimeout(timer),
  };
}

interface UrlTarget {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
}

/** Network target and decoded pathname of an absolute URL; null if unsafe. */
function urlTargetOf(url: string): UrlTarget | null {
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: decodeURIComponent(parsed.pathname).replace(/\/+$/, '') || '/',
    };
  } catch {
    return null;
  }
}

function isAllowedTarget(expected: UrlTarget, actual: UrlTarget): boolean {
  const allowedProtocol = actual.protocol === expected.protocol
    || (expected.protocol === 'http:' && actual.protocol === 'https:');
  return allowedProtocol
    && actual.hostname === expected.hostname
    && actual.port === expected.port
    && actual.pathname === expected.pathname;
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || '';
  return contentType === 'application/json' || contentType.endsWith('+json');
}

function parseJsonBody(body: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error('book.read_record.response.invalid');
  }
}

function safeApiErrorCode(value: unknown): string {
  return typeof value === 'string'
    && value.length <= 64
    && /^[a-z0-9_.-]+$/.test(value)
    ? value
    : 'invalid';
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  if (error instanceof Error && error.message) codes.push(error.message);
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
  }
  return codes;
}

/** Resolve only explicit authentication failures; transport failures remain best-effort. */
export function bookReadAuthenticationDestination(
  error: unknown,
): BookReadAuthenticationDestination | null {
  const codes = errorCodes(error);
  if (codes.some((code) => (
    code === 'not_invited'
    || code === 'book.read_record.api.not_invited'
    || code === 'book.read_record.redirect.not_invited'
  ))) {
    return '/access';
  }
  if (codes.some((code) => (
    code === 'user.need_login'
    || code === 'book.read_record.api.user.need_login'
    || code === 'book.read_record.http.401'
    || code === 'book.read_record.redirect.user.need_login'
  ))) {
    return '/login';
  }
  return null;
}

/**
 * Persist the mobile read marker before full-document navigation. Authentication
 * failures stop the remote reader; ordinary sync failures keep the old
 * best-effort behavior so a temporary network problem does not block reading.
 */
export async function recordBookReadBeforeNavigation({
  record,
  onAuthenticationRequired,
  onRecordError,
}: {
  record: () => Promise<void>;
  onAuthenticationRequired: (
    destination: BookReadAuthenticationDestination,
    error: unknown,
  ) => void | Promise<void>;
  onRecordError?: (error: unknown) => void;
}): Promise<boolean> {
  try {
    await record();
    return true;
  } catch (error) {
    const destination = bookReadAuthenticationDestination(error);
    if (destination) {
      await onAuthenticationRequired(destination, error);
      return false;
    }
    onRecordError?.(error);
    return true;
  }
}

/** Persist the reading state without invoking Talebook's download-counting reader route. */
export async function recordBookRead(
  requestLike: RequestLike,
  serverUrl: string,
  bookId: string | number,
  timeoutMs = READ_RECORD_TIMEOUT_MS,
  onlineRead = true,
): Promise<void> {
  const readUrl = `${serverUrl.replace(/\/+$/, '')}/api/book/${encodeURIComponent(String(bookId))}/readstate`;
  const expectedTarget = urlTargetOf(readUrl);
  const timeout = buildTimeoutGuard(timeoutMs);

  try {
    const response = await Promise.race([
      requestLike(readUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: timeout.signal,
        body: JSON.stringify({
          read_state: 1,
          ...(onlineRead ? { online_read: 1 } : {}),
        }),
      }),
      timeout.expired,
    ]);

    if (!response.ok) {
      throw new Error(`book.read_record.http.${response.status}`);
    }

    // A 200 from `/`, a login page, or another host means the server followed
    // a redirect and the state was never persisted. Browser fetch and the
    // pinned Tauri plugin-http expose the final URL; an empty value is therefore
    // unverifiable and must fail closed instead of bypassing redirect checks.
    const finalTarget = urlTargetOf(response.url);
    if (
      !expectedTarget
      || !finalTarget
      || !isAllowedTarget(expectedTarget, finalTarget)
    ) {
      if (finalTarget?.pathname === '/access' || finalTarget?.pathname === '/welcome') {
        throw new Error('book.read_record.redirect.not_invited');
      }
      if (finalTarget?.pathname === '/login' || finalTarget?.pathname === '/user/sign_in') {
        throw new Error('book.read_record.redirect.user.need_login');
      }
      throw new Error('book.read_record.redirect');
    }

    if (!isJsonResponse(response)) {
      throw new Error('book.read_record.response.invalid');
    }

    let body: ArrayBuffer;
    try {
      body = await Promise.race([response.arrayBuffer(), timeout.expired]);
    } catch (error) {
      if (error instanceof Error && error.message === 'book.read_record.timeout') throw error;
      throw new Error('book.read_record.response.invalid');
    }
    const payload = parseJsonBody(body);
    const err = payload && typeof payload === 'object' && 'err' in payload
      ? (payload as { err?: unknown }).err
      : undefined;
    if (err !== 'ok') {
      throw new Error(`book.read_record.api.${safeApiErrorCode(err)}`);
    }
  } finally {
    timeout.cleanup();
  }
}

/**
 * Start the independent reader-launch prerequisites together. On mobile the
 * read-state request starts as soon as the local record and runtime are
 * known, instead of waiting for the unrelated progress fetch. The returned
 * preparation still waits for that best-effort write before a full-document
 * navigation destroys the Moke WebView, but a write failure never blocks the
 * book from opening. Starting all three jobs means a missing local record can
 * still spend one progress request and platform probe; that rare failure-path
 * cost is the deliberate trade-off for removing their latency on valid opens.
 */
export async function prepareEmbeddedBookOpen<TRecord, TProgress>({
  loadRecord,
  loadProgress,
  loadPlatform,
  beforeSingleWebviewOpen,
  onBeforeSingleWebviewOpenError,
}: {
  loadRecord: () => Promise<TRecord>;
  loadProgress: () => Promise<TProgress>;
  loadPlatform: () => Promise<string>;
  beforeSingleWebviewOpen?: (record: TRecord, platform: string) => Promise<void>;
  onBeforeSingleWebviewOpenError?: (error: unknown) => void;
}): Promise<{ record: TRecord; restoreProgress: TProgress; platform: string }> {
  const recordPromise = Promise.resolve().then(loadRecord);
  const progressPromise = Promise.resolve().then(loadProgress);
  const platformPromise = Promise.resolve().then(loadPlatform);
  const beforeOpenPromise = beforeSingleWebviewOpen
    ? Promise.all([recordPromise, platformPromise]).then(async ([record, platform]) => {
        if (!isSingleWebviewRuntime(platform)) return;
        try {
          await beforeSingleWebviewOpen(record, platform);
        } catch (error) {
          onBeforeSingleWebviewOpenError?.(error);
        }
      })
    : Promise.resolve();

  const [record, restoreProgress, platform] = await Promise.all([
    recordPromise,
    progressPromise,
    platformPromise,
    beforeOpenPromise,
  ]);
  return { record, restoreProgress, platform };
}

export async function openAndRecordBookRead({
  open,
  record,
  onOpened,
  onRecordError,
}: {
  open: () => Promise<void>;
  record: () => Promise<void>;
  onOpened?: () => void;
  onRecordError?: (error: unknown) => void;
}): Promise<void> {
  await open();
  onOpened?.();
  try {
    await record();
  } catch (error) {
    onRecordError?.(error);
  }
}
