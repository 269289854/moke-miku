'use client';

export type MokeNativeCacheKind = 'api' | 'image';

export interface MokeNativeCacheEntry {
  key: string;
  kind: MokeNativeCacheKind;
  size: number;
  accessedAt: number;
  tags: string[];
}

interface MokeNativeCacheMetadata {
  version: 1;
  key: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  size: number;
}

interface NativeCachePaths {
  kind: MokeNativeCacheKind;
  directory: string;
  body: string;
  metadata: string;
}

const CACHE_ROOT = 'moke-http-cache/v2';
const CACHE_ORIGIN = 'https://moke-cache.invalid';

type FsModule = typeof import('@tauri-apps/plugin-fs');

let fsPromise: Promise<FsModule> | null = null;

async function getFs(): Promise<FsModule> {
  fsPromise ??= import('@tauri-apps/plugin-fs');
  return fsPromise;
}

export function __setMokeNativeCacheFsForTests(fs: FsModule | null): void {
  fsPromise = fs ? Promise.resolve(fs) : null;
}

function appCacheOptions(fs: FsModule) {
  return { baseDir: fs.BaseDirectory.AppCache } as const;
}

export function nativeCachePathsForKey(key: string): NativeCachePaths | null {
  try {
    const url = new URL(key);
    if (url.origin !== CACHE_ORIGIN || url.search || url.hash) return null;
    const match = url.pathname.match(/^\/v2\/(api|image)\/([0-9a-f]{16})$/);
    if (!match) return null;
    const kind = match[1] as MokeNativeCacheKind;
    const id = match[2]!;
    const directory = `${CACHE_ROOT}/${kind}`;
    return {
      kind,
      directory,
      body: `${directory}/${id}.body`,
      metadata: `${directory}/${id}.json`,
    };
  } catch {
    return null;
  }
}

function parseMetadata(text: string, expectedKey?: string): MokeNativeCacheMetadata | null {
  try {
    const value = JSON.parse(text) as Partial<MokeNativeCacheMetadata>;
    if (
      value.version !== 1 ||
      typeof value.key !== 'string' ||
      (expectedKey !== undefined && value.key !== expectedKey) ||
      !nativeCachePathsForKey(value.key) ||
      typeof value.status !== 'number' ||
      !Number.isSafeInteger(value.status) ||
      value.status < 200 ||
      value.status > 299 ||
      typeof value.statusText !== 'string' ||
      !value.headers ||
      typeof value.headers !== 'object' ||
      typeof value.size !== 'number' ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0
    ) {
      return null;
    }
    for (const [name, headerValue] of Object.entries(value.headers)) {
      if (typeof name !== 'string' || typeof headerValue !== 'string') return null;
    }
    return value as MokeNativeCacheMetadata;
  } catch {
    return null;
  }
}

async function removeFileQuietly(fs: FsModule, path: string): Promise<void> {
  try {
    await fs.remove(path, appCacheOptions(fs));
  } catch {
    // A missing or concurrently removed cache file is already the desired state.
  }
}

export async function putNativeCacheResponse(key: string, response: Response): Promise<boolean> {
  const paths = nativeCachePathsForKey(key);
  if (!paths) return false;
  try {
    const fs = await getFs();
    const body = new Uint8Array(await response.clone().arrayBuffer());
    const headers = Object.fromEntries(response.headers.entries());
    headers['x-moke-cache-size'] = String(body.byteLength);
    const metadata: MokeNativeCacheMetadata = {
      version: 1,
      key,
      status: response.status,
      statusText: response.statusText,
      headers,
      size: body.byteLength,
    };
    await fs.mkdir(paths.directory, { ...appCacheOptions(fs), recursive: true });
    await fs.writeFile(paths.body, body, appCacheOptions(fs));
    await fs.writeTextFile(paths.metadata, JSON.stringify(metadata), appCacheOptions(fs));
    return true;
  } catch {
    return false;
  }
}

