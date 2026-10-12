export const STALE_CONTENT_MESSAGE = '网络较慢，正在显示缓存内容';
export const STALE_NOTICE_INTERVAL_MS = 60_000;

let lastNoticeAt: number | null = null;

export function notifyStaleContent(
  show: (message: string) => void,
  now: number = Date.now(),
): boolean {
  if (lastNoticeAt !== null && now - lastNoticeAt < STALE_NOTICE_INTERVAL_MS) {
    return false;
  }
  lastNoticeAt = now;
  show(STALE_CONTENT_MESSAGE);
  return true;
}

export function __resetStaleNoticeForTests(): void {
  lastNoticeAt = null;
}
