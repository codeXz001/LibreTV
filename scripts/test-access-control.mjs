// 访问控制回归测试：内置双密码配置、资源采集站源与分类、按模式过滤与源隔离
// 用法: node --test scripts/test-access-control.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadConfig() {
  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() { return { rel: '', href: '', crossOrigin: '', appendChild() {}, classList: { add() {}, remove() {} } }; },
      head: { appendChild() {} },
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(join(root, 'js/config.js'), 'utf8'), sandbox, { filename: 'js/config.js' });
  return sandbox.window;
}

function loadHome({ isAdmin = false, yellowFilterEnabled = 'true' } = {}) {
  const storageMap = new Map([['yellowFilterEnabled', yellowFilterEnabled]]);
  const storage = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); },
    removeItem(k) { storageMap.delete(k); },
  };
  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelectorAll() { return []; },
    },
    IntersectionObserver: class {},
    localStorage: storage,
    IMG_TRANSPARENT: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    HOME_CATEGORIES: [],
    HOME_CONFIG: { hotStripLimit: 12, pageSize: 24, concurrency: 4, sourceTimeout: 7000 },
    HOME_RESOURCE_NAV: [],
    BANNED_TYPE_NAMES: ['伦理片', '福利'],
    selectedAPIs: ['ffzy', 'xrbsp'],
    API_SITES: {
      ffzy: { api: 'https://example.com/api', name: '测试源' },
      xrbsp: { api: 'https://www.xrbsp.com/api/json.php', name: '淫水机资源', adult: true },
    },
    aggregateItemMap: new Map(),
    normalizeTitle(name) { return String(name || '').toLowerCase().replace(/\s+/g, ''); },
    mapLimit: async (items, limit, fn) => Promise.all(items.map(fn)),
    getCustomApiInfo() { return null; },
    isAdminMode() { return isAdmin; },
    console,
  };
  sandbox.window.isAdminMode = () => isAdmin;
  sandbox.window.ACCESS_PASSWORD_CONFIG = sandbox.ACCESS_PASSWORD_CONFIG || null;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(join(root, 'js/home.js'), 'utf8'), sandbox, { filename: 'js/home.js' });
  return sandbox;
}

test('config.js: 内置双密码配置存在且为 999999 / 147258', () => {
  const win = loadConfig();
  assert.equal(win.ACCESS_PASSWORD_CONFIG.builtinUserPassword, '999999');
  assert.equal(win.ACCESS_PASSWORD_CONFIG.builtinAdminPassword, '147258');
});

test('config.js: 资源采集站源带 adult:true 标记', () => {
  const win = loadConfig();
  const adultKeys = Object.keys(win.API_SITES).filter(k => win.API_SITES[k].adult);
  assert.ok(adultKeys.length >= 10, '应保留 10 个实测通过的资源采集站源');
  assert.ok(adultKeys.includes('xrbsp') && adultKeys.includes('ddapi'));
  // 普通源不带 adult 标记
  assert.ok(!win.API_SITES.ffzy.adult);
});

test('config.js: 首页分类包含资源采集站分类', () => {
  const win = loadConfig();
  const adultCat = win.HOME_CATEGORIES.find(c => c.id === 'adult');
  assert.ok(adultCat, 'HOME_CATEGORIES 应包含 adult 分类');
  assert.equal(adultCat.name, '资源采集站');
});

test('home.js: 普通模式过滤强制开启，管理员模式按设置', () => {
  const normal = loadHome({ isAdmin: false, yellowFilterEnabled: 'false' });
  assert.equal(normal.isYellowFilterActive(), true, '普通模式即使 localStorage 关闭也强制过滤');

  const adminOff = loadHome({ isAdmin: true, yellowFilterEnabled: 'false' });
  assert.equal(adminOff.isYellowFilterActive(), false, '管理员模式可关闭过滤');

  const adminOn = loadHome({ isAdmin: true, yellowFilterEnabled: 'true' });
  assert.equal(adminOn.isYellowFilterActive(), true, '管理员模式可开启过滤');
});

test('home.js: 资源采集站分类只拉 adult 源，普通分类排除 adult 源', () => {
  const sb = loadHome();
  assert.equal(JSON.stringify(sb.getHomeSourceIds('adult')), '["xrbsp"]');
  assert.equal(JSON.stringify(sb.getHomeSourceIds('tv')), '["ffzy"]');
});

