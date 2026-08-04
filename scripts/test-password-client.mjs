// 浏览器端双密码角色状态测试
// 覆盖：内置固定密码(999999 普通 / 147258 管理员)、环境变量优先级、角色判定
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';

class MemoryStorage {
  #data = new Map();
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null; }
  setItem(key, value) { this.#data.set(key, String(value)); }
  removeItem(key) { this.#data.delete(key); }
}

const sha256SyncFn = (msg) => createHash('sha256').update(String(msg)).digest('hex');
const sha256Hex = async (msg) => sha256SyncFn(msg);

function createContext({ env = {}, builtin = true, accessMode = '' } = {}) {
  const localStorage = new MemoryStorage();
  if (accessMode) localStorage.setItem('accessMode', accessMode);
  const window = {
    __ENV__: { ...env },
    ACCESS_PASSWORD_CONFIG: builtin
      ? {
          builtinUserPassword: '999999',
          builtinAdminPassword: '147258',
          envUserKey: 'PASSWORD',
          envAdminKey: 'ADMIN_PASSWORD',
        }
      : null,
    _jsSha256: sha256SyncFn,
    crypto: webcrypto,
    addEventListener() {},
  };
  const document = {
    addEventListener() {},
    getElementById() { return null; },
  };
  const context = vm.createContext({
    window,
    document,
    localStorage,
    crypto: webcrypto,
    TextEncoder,
    console,
    Date,
    setTimeout,
    clearTimeout,
  });
  const config = 'const PASSWORD_CONFIG = { localStorageKey: \'passwordVerified\', verificationTTL: 90 * 24 * 60 * 60 * 1000 };';
  const passwordSource = fs.readFileSync(new URL('../js/password.js', import.meta.url), 'utf8');
  vm.runInContext(`${config}\n${passwordSource}`, context);
  return { window, localStorage };
}

// —— 场景 1：仅内置密码（未配置任何环境变量）——
{
  const { window, localStorage } = createContext();
  assert.equal(window.isPasswordProtected(), true, '内置密码应启用保护');
  assert.equal(window.isPasswordVerified(), false);

  assert.equal(await window.verifyPassword('147258'), true, '内置管理员密码应验证通过');
  assert.equal(window.getAccessMode(), 'admin', '147258 应为管理员模式');
  assert.equal(window.isAdminMode(), true);

  localStorage.removeItem('passwordVerified');
  localStorage.removeItem('accessMode');
  assert.equal(await window.verifyPassword('999999'), true, '内置普通密码应验证通过');
  assert.equal(window.getAccessMode(), 'user', '999999 应为普通模式');
  assert.equal(window.isAdminMode(), false);

  assert.equal(await window.verifyPassword('wrong-password'), false, '错误密码应拒绝');
}

// —— 场景 2：环境变量 PASSWORD 已配置，ADMIN_PASSWORD 未配置 ——
// 用户部署端只设了 PASSWORD（如 =999999），147258 仍应通过内置密码进入管理员模式
{
  const envUserHash = await sha256Hex('999999');
  const { window } = createContext({ env: { PASSWORD: envUserHash } });
  assert.equal(await window.verifyPassword('999999'), true, '环境变量普通密码应验证通过');
  assert.equal(window.getAccessMode(), 'user');
  assert.equal(await window.verifyPassword('147258'), true, '内置管理员密码兜底生效');
  assert.equal(window.getAccessMode(), 'admin', '147258 应进入管理员模式');
}

// —— 场景 3：环境变量两套都配置 ——
{
  const envUserHash = await sha256Hex('env-user');
  const envAdminHash = await sha256Hex('env-admin');
  const { window } = createContext({
    env: { PASSWORD: envUserHash, ADMIN_PASSWORD: envAdminHash },
  });
  assert.equal(await window.verifyPassword('env-user'), true);
  assert.equal(window.getAccessMode(), 'user');
  assert.equal(await window.verifyPassword('env-admin'), true);
  assert.equal(window.getAccessMode(), 'admin');
  assert.equal(await window.verifyPassword('999999'), false, '环境变量已配置时内置密码不生效');
  assert.equal(await window.verifyPassword('147258'), false);
}

// —— 场景 4：两套环境变量误配为同一密码时不授予管理员模式 ——
{
  const same = await sha256Hex('same-password');
  const { window } = createContext({ env: { PASSWORD: same, ADMIN_PASSWORD: same } });
  assert.equal(await window.verifyPassword('same-password'), true);
  assert.equal(window.getAccessMode(), 'user', '同一密码只授予普通模式');
}

console.log('浏览器端双密码角色状态测试通过');
