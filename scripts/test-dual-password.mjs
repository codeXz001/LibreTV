// 双密码配置与代理鉴权回归测试
import assert from 'node:assert/strict';
import { sha256Hex, validateAuth } from '../proxy-core/auth.mjs';
import { injectPasswordConfig } from '../inject-env-core/inject.mjs';

const normalPassword = 'normal-password-for-test';
const adminPassword = 'admin-password-for-test';
const normalHash = await sha256Hex(normalPassword);
const adminHash = await sha256Hex(adminPassword);
const now = Date.now();

assert.equal(
  injectPasswordConfig(
    'window.__ENV__.PASSWORD = "{{PASSWORD}}"; window.__ENV__.ADMIN_PASSWORD = "{{ADMIN_PASSWORD}}";',
    normalHash,
    adminHash
  ),
  `window.__ENV__.PASSWORD = "${normalHash}"; window.__ENV__.ADMIN_PASSWORD = "${adminHash}";`
);

assert.equal(
  await validateAuth({
    authHash: normalHash,
    timestamp: String(now),
    serverPassword: normalPassword,
    alternatePasswords: [adminPassword],
  }),
  true,
  '普通密码应通过代理鉴权'
);

assert.equal(
  await validateAuth({
    authHash: adminHash,
    timestamp: String(now),
    serverPassword: normalPassword,
    alternatePasswords: [adminPassword],
  }),
  true,
  '管理员密码应通过代理鉴权'
);

assert.equal(
  await validateAuth({
    authHash: await sha256Hex('wrong-password'),
    timestamp: String(now),
    serverPassword: normalPassword,
    alternatePasswords: [adminPassword],
  }),
  false,
  '错误密码不得通过代理鉴权'
);

assert.equal(
  await validateAuth({
    authHash: normalHash,
    timestamp: String(now - 10 * 60 * 1000 - 1),
    serverPassword: normalPassword,
    alternatePasswords: [adminPassword],
  }),
  false,
  '过期时间戳不得通过代理鉴权'
);

assert.equal(
  await validateAuth({ authHash: null, timestamp: null, serverPassword: '', alternatePasswords: [] }),
  true,
  '未配置密码时应保持无密码兼容模式'
);

console.log('双密码配置与代理鉴权测试通过');
