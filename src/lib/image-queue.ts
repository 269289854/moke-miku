export interface TaskQueue {
  run<T>(task: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
  setConcurrency(concurrency: number): void;
  readonly pending: number;
  readonly active: number;
}

interface QueueItem {
  start: () => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createTaskQueue(options: { concurrency: number; order?: 'lifo' | 'fifo' }): TaskQueue {
  let currentConcurrency = Math.max(1, Math.floor(options.concurrency) || 1);
  const order = options.order ?? 'lifo';
  const queue: QueueItem[] = [];
  let activeCount = 0;

  function pump(): void {
    while (activeCount < currentConcurrency && queue.length > 0) {
      const item = order === 'lifo' ? queue.pop()! : queue.shift()!;
      if (item.signal && item.onAbort) {
        item.signal.removeEventListener('abort', item.onAbort);
      }
      item.start();
    }
  }

  function setConcurrency(concurrency: number): void {
    currentConcurrency = Math.max(1, Math.floor(concurrency) || 1);
    pump();
  }

  function run<T>(task: () => Promise<T>, runOptions?: { signal?: AbortSignal }): Promise<T> {
    const signal = runOptions?.signal;
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    return new Promise<T>((resolve, reject) => {
      let item: QueueItem;

      const onAbort = () => {
        const index = queue.indexOf(item);
        if (index !== -1) {
          queue.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        }
      };

      const start = () => {
        activeCount++;
        (async () => {
          try {
            const result = await task();
            resolve(result);
          } catch (err) {
            reject(err);
          } finally {
            activeCount--;
            pump();
          }
        })();
      };

      item = {
        start,
        signal,
        onAbort,
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      queue.push(item);
      pump();
    });
  }

  return {
    run,
    setConcurrency,
    get pending() {
      return queue.length;
    },
    get active() {
      return activeCount;
    },
  };
}
