// 默认源与搜索模式行为测试
// 用法: node --test scripts/test-source-mode.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _map: map,
  };
}

function loadEnv({ storage, selectedAPIs, customAPIs = [], defaultSourceId = null, searchMode = 'multi', isAdmin = false } = {}) {
  const cfg = fs.readFileSync(join(root, 'js/config.js'), 'utf8');
  const home = fs.readFileSync(join(root, 'js/home.js'), 'utf8');
  const storageMap = storage._map;
  storageMap.set('selectedAPIs', JSON.stringify(selectedAPIs));
  storageMap.set('customAPIs', JSON.stringify(customAPIs));
  storageMap.set('defaultSourceId', JSON.stringify(defaultSourceId));
  storageMap.set('searchMode', JSON.stringify(searchMode));

  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() { return { rel:'', href:'', crossOrigin:'', appendChild(){}, classList:{ add(){}, remove(){}, toggle(){} } }; },
      head: { appendChild() {} },
    },
    console,
    crypto: webcrypto,
    localStorage: storage,
    Date,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    IntersectionObserver: class {},
    performance: { now: () => 0 },
    isAdminMode: () => isAdmin,
  };
  sandbox.window.crypto = webcrypto;
  sandbox.window.TextEncoder = TextEncoder;
  sandbox.window.TextDecoder = TextDecoder;
  sandbox.window.isAdminMode = () => isAdmin;
  sandbox.window.ACCESS_PASSWORD_CONFIG = { builtinUserPassword: '', builtinAdminPassword: '' };
  sandbox.window.HIDE_BUILTIN_ADULT_APIS = true;
  sandbox.window.HOME_CATEGORIES = [
    { id: 'movie', name: '电影', tags: ['电影'] },
    { id: 'tv', name: '电视剧', tags: ['电视剧'] },
    { id: 'anime', name: '动漫', tags: ['动漫'] },
    { id: 'variety', name: '综艺', tags: ['综艺'] },
  ];
  sandbox.window.HOME_CONFIG = { hotStripLimit: 12, pageSize: 24, concurrency: 4, sourceTimeout: 7000 };
  sandbox.window.HOME_RESOURCE_NAV = [];
  sandbox.window.BANNED_TYPE_NAMES = ['伦理片', '福利'];
  sandbox.window.SEARCH_HISTORY_KEY = 'videoSearchHistory';
  sandbox.window.MAX_HISTORY_ITEMS = 5;
  sandbox.window.PLAYER_CONFIG = { adFilteringStorage: 'adFilteringEnabled' };
  sandbox.window.AGGREGATED_SEARCH_CONFIG = { enabled: true, timeout: 8000, maxResults: 10000, parallelRequests: true, showSourceBadges: true };
  sandbox.window.SITE_CONFIG = {};
  sandbox.window.PROXY_URL = '/proxy/';
  sandbox.window.API_CONFIG = {
    search: { path: '?ac=videolist&wd=', pagePath: '?ac=videolist&wd={query}&pg={page}', maxPages: 50, headers: {} },
    detail: { path: '?ac=videolist&ids=', headers: {} }
  };
  sandbox.window.CUSTOM_API_CONFIG = { adultPropName: 'isAdult' };
  sandbox.window.IMG_TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  sandbox.window.M3U8_PATTERN = new RegExp('\\$https?://[^"\'\\s]+?\\.m3u8', 'g');
  sandbox.window.CUSTOM_PLAYER_URL = 'player.html';
  sandbox.window.addEventListener = () => {};
  sandbox.window.dispatchEvent = () => true;
  sandbox.window.HTMLDivElement = class {};
  sandbox.window.Node = class {};

  const ctx = vm.createContext(sandbox);
  vm.runInContext(cfg, ctx, { filename: 'js/config.js' });
  // 复制一份 app.js 的 source-mode 相关函数到 sandbox 中(避免引入完整 app.js 依赖过重)
  const sourceModeLib = `
    let selectedAPIs = JSON.parse(localStorage.getItem('selectedAPIs') || '[]');
    let customAPIs = JSON.parse(localStorage.getItem('customAPIs') || '[]');
    let searchMode = JSON.parse(localStorage.getItem('searchMode') || '"multi"');
    let defaultSourceId = JSON.parse(localStorage.getItem('defaultSourceId') || 'null');
    window.selectedAPIs = selectedAPIs;
    window.searchMode = searchMode;
    window.defaultSourceId = defaultSourceId;
    window.customAPIs = customAPIs;
    window.API_SITES = (typeof API_SITES !== 'undefined') ? API_SITES : {};
  `;
  vm.runInContext(sourceModeLib, ctx, { filename: 'js/_source-mode-setup.js' });
  // 加载 home.js 的工具函数(只取 getHomeSourceIds / isAdultSource)
  const homeSnippet = home.slice(0, home.indexOf('// 渲染分类 tab 行'));
  vm.runInContext(homeSnippet, ctx, { filename: 'js/home-snippet.js' });

  // 加载 app.js 中的 source-mode 辅助函数
  const appSnippet = extractAppSourceMode();
  vm.runInContext(appSnippet, ctx, { filename: 'js/app-snippet.js' });

  return { sandbox, storage };
}

