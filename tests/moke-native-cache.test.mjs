import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __setMokeNativeCacheFsForTests,
  clearNativeCache,
  deleteNativeCacheKeys,
  getNativeCacheEntries,
  matchNativeCacheResponse,
  nativeCachePathsForKey,
  putNativeCacheResponse,
  touchNativeCacheResponse,
} from '../src/lib/moke-native-cache.ts';

function createMemoryFs() {
  const files = new Map();
  const directories = new Set();
  const normalize = (path) => String(path).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const ensureParents = (path) => {
    const parts = normalize(path).split('/').filter(Boolean);
    for (let index = 1; index <= parts.length; index++) {
      directories.add(parts.slice(0, index).join('/'));
    }
  };

  return {
    BaseDirectory: { AppCache: 1 },
    async mkdir(path) {
      ensureParents(path);
    },
    async exists(path) {
      const key = normalize(path);
      return files.has(key) || directories.has(key);
    },
    async writeFile(path, data) {
      const key = normalize(path);
      ensureParents(key.split('/').slice(0, -1).join('/'));
      files.set(key, new Uint8Array(data).slice());
    },
    async writeTextFile(path, text) {
      const key = normalize(path);
      ensureParents(key.split('/').slice(0, -1).join('/'));
      files.set(key, new TextEncoder().encode(text));
    },
    async readFile(path) {
      const data = files.get(normalize(path));
      if (!data) throw new Error('missing file');
      return data.slice();
    },
    async readTextFile(path) {
      const data = files.get(normalize(path));
      if (!data) throw new Error('missing file');
      return new TextDecoder().decode(data);
    },
    async readDir(path) {
      const directory = normalize(path);
      const prefix = `${directory}/`;
      const names = new Map();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const remainder = key.slice(prefix.length);
        const [name, ...rest] = remainder.split('/');
        names.set(name, rest.length > 0 ? 'directory' : 'file');
      }
      for (const key of directories) {
        if (!key.startsWith(prefix)) continue;
        const remainder = key.slice(prefix.length);
        if (!remainder) continue;
        const [name, ...rest] = remainder.split('/');
        if (rest.length > 0 || !files.has(`${prefix}${name}`)) names.set(name, 'directory');
      }
      return [...names].map(([name, type]) => ({
        name,
        isDirectory: type === 'directory',
        isFile: type === 'file',
        isSymlink: false,
      }));
    },
    async remove(path, options = {}) {
      const key = normalize(path);
      if (options.recursive) {
        for (const file of [...files.keys()]) {
          if (file === key || file.startsWith(`${key}/`)) files.delete(file);
        }
        for (const directory of [...directories]) {
          if (directory === key || directory.startsWith(`${key}/`)) directories.delete(directory);
        }
        return;
      }
      if (!files.delete(key) && !directories.delete(key)) throw new Error('missing path');
    },
  };
}

test('原生缓存路径只接受不透明的版本化 API 和图片键', () => {
  assert.deepEqual(
    nativeCachePathsForKey('https://moke-cache.invalid/v2/api/0123456789abcdef'),
    {
      kind: 'api',
      directory: 'moke-http-cache/v2/api',
      body: 'moke-http-cache/v2/api/0123456789abcdef.body',
      metadata: 'moke-http-cache/v2/api/0123456789abcdef.json',
    },
  );
  assert.equal(nativeCachePathsForKey('https://moke-cache.invalid/v2/api/../outside'), null);
  assert.equal(nativeCachePathsForKey('https://books.test/v2/api/0123456789abcdef'), null);
  assert.equal(
    nativeCachePathsForKey('https://moke-cache.invalid/v2/api/0123456789abcdef?token=x'),
    null,
  );
  assert.equal(nativeCachePathsForKey('https://moke-cache.invalid/v2/other/0123456789abcdef'), null);
});

test('原生缓存贯通写入、读取、统计、触碰、删除和清理', async () => {
  const fs = createMemoryFs();
  __setMokeNativeCacheFsForTests(fs);
  const apiKey = 'https://moke-cache.invalid/v2/api/0123456789abcdef';
  const imageKey = 'https://moke-cache.invalid/v2/image/fedcba9876543210';

  assert.equal(
    await putNativeCacheResponse(
      apiKey,
      new Response('api', {
        headers: {
          'content-type': 'application/json',
          'x-moke-cache-kind': 'api',
          'x-moke-cache-accessed': '100',
          'x-moke-cache-tags': 'scope-tag',
          'x-moke-cache-size': '3',
        },
      }),
    ),
    true,
  );
  assert.equal(
    await putNativeCacheResponse(
      imageKey,
      new Response('image', {
        headers: {
          'content-type': 'image/jpeg',
          'x-moke-cache-kind': 'image',
          'x-moke-cache-accessed': '200',
          'x-moke-cache-size': '5',
        },
      }),
    ),
    true,
  );

  assert.equal(await (await matchNativeCacheResponse(apiKey)).text(), 'api');
  assert.deepEqual(await getNativeCacheEntries(), [
    { key: apiKey, kind: 'api', size: 3, accessedAt: 100, tags: ['scope-tag'] },
    { key: imageKey, kind: 'image', size: 5, accessedAt: 200, tags: [] },
  ]);

  await touchNativeCacheResponse(apiKey, 300);
  assert.equal((await getNativeCacheEntries())[0].accessedAt, 300);
  await deleteNativeCacheKeys([apiKey]);
  assert.equal(await matchNativeCacheResponse(apiKey), null);
  assert.deepEqual(await getNativeCacheEntries(), [
    { key: imageKey, kind: 'image', size: 5, accessedAt: 200, tags: [] },
  ]);
  assert.equal(await clearNativeCache(), true);
  assert.deepEqual(await getNativeCacheEntries(), []);
  __setMokeNativeCacheFsForTests(null);
});

test('原生缓存目录删除失败时明确返回失败', async () => {
  const fs = createMemoryFs();
  __setMokeNativeCacheFsForTests(fs);
  const key = 'https://moke-cache.invalid/v2/api/0123456789abcdef';
  assert.equal(
    await putNativeCacheResponse(
      key,
      new Response('api', {
        headers: {
          'x-moke-cache-kind': 'api',
          'x-moke-cache-accessed': '100',
        },
      }),
    ),
    true,
  );
  fs.remove = async () => {
    throw new Error('remove-failed');
  };

  assert.equal(await clearNativeCache(), false);
  __setMokeNativeCacheFsForTests(null);
});
