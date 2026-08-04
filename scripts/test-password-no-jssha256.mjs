// 浏览器端密码回归测试 - 防止 SW 缓存导致密码失效
// 模拟场景: js-sha256 库加载失败(老 SW 缓存命中了破损的 sha256.min.js),
// 验证仍可通过 Web Crypto API 完成内置密码验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadWithoutSyncSha256Lib({ envUserHash = '', envAdminHash = '', storage = new Map() } = {}) {
  const config = fs.readFileSync(join(root, 'js/config.js'), 'utf8');
  const psw = fs.readFileSync(join(root, 'js/password.js'), 'utf8');
  const storageMap = new Map(storage);
  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() { return {}; },
      head: { appendChild() {} },
    },
    console,
    crypto: webcrypto,
    localStorage: {
      getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
      setItem(k, v) { storageMap.set(k, String(v)); },
      removeItem(k) { storageMap.delete(k); },
    },
    Date,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
  };
  sandbox.window.crypto = webcrypto;
  sandbox.window.TextEncoder = TextEncoder;
  sandbox.window.TextDecoder = TextDecoder;
  sandbox.window.__ENV__ = {};
  if (envUserHash) sandbox.window.__ENV__.PASSWORD = envUserHash;
  if (envAdminHash) sandbox.window.__ENV__.ADMIN_PASSWORD = envAdminHash;
  const ctx = vm.createContext(sandbox);
  // 故意跳过 libs/sha256.min.js,模拟 SW 缓存破损 / 加载失败
  vm.runInContext(config, ctx, { filename: 'js/config.js' });
  vm.runInContext(psw, ctx, { filename: 'js/password.js' });
  return sandbox.window;
}

test('password.js: js-sha256 缺失时, 仍能通过 Web Crypto 验证内置 999999 / 147258', async () => {
  const win = loadWithoutSyncSha256Lib({
    envUserHash: '',
    envAdminHash: '',
  });
  // 同步路径不可用(没有 js-sha256):
  // - window._jsSha256: undefined
  // - sha256Sync(): 必须返回 null(从 window 看就是 undefined)
  assert.equal(win._jsSha256, undefined);
  assert.equal(win.sha256Sync?.('test') ?? null, null);
  // password.js 内部声明了 sha256(异步 Web Crypto),所以 window.sha256 是函数。
  assert.equal(typeof win.sha256, 'function');
  // entries 应借助异步预算填充
  for (let i = 0; i < 50; i++) {
    if (win.getConfiguredPasswordEntries().length > 0) break;
    await new Promise(r => setTimeout(r, 20));
  }
  const entries = win.getConfiguredPasswordEntries();
  assert.equal(entries.length, 2, 'js-sha256 缺失下,内置密码仍应有 2 个条目');
  const userHash = await win.sha256('999999');
  const adminHash = await win.sha256('147258');
  assert.ok(entries.find(e => e.role === 'user' && e.hash === userHash),
    '用户条目哈希应等于 999999 的 Web Crypto 哈希');
  assert.ok(entries.find(e => e.role === 'admin' && e.hash === adminHash),
    '管理员条目哈希应等于 147258 的 Web Crypto 哈希');

  // 验证流程端到端
  assert.equal(await win.verifyPassword('999999'), true);
  assert.equal(win.getAccessMode(), 'user');
  assert.equal(await win.verifyPassword('147258'), true);
  assert.equal(win.getAccessMode(), 'admin');
  assert.equal(await win.verifyPassword('wrong'), false);
});