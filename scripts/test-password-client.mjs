// 浏览器端双密码角色状态测试
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { sha256Hex } from '../proxy-core/auth.mjs';

class MemoryStorage {
  #data = new Map();
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null; }
  setItem(key, value) { this.#data.set(key, String(value)); }
  removeItem(key) { this.#data.delete(key); }
}

const normalHash = await sha256Hex('normal-password-for-test');
const adminHash = await sha256Hex('admin-password-for-test');
const localStorage = new MemoryStorage();
const window = {
  __ENV__: { PASSWORD: normalHash, ADMIN_PASSWORD: adminHash },
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

assert.equal(window.isPasswordProtected(), true);
assert.equal(window.isPasswordVerified(), false);
assert.equal(await window.verifyPassword('admin-password-for-test'), true);
assert.equal(window.getAccessMode(), 'admin');
assert.equal(window.isAdminMode(), true);

localStorage.removeItem('passwordVerified');
localStorage.removeItem('accessMode');
assert.equal(await window.verifyPassword('normal-password-for-test'), true);
assert.equal(window.getAccessMode(), 'user');
assert.equal(window.isAdminMode(), false);
assert.equal(await window.verifyPassword('wrong-password'), false);

console.log('浏览器端双密码角色状态测试通过');
