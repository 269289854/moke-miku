import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authenticationFallbackDestination,
  clearDeviceCredential,
  loadDeviceCredential,
  normalizeServerOrigin,
  storeDeviceCredential,
} from '../src/lib/device-auth.ts';

const token = `moke_tk1_${'a'.repeat(12)}_${'b'.repeat(43)}`;

test('设备密钥按服务器作用域保存，Web/鸿蒙式会话存储不写本地明文', async () => {
  const server = 'HTTPS://Books.Example:443/path/';
  const storage = await storeDeviceCredential(server, {
    apiKey: token,
    accountUsername: 'reader',
    keyInfo: null,
  }, false);

  assert.equal(storage, 'session');
  assert.deepEqual(await loadDeviceCredential('https://books.example'), {
    serverOrigin: 'https://books.example',
    apiKey: token,
    accountUsername: 'reader',
    keyInfo: null,
  });
  assert.equal(await loadDeviceCredential('https://other.example'), null);
  await clearDeviceCredential(server);
  assert.equal(await loadDeviceCredential(server), null);
});

test('服务器地址规范化并按历史账号选择认证回退页', () => {
  assert.equal(normalizeServerOrigin('https://Books.Example:443/library/'), 'https://books.example');
  assert.equal(authenticationFallbackDestination(true), '/login');
  assert.equal(authenticationFallbackDestination(false), '/access');
});
