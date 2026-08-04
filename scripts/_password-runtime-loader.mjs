// 浏览器端运行时加载器：按真实页面顺序加载 sha256.min.js → config.js → password.js
// 用法: const { loadPasswordRuntime } = await import('./_password-runtime-loader.mjs');
import vm from 'node:vm';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function createStorage(initial) {
  const map = new Map();
  if (initial) for (const [k, v] of initial.entries()) map.set(k, v);
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

export async function loadPasswordRuntime({ envUserHash, envAdminHash, storage: storageInitial }) {
  const sha256Lib = fs.readFileSync(join(root, 'libs/sha256.min.js'), 'utf8');
  const config = fs.readFileSync(join(root, 'js/config.js'), 'utf8');
  const psw = fs.readFileSync(join(root, 'js/password.js'), 'utf8');

  const storage = createStorage(storageInitial);
  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() { return { rel:'', href:'', crossOrigin:'', appendChild(){}, classList:{ add(){}, remove(){} } }; },
      head: { appendChild() {} },
    },
    console,
    crypto: webcrypto,
    localStorage: storage,
    Date,
    setTimeout,
    clearTimeout,
    TextEncoder: NodeTextEncoder,
    TextDecoder: NodeTextDecoder,
  };
  sandbox.window.crypto = webcrypto;
  sandbox.window.TextEncoder = NodeTextEncoder;
  sandbox.window.TextDecoder = NodeTextDecoder;
  sandbox.window.__ENV__ = {};
  if (envUserHash) sandbox.window.__ENV__.PASSWORD = envUserHash;
  if (envAdminHash) sandbox.window.__ENV__.ADMIN_PASSWORD = envAdminHash;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(sha256Lib, ctx, { filename: 'libs/sha256.min.js' });
  vm.runInContext(config, ctx, { filename: 'js/config.js' });
  // config.js 已经声明了 PASSWORD_CONFIG,这里直接加载 password.js 即可。
  vm.runInContext(psw, ctx, { filename: 'js/password.js' });
  return sandbox.window;
}