export async function matchNativeCacheResponse(key: string): Promise<Response | null> {
  const paths = nativeCachePathsForKey(key);
  if (!paths) return null;
  try {
    const fs = await getFs();
    const options = appCacheOptions(fs);
    if (!(await fs.exists(paths.metadata, options)) || !(await fs.exists(paths.body, options))) {
      return null;
    }
    const metadata = parseMetadata(await fs.readTextFile(paths.metadata, options), key);
    if (!metadata) return null;
    const body = await fs.readFile(paths.body, options);
    if (body.byteLength !== metadata.size) {
      void Promise.all([
        removeFileQuietly(fs, paths.body),
        removeFileQuietly(fs, paths.metadata),
      ]);
      return null;
    }
    return new Response(body, {
      status: metadata.status,
      statusText: metadata.statusText,
      headers: metadata.headers,
    });
  } catch {
    return null;
  }
}

export async function touchNativeCacheResponse(key: string, accessedAt: number): Promise<void> {
  const paths = nativeCachePathsForKey(key);
  if (!paths) return;
  try {
    const fs = await getFs();
    const options = appCacheOptions(fs);
    const metadata = parseMetadata(await fs.readTextFile(paths.metadata, options), key);
    if (!metadata) return;
    metadata.headers['x-moke-cache-accessed'] = String(accessedAt);
    await fs.writeTextFile(paths.metadata, JSON.stringify(metadata), options);
  } catch {
    // LRU metadata is best effort and must not delay or break a cache hit.
  }
}

export async function getNativeCacheEntries(): Promise<MokeNativeCacheEntry[] | null> {
  try {
    const fs = await getFs();
    const options = appCacheOptions(fs);
    if (!(await fs.exists(CACHE_ROOT, options))) return [];

    const entries: MokeNativeCacheEntry[] = [];
    for (const kind of ['api', 'image'] as const) {
      const directory = `${CACHE_ROOT}/${kind}`;
      if (!(await fs.exists(directory, options))) continue;
      for (const entry of await fs.readDir(directory, options)) {
        if (!entry.isFile || !/^[0-9a-f]{16}\.json$/.test(entry.name)) continue;
        try {
          const metadataPath = `${directory}/${entry.name}`;
          const metadata = parseMetadata(await fs.readTextFile(metadataPath, options));
          if (!metadata) continue;
          const expectedPaths = nativeCachePathsForKey(metadata.key);
          if (
            !expectedPaths ||
            expectedPaths.kind !== kind ||
            expectedPaths.metadata !== metadataPath ||
            !(await fs.exists(expectedPaths.body, options))
          ) {
            continue;
          }
          const headerKind = metadata.headers['x-moke-cache-kind'];
          if (headerKind !== kind) continue;
          const accessedAt = Number(metadata.headers['x-moke-cache-accessed'] || 0);
          const tags = (metadata.headers['x-moke-cache-tags'] || '').split(',').filter(Boolean);
          entries.push({
            key: metadata.key,
            kind,
            size: metadata.size,
            accessedAt: Number.isFinite(accessedAt) ? accessedAt : 0,
            tags,
          });
        } catch {
          // One interrupted entry must not hide the rest of the cache from stats or LRU.
        }
      }
    }
    return entries;
  } catch {
    return null;
  }
}

export async function deleteNativeCacheKeys(keys: Iterable<string>): Promise<void> {
  let fs: FsModule;
  try {
    fs = await getFs();
  } catch {
    return;
  }
  for (const key of keys) {
    const paths = nativeCachePathsForKey(key);
    if (!paths) continue;
    await Promise.all([
      removeFileQuietly(fs, paths.body),
      removeFileQuietly(fs, paths.metadata),
    ]);
  }
}

export async function clearNativeCache(kind?: MokeNativeCacheKind): Promise<boolean> {
  try {
    const fs = await getFs();
    const options = appCacheOptions(fs);
    const target = kind ? `${CACHE_ROOT}/${kind}` : CACHE_ROOT;
    if (await fs.exists(target, options)) {
      await fs.remove(target, { ...options, recursive: true });
    }
    return true;
  } catch {
    return false;
  }
}
