import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRecoveryContextCurrent,
  responseNeedsSessionRecovery,
  SessionRecoveryCoordinator,
} from '../src/lib/session-recovery.ts';

test('切换服务器、账号或重新登录后旧续期不能再提交状态', () => {
  const user = { id: 1, username: 'reader' };
  const started = { serverUrl: 'https://books.example', user };
  assert.equal(isRecoveryContextCurrent(started, { ...started }), true);
  assert.equal(isRecoveryContextCurrent(started, { ...started, serverUrl: 'https://other.example' }), false);
  assert.equal(isRecoveryContextCurrent(started, { ...started, user: null }), false);
  assert.equal(isRecoveryContextCurrent(started, { ...started, user: { ...user } }), false);
  assert.equal(isRecoveryContextCurrent(started, {
    ...started, user: { id: 2, username: 'other' },
  }), false);
});

test('认证失败响应触发续期，认证端点自身不会递归续期', async () => {
  const invited = new Response(JSON.stringify({ err: 'not_invited' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const login = new Response(JSON.stringify({ err: 'user.need_login' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  assert.equal(await responseNeedsSessionRecovery(invited, 'https://books.example/api/library'), true);
  assert.equal(await responseNeedsSessionRecovery(login, 'https://books.example/api/book/448/readstate'), true);
  assert.equal(
    await responseNeedsSessionRecovery(login, 'https://books.example/api/user/api_key/sign_in'),
    false,
  );
});

test('HTTP 401 触发续期，普通错误和非 JSON 响应不触发', async () => {
  assert.equal(
    await responseNeedsSessionRecovery(new Response('', { status: 401 }), 'https://books.example/api/book/448.epub'),
    true,
  );
  assert.equal(
    await responseNeedsSessionRecovery(
      new Response(JSON.stringify({ err: 'permission' }), { headers: { 'content-type': 'application/json' } }),
      'https://books.example/api/library',
    ),
    false,
  );
  assert.equal(
    await responseNeedsSessionRecovery(new Response('not invited'), 'https://books.example/api/library'),
    false,
  );
});

test('同一服务器的并发续期合并为一次，完成后允许下一轮', async () => {
  const coordinator = new SessionRecoveryCoordinator();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const recover = async () => {
    calls += 1;
    await gate;
    return 'recovered';
  };

  const first = coordinator.run('https://books.example', recover);
  const second = coordinator.run('https://books.example', recover);
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'recovered');

  assert.equal(await coordinator.run('https://books.example', recover), 'recovered');
  assert.equal(calls, 2);
});