function extractAppSourceMode() {
  const app = fs.readFileSync(join(root, 'js/app.js'), 'utf8');
  const start = app.indexOf('// —— 默认源与搜索模式工具函数 ——');
  const end = app.indexOf('// 同步搜索模式 UI(radio + 描述文案)');
  if (start < 0 || end < 0) throw new Error('source-mode 工具函数区段未找到');
  // 截取工具函数区 + renderSearchModeUI（renderDefaultSourceSelect 不需要 DOM 元素相关断言）
  let block = app.slice(start, end);
  // 补齐 renderSearchModeUI（带 null DOM 保护）
  block += `
    function renderSearchModeUI() {
      const multi = document.getElementById('searchModeMulti');
      const single = document.getElementById('searchModeSingle');
      if (multi) multi.checked = searchMode === 'multi';
      if (single) single.checked = searchMode === 'single';
    }
    function renderDefaultSourceSelect() {
      const select = document.getElementById('defaultSourceSelect');
      if (!select) return;
      const effective = getEffectiveDefaultSourceId();
      const normals = (Array.isArray(selectedAPIs) ? selectedAPIs : []).filter(id => isNormalSource(id));
      select.innerHTML = '';
      if (!normals.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '请先选择普通资源源';
        select.appendChild(opt);
        select.disabled = true;
        return;
      }
      select.disabled = false;
      for (const id of normals) {
        const opt = document.createElement('option');
        opt.value = id;
        const info = (id.startsWith('custom_') ? (customAPIs[Number(id.slice('custom_'.length))] || {}) : (API_SITES[id] || {}));
        opt.textContent = info.name || id;
        select.appendChild(opt);
      }
      const desired = effective && normals.includes(effective) ? effective : (normals[0] || '');
      if (desired) select.value = desired;
    }
  `;
  return block;
}

test('isNormalSource: 排除资源采集站与自定义成人源', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'xrbsp'],
    customAPIs: [{ name: '骚站', url: 'https://a.com', isAdult: true }],
  });
  assert.equal(env.sandbox.isNormalSource('ffzy'), true);
  assert.equal(env.sandbox.isNormalSource('xrbsp'), false);
  assert.equal(env.sandbox.isNormalSource('custom_0'), false);
  assert.equal(env.sandbox.isNormalSource('custom_99'), false);
  assert.equal(env.sandbox.isNormalSource('not-exist'), false);
});

test('pickFirstNormalSource: 跳过资源采集站源', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['xrbsp', 'ffzy', 'fhapi9'],
  });
  assert.equal(env.sandbox.pickFirstNormalSource(), 'ffzy');
});

test('getHomeSourceIds: 普通分类返回默认源单源', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'wujin', 'piaoling'],
    defaultSourceId: 'wujin',
  });
  assert.equal(JSON.stringify(env.sandbox.getHomeSourceIds('tv')), '["wujin"]');
  assert.equal(JSON.stringify(env.sandbox.getHomeSourceIds('anime')), '["wujin"]');
  assert.equal(JSON.stringify(env.sandbox.getHomeSourceIds('variety')), '["wujin"]');
});

test('getHomeSourceIds: 默认源失效时降级到第一个普通资源源', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'wujin', 'piaoling'],
    defaultSourceId: 'not-selected',
  });
  assert.equal(JSON.stringify(env.sandbox.getHomeSourceIds('tv')), '["ffzy"]');
});

test('getHomeSourceIds: 默认源指向资源采集站时降级', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'xrbsp'],
    defaultSourceId: 'xrbsp',
  });
  assert.equal(JSON.stringify(env.sandbox.getHomeSourceIds('tv')), '["ffzy"]');
});

test('getHomeSourceIds: 资源采集站分类只看 adult 源,与默认源无关', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'xrbsp', 'fhapi9'],
    defaultSourceId: 'ffzy',
  });
  const ids = JSON.stringify(env.sandbox.getHomeSourceIds('adult'));
  assert.ok(ids.includes('xrbsp') && ids.includes('fhapi9'));
  assert.equal(ids.includes('ffzy'), false);
});

test('getEffectiveDefaultSourceId: 优先用户设置, 否则降级', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'wujin'],
    defaultSourceId: 'wujin',
  });
  assert.equal(env.sandbox.getEffectiveDefaultSourceId(), 'wujin');

  const env2 = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'wujin'],
    defaultSourceId: 'missing',
  });
  assert.equal(env2.sandbox.getEffectiveDefaultSourceId(), 'ffzy');
});

