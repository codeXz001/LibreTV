// 首页采集站持久缓存行为测试
// 用法: node --test scripts/test-home-cache.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function createStorage() {
    const map = new Map();
    return {
        getItem(key) { return map.has(key) ? map.get(key) : null; },
        setItem(key, value) { map.set(key, String(value)); },
        removeItem(key) { map.delete(key); },
        get length() { return map.size; },
        key(index) { return Array.from(map.keys())[index] ?? null; },
    };
}

function loadHome(storage) {
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
        BANNED_TYPE_NAMES: [],
        selectedAPIs: ['ffzy'],
        API_SITES: { ffzy: { api: 'https://example.com/api', name: '测试源' } },
        aggregateItemMap: new Map(),
        normalizeTitle(name) { return String(name || '').toLowerCase().replace(/\s+/g, ''); },
        mapLimit: async (items, limit, fn) => Promise.all(items.map(fn)),
        console,
    };
    sandbox.window.HOME_CONFIG = sandbox.HOME_CONFIG;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(join(root, 'js/home.js'), 'utf8'), sandbox, { filename: 'js/home.js' });
    return sandbox;
}

test('首页池缓存: 持久化后可恢复轻量卡片和分页状态', () => {
    const storage = createStorage();
    const sb = loadHome(storage);
    const pool = {
        items: [{
            vod_id: 7,
            vod_name: '测试剧集',
            vod_pic: 'https://img.example.com/7.jpg',
            vod_remarks: '更新至 2 集',
            vod_time: '2026-08-04',
            type_name: '电视剧',
            source_name: '测试源',
            source_code: 'ffzy',
            vod_content: '不应被写入缓存的大字段',
        }],
        srcPages: { ffzy: 1 },
        srcPageCount: { ffzy: 10 },
        hasMore: true,
    };

    sb.persistHomePool('tv', pool, ['ffzy']);
    const restored = sb.restoreHomePool('tv', ['ffzy']);
    assert.ok(restored);
    assert.equal(restored.items[0].vod_id, 7);
    assert.equal(restored.items[0].vod_name, '测试剧集');
    assert.equal(restored.srcPages.ffzy, 1);
    assert.equal(restored.hasMore, true);

    const raw = storage.getItem('homePoolCache_v1:tv:ffzy');
    assert.ok(raw);
    assert.equal(raw.includes('vod_content'), false, '缓存不应保存大字段');
});

test('首页池缓存: 源选择变化或过期后不恢复旧数据', () => {
    const storage = createStorage();
    const sb = loadHome(storage);
    const pool = {
        items: [{ vod_id: 1, vod_name: '旧数据', source_code: 'ffzy' }],
        srcPages: { ffzy: 1 },
        srcPageCount: { ffzy: 1 },
        hasMore: false,
    };
    sb.persistHomePool('tv', pool, ['ffzy']);

    assert.equal(sb.restoreHomePool('tv', ['other']), null, '源签名变化应失效');

    const key = 'homePoolCache_v1:tv:ffzy';
    const expired = JSON.parse(storage.getItem(key));
    expired.ts = Date.now() - 31 * 60 * 1000; // 超过 30 分钟 TTL
    storage.setItem(key, JSON.stringify(expired));
    assert.equal(sb.restoreHomePool('tv', ['ffzy']), null, '过期缓存应失效');
    assert.equal(storage.getItem(key), null, '过期缓存应清理');
});
