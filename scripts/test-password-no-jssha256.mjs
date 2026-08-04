// 浏览器端密码回归测试 - 防止 SW 缓存导致密码失效
// 模拟场景: libs/sha256.min.js 库加载失败(老 SW 缓存命中了破损的 sha256.min.js),
// 此时 js/sha256-fallback.js(内联同一实现,独立于 libs/ 目录)提供同步哈希,
// 验证两个内置密码在 libs 资源损坏下仍能登录。
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
  const fallback = fs.readFileSync(join(root, 'js/sha256-fallback.js'), 'utf8');
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
  // 故意跳过 libs/sha256.min.js,模拟 libs 目录 SW 缓存破损 / 加载失败;
  // 但 js/sha256-fallback.js(独立于 libs/)正常加载 —— 与真实页面结构一致
  vm.runInContext(fallback, ctx, { filename: 'js/sha256-fallback.js' });
  vm.runInContext(config, ctx, { filename: 'js/config.js' });
  vm.runInContext(psw, ctx, { filename: 'js/password.js' });
  return sandbox.window;
}

test('password.js: libs/sha256.min.js 缺失时, fallback + Web Crypto 仍能验证内置 999999 / 147258', async () => {
  const win = loadWithoutSyncSha256Lib({
    envUserHash: '',
    envAdminHash: '',
  });
  // libs/sha256.min.js 缺失,但 fallback 提供了同步哈希:
  // - window.sha256: 由 sha256-fallback.js 提供(同步函数,未被 password.js 覆盖)
  assert.equal(typeof win.sha256, 'function');
  // entries 应借助同步预算立即就绪
  const entries0 = win.getConfiguredPasswordEntries();
  assert.equal(entries0.length, 2, 'libs 损坏下,内置密码仍应有 2 个条目');
  const userHash = await win.sha256('999999');
  const adminHash = await win.sha256('147258');
  assert.ok(entries0.find(e => e.role === 'user' && e.hash === userHash),
    '用户条目哈希应等于 999999 的哈希');
  assert.ok(entries0.find(e => e.role === 'admin' && e.hash === adminHash),
    '管理员条目哈希应等于 147258 的哈希');

  // 验证流程端到端
  assert.equal(await win.verifyPassword('999999'), true);
  assert.equal(win.getAccessMode(), 'user');
  assert.equal(await win.verifyPassword('147258'), true);
  assert.equal(win.getAccessMode(), 'admin');
  assert.equal(await win.verifyPassword('wrong'), false);
});