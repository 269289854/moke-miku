export type NetworkQuality = 'good' | 'degraded' | 'offline';
export type NetworkFailureKind = 'error' | 'timeout' | 'gateway';

const DEGRADED_WINDOW_MS = 30_000;
const FAILURE_THRESHOLD = 2;

const defaultNow = (): number => Date.now();

const defaultOnline = (): boolean => {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
};

let getNow = defaultNow;
let isOnline = defaultOnline;
let consecutiveFailures = 0;
let lastFailureAt = 0;
const recoveryListeners = new Set<() => void>();
let onlineListenerRegistered = false;

function notifyRecovery(): void {
  const snapshot = Array.from(recoveryListeners);
  for (const listener of snapshot) {
    try {
      listener();
    } catch {
      // Ignore listener error to avoid blocking other listeners
    }
  }
}

function ensureOnlineListener(): void {
  if (onlineListenerRegistered) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  onlineListenerRegistered = true;
  window.addEventListener('online', () => {
    consecutiveFailures = 0;
    notifyRecovery();
  });
}

export function getNetworkQuality(): NetworkQuality {
  ensureOnlineListener();
  if (!isOnline()) {
    return 'offline';
  }
  if (consecutiveFailures >= FAILURE_THRESHOLD && getNow() - lastFailureAt <= DEGRADED_WINDOW_MS) {
    return 'degraded';
  }
  return 'good';
}

export function reportNetworkSuccess(): void {
  ensureOnlineListener();
  const previousQuality = getNetworkQuality();
  consecutiveFailures = 0;
  if (previousQuality !== 'good') {
    notifyRecovery();
  }
}

export function reportNetworkFailure(kind: NetworkFailureKind): void {
  void kind;
  ensureOnlineListener();
  consecutiveFailures += 1;
  lastFailureAt = getNow();
}

export function subscribeNetworkRecovery(listener: () => void): () => void {
  ensureOnlineListener();
  recoveryListeners.add(listener);
  return () => {
    recoveryListeners.delete(listener);
  };
}

export function waitForNetworkRecovery(
  signal?: AbortSignal,
  maxWaitMs?: number,
): Promise<void> {
  ensureOnlineListener();

  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  if (getNetworkQuality() === 'good') {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    let isSettled = false;

    const cleanup = () => {
      if (isSettled) return;
      isSettled = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = undefined;
      }
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
        abortHandler = undefined;
      }
    };

    abortHandler = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (typeof maxWaitMs === 'number' && Number.isFinite(maxWaitMs)) {
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, Math.max(0, maxWaitMs));
    }

    unsubscribe = subscribeNetworkRecovery(() => {
      cleanup();
      resolve();
    });
  });
}

export function __resetNetworkHealthForTests(options?: {
  now?: () => number;
  online?: () => boolean;
}): void {
  consecutiveFailures = 0;
  lastFailureAt = 0;
  recoveryListeners.clear();
  getNow = options?.now ?? defaultNow;
  isOnline = options?.online ?? defaultOnline;
}
