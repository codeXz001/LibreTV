// 豆瓣持久缓存(优化项)行为测试
// 用法: node --test scripts/test-douban-cache.mjs
// 验证: ①TTL 内命中 ②过期失效 ③容量上限淘汰最旧 ④损坏数据静默
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 内存版 localStorage(支持 length/key),供沙箱使用
function createMemoryStorage() {
    const map = new Map();
    return {
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: k => { map.delete(k); },
        get length() { return map.size; },
        key: i => Array.from(map.keys())[i] ?? null,
        _raw: map,
    };
}

function loadDouban(storage) {
    const sandbox = {
        window: {},
        document: { addEventListener() {}, getElementById() { return null; } },
        localStorage: storage,
        console,
        showToast() {},
        IMG_TRANSPARENT: '',
    };
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(join(root, 'js/douban.js'), 'utf8'), sandbox, { filename: 'js/douban.js' });
    return sandbox;
}

test('豆瓣持久缓存: TTL 内命中, 过期失效并清理', () => {
    const storage = createMemoryStorage();
    const sb = loadDouban(storage);

    const url = 'https://movie.douban.com/j/search_subjects?type=movie&tag=%E7%83%AD%E9%97%A8';
    const data = { subjects: [{ title: '测试影片', rate: '8.0' }] };

    // 手动写入一条"未来 5 分钟"的缓存(直接操作 storage,模拟 setDoubanLSCache)
    sb.setDoubanLSCache(url, data);
    // 注意:沙箱内 JSON.parse 得到的对象原型与测试线程不同,只校验字段内容
    const hit = sb.getDoubanLSCache(url);
    assert.ok(hit, '写入后应命中');
    assert.equal(hit.subjects[0].title, '测试影片');
    assert.equal(hit.subjects[0].rate, '8.0');

    // 过期:改时间戳为 11 分钟前
    const key = 'doubanCache_' + url;
    const raw = JSON.parse(storage.getItem(key));
    raw.ts = Date.now() - 11 * 60 * 1000;
    storage.setItem(key, JSON.stringify(raw));
    assert.equal(sb.getDoubanLSCache(url), null, '过期缓存应失效');
    assert.equal(storage.getItem(key), null, '过期缓存应被删除');
});

test('豆瓣持久缓存: 容量上限淘汰最旧', () => {
    const storage = createMemoryStorage();
    const sb = loadDouban(storage);

    // 写入达到上限 + 1 条
    for (let i = 0; i < 21; i++) {
        const url = `https://movie.douban.com/u${i}`;
        const data = { subjects: [{ title: '影片' + i }] };
        sb.setDoubanLSCache(url, data);
    }

    // 第一条应被淘汰(最旧),后续仍可命中
    assert.equal(sb.getDoubanLSCache('https://movie.douban.com/u0'), null, '最旧条目应被淘汰');
    const last = sb.getDoubanLSCache('https://movie.douban.com/u20');
    assert.ok(last, '最新条目应保留');
    assert.equal(last.subjects[0].title, '影片20');
});

test('豆瓣持久缓存: 损坏数据静默失败不抛错', () => {
    const storage = createMemoryStorage();
    const sb = loadDouban(storage);

    storage.setItem('doubanCache_bad', '{not-json');
    assert.equal(sb.getDoubanLSCache('bad'), null, '损坏 JSON 应返回 null 而不抛错');
});
