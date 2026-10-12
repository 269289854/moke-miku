function errorWithAbortName(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error && signal.reason.name === 'AbortError') {
    return signal.reason;
  }
  const reasonText = typeof signal?.reason === 'string' ? signal.reason : 'Aborted';
  return new DOMException(reasonText, 'AbortError');
}

export function isRetryableDownloadError(error: unknown): boolean {
  if (!error) return false;
  if ((error as { name?: string }).name === 'AbortError') return false;
  if (error instanceof TypeError) return true;

  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : undefined;
  const message = error instanceof Error
    ? error.message
    : typeof (error as { message?: unknown })?.message === 'string'
      ? (error as { message: string }).message
      : typeof error === 'string'
        ? error
        : undefined;

  const isMatching = (val: string | undefined): boolean => {
    if (!val) return false;
    if (
      val === 'book.download.transfer_failed' ||
      val === 'book.download.stalled' ||
      val === 'book.download.incomplete' ||
      val === 'network.timeout'
    ) {
      return true;
    }
    return /^http\.(408|429|5\d\d)$/.test(val);
  };

  return isMatching(code) || isMatching(message);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(errorWithAbortName(signal));
  }
  if (ms <= 0) return Promise.resolve();

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
      reject(errorWithAbortName(signal));
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

export interface DownloadRetryOptions {
  signal?: AbortSignal;
  maxAttempts?: number;
  delaysMs?: number[];
  isRetryable?: (error: unknown) => boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  waitForNetwork?: (signal?: AbortSignal) => Promise<void>;
  onRetry?: (attemptIndex: number, error: unknown, delayMs: number) => void;
}

export async function runWithDownloadRetry<T>(
  attempt: (attemptIndex: number) => Promise<T>,
  options?: DownloadRetryOptions,
): Promise<T> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw errorWithAbortName(signal);
  }

  const maxAttempts = options?.maxAttempts ?? 5;
  const delaysMs = options?.delaysMs ?? [2000, 5000, 10000, 20000];
  const isRetryable = options?.isRetryable ?? isRetryableDownloadError;
  const sleep = options?.sleep ?? defaultSleep;
  const waitForNetwork = options?.waitForNetwork;
  const onRetry = options?.onRetry;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
    try {
      return await attempt(attemptIndex);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      if (!isRetryable(error) || attemptIndex + 1 >= maxAttempts) {
        throw error;
      }

      const delayMs = delaysMs.length > 0
        ? delaysMs[Math.min(attemptIndex, delaysMs.length - 1)]
        : 0;

      onRetry?.(attemptIndex, error, delayMs);

      if (signal?.aborted) {
        throw errorWithAbortName(signal);
      }

      if (waitForNetwork) {
        await waitForNetwork(signal);
      }

      if (signal?.aborted) {
        throw errorWithAbortName(signal);
      }

      await sleep(delayMs, signal);
    }
  }

  throw new Error('download.retry.exhausted');
}
