import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scriptPath = new URL('../vendor/tauri/crates/tauri/scripts/android-legacy-ipc.js', import.meta.url);
const managerPath = new URL('../vendor/tauri/crates/tauri/src/manager/webview.rs', import.meta.url);

function renderedScript() {
  return fs.readFileSync(scriptPath, 'utf8')
    .replace('__TEMPLATE_invoke_key__', JSON.stringify('test-invoke-key'))
    .replace('__TEMPLATE_protocol_scheme__', JSON.stringify('http'));
}

test('Android legacy IPC bridge keeps ES5-compatible syntax', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.doesNotMatch(source, /=>|\bconst\b|\blet\b|\?\.|\?\?|\.\.\./);
});

test('Android legacy IPC bridge sends commands and resolves callbacks', async () => {
  const messages = [];
  const window = {
    __TAURI_INTERNALS__: { plugins: {} },
    ipc: {
      postMessage(message) {
        messages.push(JSON.parse(message));
      },
    },
  };
  const context = vm.createContext({
    ArrayBuffer,
    Map,
    Promise,
    Uint8Array,
    encodeURIComponent,
    JSON,
    Object,
    setTimeout,
    window,
  });

  vm.runInContext(renderedScript(), context);
  const resultPromise = window.__TAURI_INTERNALS__.invoke('plugin:http|fetch', {
    bytes: new Uint8Array([1, 2, 3]),
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].cmd, 'plugin:http|fetch');
  assert.equal(messages[0].__TAURI_INVOKE_KEY__, 'test-invoke-key');
  assert.deepEqual(messages[0].payload.bytes, [1, 2, 3]);

  window.__TAURI_INTERNALS__.runCallback(messages[0].callback, { ok: true });
  assert.deepEqual(await resultPromise, { ok: true });
});

test('standard Tauri initialization can replace every fallback property', () => {
  const window = {
    __TAURI_INTERNALS__: { plugins: {} },
    ipc: { postMessage() {} },
  };
  vm.runInNewContext(renderedScript(), {
    ArrayBuffer,
    Map,
    Promise,
    Uint8Array,
    encodeURIComponent,
    JSON,
    Object,
    setTimeout,
    window,
  });

  for (const name of [
    'convertFileSrc',
    'transformCallback',
    'unregisterCallback',
    'runCallback',
    'callbacks',
    'postMessage',
    'ipc',
    'invoke',
  ]) {
    assert.equal(Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__, name)?.configurable, true);
    assert.doesNotThrow(() => Object.defineProperty(window.__TAURI_INTERNALS__, name, { value: name }));
  }
});

test('legacy bridge is injected before the standard invoke scripts', () => {
  const manager = fs.readFileSync(managerPath, 'utf8');
  const legacyIndex = manager.indexOf('AndroidLegacyIpcJavascript {');
  const standardIndex = manager.indexOf('self.invoke_initialization_script.clone()');
  assert.ok(legacyIndex >= 0);
  assert.ok(standardIndex > legacyIndex);
});