test('home.js: mergeAndFilter 对资源采集站分类跳过过滤', () => {
  const sb = loadHome({ isAdmin: true, yellowFilterEnabled: 'true' });
  const rawAdult = { list: [{ vod_name: '示例', type_name: '伦理片', vod_id: 1, source_code: 'xrbsp' }] };
  const merged = sb.mergeAndFilter([rawAdult], true); // skipYellow
  assert.equal(merged.length, 1, 'skipYellow 时伦理片不被过滤');

  // 资源站源的内容始终不被敏感过滤拦截（管理员模式）
  const adultKept = sb.mergeAndFilter([rawAdult], false);
  assert.equal(adultKept.length, 1, '资源站源内容不被敏感过滤');

  // 普通源的内容仍受敏感过滤控制（未 skipYellow 时被过滤）
  const rawNormal = { list: [{ vod_name: '示例', type_name: '伦理片', vod_id: 2, source_code: 'ffzy' }] };
  const filtered = sb.mergeAndFilter([rawNormal], false);
  assert.equal(filtered.length, 0, '普通源伦理片在未 skipYellow 时被过滤');
});

test('内置密码哈希与明文匹配', async () => {
  const h = (s) => createHash('sha256').update(s).digest('hex');
  const win = loadConfig();
  const userHash = h(win.ACCESS_PASSWORD_CONFIG.builtinUserPassword);
  const adminHash = h(win.ACCESS_PASSWORD_CONFIG.builtinAdminPassword);
  assert.equal(userHash.length, 64);
  assert.equal(adminHash.length, 64);
  assert.notEqual(userHash, adminHash, '两套密码哈希必须不同');
});

test('password.js: 部署端 PASSWORD 已注入, ADMIN_PASSWORD 未注入, 内置 147258 兜底', async () => {
  const { loadPasswordRuntime } = await import('./_password-runtime-loader.mjs');
  const win = await loadPasswordRuntime({
    envUserHash: createHash('sha256').update('custom-user-pass').digest('hex'),
    envAdminHash: '',
    storage: new Map(),
  });
  const entries = win.getConfiguredPasswordEntries();
  const userHash = createHash('sha256').update('999999').digest('hex');
  const adminHash = createHash('sha256').update('147258').digest('hex');
  assert.equal(entries.length, 2, '应同时有用户和管理员两项');
  assert.ok(entries.find(e => e.role === 'user' && e.hash !== userHash),
    '用户密码哈希应为部署端 PASSWORD,不是内置 999999');
  assert.ok(entries.find(e => e.role === 'admin' && e.hash === adminHash),
    '管理员密码哈希应为内置 147258');

  assert.equal(await win.verifyPassword('custom-user-pass'), true);
  assert.equal(win.getAccessMode(), 'user');
  assert.equal(await win.verifyPassword('147258'), true);
  assert.equal(win.getAccessMode(), 'admin');
  assert.equal(await win.verifyPassword('999999'), false,
    '999999 不在 entries 里时应被拒');
  assert.equal(await win.verifyPassword('wrong-password'), false);
});

test('password.js: ADMIN_PASSWORD 环境变量可覆盖内置 147258', async () => {
  const { loadPasswordRuntime } = await import('./_password-runtime-loader.mjs');
  const customAdmin = createHash('sha256').update('super-admin').digest('hex');
  const win = await loadPasswordRuntime({
    envUserHash: '',
    envAdminHash: customAdmin,
    storage: new Map(),
  });
  const adminHash = createHash('sha256').update('147258').digest('hex');
  const userHash = createHash('sha256').update('999999').digest('hex');
  const entries = win.getConfiguredPasswordEntries();
  assert.ok(entries.find(e => e.role === 'admin' && e.hash === customAdmin));
  assert.equal(entries.find(e => e.hash === adminHash), undefined);
  assert.equal(await win.verifyPassword('super-admin'), true);
  assert.equal(win.getAccessMode(), 'admin');
  assert.equal(await win.verifyPassword('147258'), false);
  assert.equal(await win.verifyPassword('999999'), true, '内置 999999 仍可登录');
  assert.equal(win.getAccessMode(), 'user');
});

test('password.js: 用户与管理员密码哈希相同时, 仅授予用户身份', async () => {
  const { loadPasswordRuntime } = await import('./_password-runtime-loader.mjs');
  const sameHash = createHash('sha256').update('overlap').digest('hex');
  const win = await loadPasswordRuntime({
    envUserHash: sameHash,
    envAdminHash: sameHash,
    storage: new Map(),
  });
  const entries = win.getConfiguredPasswordEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].role, 'user');
  assert.equal(await win.verifyPassword('overlap'), true);
  assert.equal(win.getAccessMode(), 'user');
});
