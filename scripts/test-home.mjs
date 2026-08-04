// 首页模块行为冒烟测试
// 用法: node --test scripts/test-home.mjs
// 通过 Node vm 沙箱加载 js/home.js 真身，验证：
//   - escapeHomeHtml/decodeHomeHtml 往返保真（HTML 属性安全且不破坏搜索词）
//   - 海报卡片 data-* 属性正确（豆瓣条目→data-search-key/data-title，聚合条目→data-key/data-title）
//   - 点击委托：豆瓣条目走标题搜索（特殊字符解码）；聚合数据缺失时回退标题搜索
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 最小沙箱：仅提供 home.js 顶层执行所需的全局，避免依赖完整 DOM。
// 与 js/app.js normalizeTitle 一致的最小实现（测试用副本）。
const sandbox = {
    window: {},
    document: {
        addEventListener() {},
        getElementById() { return null; },
        querySelector() { return null; },
    },
    IntersectionObserver: class {},
    localStorage: { getItem() { return null; }, setItem() {} },
    IMG_TRANSPARENT: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    HOME_CATEGORIES: [],
    HOME_CONFIG: { hotStripLimit: 12, pageSize: 24, concurrency: 4, sourceTimeout: 7000 },
    HOME_RESOURCE_NAV: [],
    BANNED_TYPE_NAMES: [],
    selectedAPIs: [],
    normalizeTitle(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/[\s　]+/g, '')
            .replace(/[《》\[\]【】]/g, '')
            .replace(/[()（）]/g, '')
            .replace(/[·:：\-—_~,，.。!！?？]/g, '')
            .replace(/(19|20)\d{2}$/, '')
            .trim();
    },
    aggregateItemMap: new Map(),
};
sandbox.window.HOME_CONFIG = sandbox.HOME_CONFIG;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'js/home.js'), 'utf8'), sandbox, { filename: 'js/home.js' });

test('escapeHomeHtml/decodeHomeHtml 往返保真', () => {
    const { escapeHomeHtml, decodeHomeHtml } = sandbox;
    const cases = [
        '战狼',
        '战狼 2: 特别篇',
        '蜘蛛侠 <3> "英雄" & 归来',
        "玛丽's 故事",
        'A → B (2025)',
    ];
    for (const c of cases) {
        assert.equal(decodeHomeHtml(escapeHomeHtml(c)), c, `往返失败: ${c}`);
    }
    // 编码必须转义危险字符，避免属性注入
    assert.match(escapeHomeHtml('a" onmouseover="x'), /&quot;/);
    assert.match(escapeHomeHtml('a<b>'), /&lt;b&gt;/);
});

test('buildPosterCardHtml: 搜索条目带 data-search-key/data-title 且无 data-key', () => {
    const { buildPosterCardHtml } = sandbox;
    const html = buildPosterCardHtml(
        { vod_name: '战狼 "2"', vod_pic: '', vod_remarks: '' },
        { searchKey: true }
    );
    assert.match(html, /data-search-key=/);
    assert.match(html, /data-title="战狼 &quot;2&quot;"/);
    assert.doesNotMatch(html, /data-key=/);
});

test('buildPosterCardHtml: 聚合条目带 data-key 与 data-title', () => {
    const { buildPosterCardHtml } = sandbox;
    const html = buildPosterCardHtml({ vod_name: '流浪地球', vod_pic: '', vod_remarks: '' });
    assert.match(html, /data-key="流浪地球"/);
    assert.match(html, /data-title="流浪地球"/);
});

test('handleHomeCardClick: 豆瓣条目走标题搜索（特殊字符解码）', () => {
    const { handleHomeCardClick } = sandbox;
    let searched = '';
    sandbox.fillAndSearchWithDouban = t => { searched = t; };
    const card = {
        dataset: { searchKey: '战狼 &quot;2&quot;', title: '战狼 &quot;2&quot;', key: '' },
        closest: () => card,
    };
    handleHomeCardClick({ target: card });
    assert.equal(searched, '战狼 "2"');
});

test('handleHomeCardClick: 聚合数据缺失时回退标题搜索（修复"搜不到"）', () => {
    const { handleHomeCardClick, aggregateItemMap } = sandbox;
    aggregateItemMap.clear();
    let searched = '';
    let opened = false;
    sandbox.fillAndSearchWithDouban = t => { searched = t; };
    sandbox.showAggregatedDetails = () => { opened = true; };
    const card = { dataset: { title: '流浪地球', key: '流浪地球' }, closest: () => card };
    handleHomeCardClick({ target: card });
    assert.equal(searched, '流浪地球');
    assert.equal(opened, false);
});

test('handleHomeCardClick: 聚合数据存在时打开聚合详情', () => {
    const { handleHomeCardClick, aggregateItemMap } = sandbox;
    aggregateItemMap.clear();
    aggregateItemMap.set('流浪地球', [{ vod_name: '流浪地球', source_code: 's', vod_id: '1' }]);
    let opened = false;
    let searched = '';
    sandbox.fillAndSearchWithDouban = t => { searched = t; };
    sandbox.showAggregatedDetails = () => { opened = true; };
    const card = { dataset: { title: '流浪地球', key: '流浪地球' }, closest: () => card };
    handleHomeCardClick({ target: card });
    assert.equal(opened, true);
    assert.equal(searched, '');
});
