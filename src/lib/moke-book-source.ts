import type { ReadingProgressPayload } from './reading-progress';

export type MokeBookFormat = 'epub' | 'pdf';

interface MokeBookSourceBase {
  bookId: string;
  format: string;
  title: string;
  author: string;
  identity: string;
  cacheScope: string;
  cacheLimitBytes: number;
}

export interface MokeLocalBookSource extends MokeBookSourceBase {
  kind: 'local';
  filePath: string;
  fileVersion?: string;
}

export interface MokeRemoteBookSource extends MokeBookSourceBase {
  kind: 'remote';
  format: MokeBookFormat;
  serverUrl: string;
  url: string;
}

export type MokeBookSource = MokeLocalBookSource | MokeRemoteBookSource;

export interface MokeReaderLaunch {
  source: MokeBookSource;
  eink: boolean;
  debugPanel?: boolean;
  restoreProgress: ReadingProgressPayload | null;
  serverUrl?: string;
}

function fnv1a(value: string, seed: number): string {
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

export function normalizeOnlineFormat(format: string): MokeBookFormat | null {
  const value = format.trim().toLowerCase();
  return value === 'epub' || value === 'pdf' ? value : null;
}

export function selectPreferredBookFormat(
  files: ReadonlyArray<{ format?: string | null }> | null | undefined,
): string | null {
  const formats = (files ?? [])
    .map((file) => file.format?.trim().toLowerCase() || '')
    .filter(Boolean);
  return formats.find((format) => format === 'epub')
    ?? formats.find((format) => format === 'pdf')
    ?? formats[0]
    ?? null;
}

export function buildMokeSourceIdentity({ serverUrl, account, bookId, format }: {
  serverUrl: string;
  account: string;
  bookId: string;
  format: string;
}): { identity: string; cacheScope: string } {
  const cacheScope = buildMokeAccountCacheScope({ serverUrl, account });
  const normalizedServer = serverUrl.replace(/\/+$/, '').toLowerCase();
  return {
    cacheScope,
    identity: `moke${opaqueId(`${normalizedServer}\n${cacheScope}\n${bookId}\n${format.toLowerCase()}`)}`,
  };
}

export function buildMokeAccountCacheScope({ serverUrl, account }: {
  serverUrl: string;
  account: string;
}): string {
  const normalizedServer = serverUrl.replace(/\/+$/, '').toLowerCase();
  return opaqueId(`${normalizedServer}\n${account || 'anonymous'}`);
}

export function readerCacheLimitForPlatform(platform: string): number {
  return ['android', 'ios', 'ohos'].includes(platform)
    ? 384 * 1024 * 1024
    : 1536 * 1024 * 1024;
}
