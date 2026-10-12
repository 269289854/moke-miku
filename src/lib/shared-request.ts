interface SharedRequestEntry<T> {
  promise: Promise<T>;
  inFlight: boolean;
  settledAt: number;
  ttlMs: number;
  now: () => number;
}

const sharedRequests = new Map<string, SharedRequestEntry<unknown>>();

export function __resetSharedRequestsForTests(): void {
  sharedRequests.clear();
}

export function shareInFlight<T>(
  key: string,
  ttlMs: number,
  run: () => Promise<T>,
  now?: () => number,
): Promise<T> {
  const getNow = now ?? Date.now;
  const existing = sharedRequests.get(key) as SharedRequestEntry<T> | undefined;

  if (existing) {
    if (existing.inFlight) {
      return existing.promise;
    }
    const currentNow = now ?? existing.now;
    const elapsed = currentNow() - existing.settledAt;
    if (elapsed >= 0 && elapsed < existing.ttlMs) {
      return existing.promise;
    }
    sharedRequests.delete(key);
  }

  const entry: SharedRequestEntry<T> = {
    promise: Promise.resolve() as unknown as Promise<T>,
    inFlight: true,
    settledAt: 0,
    ttlMs,
    now: getNow,
  };

  sharedRequests.set(key, entry as SharedRequestEntry<unknown>);

  const promise = (async () => {
    try {
      const value = await run();
      entry.inFlight = false;
      entry.settledAt = entry.now();
      return value;
    } catch (error) {
      if (sharedRequests.get(key) === entry) {
        sharedRequests.delete(key);
      }
      throw error;
    }
  })();

  entry.promise = promise;
  return promise;
}
