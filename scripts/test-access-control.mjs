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
  const sandbox = { window: {} };
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
  assert.deepEqual(sb.getHomeSourceIds('adult'), ['xrbsp']);
  assert.deepEqual(sb.getHomeSourceIds('tv'), ['ffzy']);
});

test('home.js: mergeAndFilter 对资源采集站分类跳过过滤', () => {
  const sb = loadHome({ isAdmin: true, yellowFilterEnabled: 'true' });
  const raw = { list: [{ vod_name: '示例', type_name: '伦理片', vod_id: 1, source_code: 'xrbsp' }] };
  const merged = sb.mergeAndFilter([raw], true); // skipYellow
  assert.equal(merged.length, 1, 'skipYellow 时伦理片不被过滤');

  const filtered = sb.mergeAndFilter([raw], false);
  assert.equal(filtered.length, 0, '未 skipYellow 时伦理片被过滤');
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
