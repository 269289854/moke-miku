export const COVER_THUMB_WIDTH = 360;
export const COVER_THUMB_HEIGHT = 480;

const DUMMY_BASE = 'http://localhost';

export function buildCoverThumbUrl(
  url: string,
  width: number = COVER_THUMB_WIDTH,
  height: number = COVER_THUMB_HEIGHT,
): string {
  if (!url || typeof url !== 'string') return url;
  if (/^(?:data:|blob:)/i.test(url)) return url;

  try {
    const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
    if (isAbsolute && !/^https?:/i.test(url)) {
      return url;
    }
    const parsed = new URL(url, DUMMY_BASE);
    const match = parsed.pathname.match(/^(.*\/get\/)cover\/(\d+)\.jpg$/);
    if (!match) return url;
    const prefix = match[1];
    const bookId = match[2];
    const w = width ?? COVER_THUMB_WIDTH;
    const h = height ?? COVER_THUMB_HEIGHT;
    parsed.pathname = `${prefix}thumb_${w}_${h}/${bookId}.jpg`;
    if (isAbsolute) {
      return parsed.toString();
    }
    const search = parsed.search ? parsed.search : '';
    return `${parsed.pathname}${search}${parsed.hash}`;
  } catch {
    return url;
  }
}

export function normalizeCoverCacheKey(url: string): string {
  if (!url || typeof url !== 'string') return url;
  if (/^(?:data:|blob:)/i.test(url)) return url;

  try {
    const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
    if (isAbsolute && !/^https?:/i.test(url)) {
      return url;
    }
    const parsed = new URL(url, DUMMY_BASE);
    const isCoverPath = /(?:^|\/)get\/(?:cover|thumb_\d+_\d+)\/\d+\.jpg$/.test(parsed.pathname);
    if (!isCoverPath) return url;

    if (!parsed.searchParams.has('t')) return url;

    parsed.searchParams.delete('t');

    if (isAbsolute) {
      return parsed.toString();
    }
    const search = parsed.search ? parsed.search : '';
    return `${parsed.pathname}${search}${parsed.hash}`;
  } catch {
    return url;
  }
}