test('getSearchSourceIds: 多源模式遍历 selectedAPIs', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'wujin', 'piaoling'],
    defaultSourceId: 'wujin',
    searchMode: 'multi',
  });
  const ids = JSON.stringify(env.sandbox.getSearchSourceIds());
  assert.equal(ids, '["ffzy","wujin","piaoling"]');
});

test('getSearchSourceIds: 单源模式只查默认源', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'wujin', 'piaoling'],
    defaultSourceId: 'wujin',
    searchMode: 'single',
  });
  assert.equal(JSON.stringify(env.sandbox.getSearchSourceIds()), '["wujin"]');
});

test('getSearchSourceIds: 单源模式默认源失效时降级到第一个普通源', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'wujin'],
    defaultSourceId: 'missing',
    searchMode: 'single',
  });
  // 自动降级到第一个普通源，避免用户单源模式完全搜不到
  assert.equal(JSON.stringify(env.sandbox.getSearchSourceIds()), '["ffzy"]');
});

test('ensureDefaultSourceValid: 修正失效的默认源', () => {
  const storage = createStorage();
  const env = loadEnv({
    storage,
    selectedAPIs: ['ffzy', 'wujin'],
    defaultSourceId: 'not-selected',
  });
  const result = env.sandbox.ensureDefaultSourceValid();
  assert.equal(result, 'ffzy');
  // 持久化已被修正
  assert.equal(JSON.parse(storage.getItem('defaultSourceId')), 'ffzy');
});

test('setSearchMode: 持久化切换结果', () => {
  const storage = createStorage();
  const env = loadEnv({
    storage,
    selectedAPIs: ['ffzy'],
    searchMode: 'multi',
  });
  env.sandbox.setSearchMode('single');
  assert.equal(env.sandbox.window.searchMode, 'single');
  assert.equal(JSON.parse(storage.getItem('searchMode')), 'single');
  // 切换同一值不会重复触发
  env.sandbox.setSearchMode('single');
  assert.equal(env.sandbox.window.searchMode, 'single');
});

// —— 按访问模式判断默认源候选 ——

test('普通模式: 资源站源不可作为默认源候选', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'xrbsp', 'fhapi9'],
    isAdmin: false,
  });
  assert.equal(env.sandbox.isDefaultSourceCandidate('ffzy'), true);
  assert.equal(env.sandbox.isDefaultSourceCandidate('xrbsp'), false);
  assert.equal(env.sandbox.isDefaultSourceCandidate('fhapi9'), false);
  assert.equal(env.sandbox.isDefaultSourceCandidate('custom_0'), false);
  // 默认源指向资源站时被拒绝，降级到第一个普通源
  const env2 = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'xrbsp'],
    defaultSourceId: 'xrbsp',
    isAdmin: false,
  });
  assert.equal(env2.sandbox.getEffectiveDefaultSourceId(), 'ffzy');
  assert.equal(JSON.stringify(env2.sandbox.getHomeSourceIds('tv')), '["ffzy"]');
});

test('管理员模式: 资源站源可作为默认源候选', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'xrbsp', 'fhapi9'],
    isAdmin: true,
  });
  assert.equal(env.sandbox.isDefaultSourceCandidate('ffzy'), true);
  assert.equal(env.sandbox.isDefaultSourceCandidate('xrbsp'), true);
  assert.equal(env.sandbox.isDefaultSourceCandidate('fhapi9'), true);
  // 默认源指向资源站时被接受
  const env2 = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'xrbsp'],
    defaultSourceId: 'xrbsp',
    isAdmin: true,
  });
  assert.equal(env2.sandbox.getEffectiveDefaultSourceId(), 'xrbsp');
  // 首页普通分类也从该默认源拉取
  assert.equal(JSON.stringify(env2.sandbox.getHomeSourceIds('tv')), '["xrbsp"]');
});

test('管理员模式: 默认源失效时降级到第一个可用候选源(可为资源站)', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['xrbsp', 'ffzy'],
    defaultSourceId: 'missing',
    isAdmin: true,
  });
  assert.equal(env.sandbox.getEffectiveDefaultSourceId(), 'xrbsp');
  assert.equal(JSON.stringify(env.sandbox.getHomeSourceIds('tv')), '["xrbsp"]');
});

test('管理员模式: 单源搜索允许资源站默认源', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'xrbsp'],
    defaultSourceId: 'xrbsp',
    searchMode: 'single',
    isAdmin: true,
  });
  assert.equal(JSON.stringify(env.sandbox.getSearchSourceIds()), '["xrbsp"]');
});

test('普通模式: 单源搜索默认源为资源站时降级到普通源', () => {
  const env = loadEnv({
    storage: createStorage(),
    selectedAPIs: ['ffzy', 'xrbsp'],
    defaultSourceId: 'xrbsp',
    searchMode: 'single',
    isAdmin: false,
  });
  assert.equal(JSON.stringify(env.sandbox.getSearchSourceIds()), '["ffzy"]');
});
