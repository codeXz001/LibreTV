// TVBox 订阅导入模块冒烟测试
// 用法: node --test scripts/test-subscription.mjs
// 通过 Node vm 沙箱加载 js/subscription.js 真身,验证纯解析逻辑:
//   - 宽松 JSON 修复(注释/尾随逗号/控制字符/已知缺引号)
//   - 图片尾部 base64 解码(饭太硬式藏配置)
//   - type=1 站点提取 / type=3 跳过
//   - 接口规范化去重
// 注意:浏览器专属 API(atob/new URL IDN)在 Node 中有限,测试只覆盖纯函数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const sandbox = {
    window: {},
    document: { addEventListener() {}, getElementById() { return null; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    PROXY_URL: '/proxy/',
    API_CONFIG: { search: { headers: {} } },
    API_SITES: {},
    selectedAPIs: [],
    customAPIs: [],
    mapLimit: async (items, limit, fn) => items.map(fn),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    TextDecoder,
    URL,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'js/subscription.js'), 'utf8'), sandbox, { filename: 'js/subscription.js' });

const base64utf8 = s => Buffer.from(s, 'utf8').toString('base64');

test('subscriptionTryParse: 直接 JSON', () => {
    const r = sandbox.subscriptionTryParse('{"sites":[],"lives":[]}');
    assert.equal(r.via, 'plain');
    assert.ok(Array.isArray(r.json.sites));
});

test('subscriptionFixLooseJson: 剥注释 + 尾随逗号 + 裸控制字符', () => {
    const loose = '{/* 注释 */ "sites": [], "list": [{"a": 1},], "desc": "换\n行",}';
    const fixed = sandbox.subscriptionFixLooseJson(loose);
    assert.ok(!fixed.includes('/*'));
    assert.ok(!fixed.includes('\n'));
    assert.ok(!fixed.includes('},]'));
    assert.doesNotThrow(() => JSON.parse(fixed));
});

test('subscriptionTryParse: 风水式缺引号已知修复', () => {
    const body = '{ "categories": ["国产剧",日韩剧","其他片"], "sites": [{"api":"http://x"}], "lives": [] }';
    const r = sandbox.subscriptionTryParse(body);
    assert.equal(r.via, 'loose+known-fixes');
    assert.deepEqual(Array.from(r.json.categories), ['国产剧', '日韩剧', '其他片']);
});

test('subscriptionTryParse: 图片尾部 base64 藏配置(饭太硬式)', () => {
    const cfg = JSON.stringify({ sites: [{ key: '影视仓', name: '饭太硬资源', type: 1, api: 'https://a/api.php/provide/vod/' }], lives: [] });
    const png = '\x89PNG\r\n\x1a\n' + 'fake-binary-padding!' + base64utf8(cfg);
    const r = sandbox.subscriptionTryParse(png);
    assert.equal(r.via, 'base64-tail');
    assert.equal(r.json.sites[0].name, '饭太硬资源');
});

test('subscriptionExtractCMSSites: 只取 type=1,跳过 type=3/4', () => {
    const j = {
        sites: [
            { key: 'cms1', name: 'A', type: 1, api: 'https://a/api.php/provide/vod/' },
            { key: 'cms2', name: 'B', type: '1', api: 'https://b/api.php/provide/vod/' },
            { key: 'cms3', name: 'C', type: 'cms', api: 'https://c/api.php/provide/vod/' },
            { key: 'sp1', name: 'D', type: 3, api: './js/x.js' },
            { key: 'sp2', name: 'E', type: 4, api: 'http://c/PHP/y.php' },
            { key: 'sp3', name: 'F', type: 3, api: 'csp_AppV6' },
        ],
    };
    const out = sandbox.subscriptionExtractCMSSites(j);
    assert.equal(out.length, 3);
    assert.ok(out.every(s => s.api.startsWith('http')));
});

test('subscriptionClassify: tvbox / cms / json-other', () => {
    assert.equal(sandbox.subscriptionClassify({ sites: [], lives: [] }), 'tvbox');
    assert.equal(sandbox.subscriptionClassify({ list: [{ vod_name: 'x', vod_id: 1 }], code: 1 }), 'cms');
    assert.equal(sandbox.subscriptionClassify({ list: [{ name: 'x' }] }), 'cms-list?');
    assert.equal(sandbox.subscriptionClassify({ foo: 1 }), 'json-other');
});

test('subscriptionNormalizeApi: 去尾部斜杠与 query', () => {
    assert.equal(sandbox.subscriptionNormalizeApi('https://a/api.php/provide/vod/'), 'https://a/api.php/provide/vod');
    assert.equal(sandbox.subscriptionNormalizeApi('https://a/api.php/provide/vod/?ac=list&from=x'), 'https://a/api.php/provide/vod');
    assert.equal(sandbox.subscriptionNormalizeApi('https://a/api.php/provide/vod'), 'https://a/api.php/provide/vod');
});

test('subscriptionSafeUrl: 合法HTTP地址与中文域名可用', () => {
    assert.equal(sandbox.subscriptionSafeUrl('https://clun.top/box.json'), 'https://clun.top/box.json');
    const u = sandbox.subscriptionSafeUrl('http://乐哥.xyz/dj.json');
    assert.ok(typeof u === 'string' && u.startsWith('http://'));
});

test('subscriptionSafeUrl: 非HTTP协议和无效地址拒绝', () => {
    assert.equal(sandbox.subscriptionSafeUrl('javascript:alert(1)'), '');
    assert.equal(sandbox.subscriptionSafeUrl('not-a-url'), '');
});

test('subscriptionCleanName: 去除标签并限制长度', () => {
    assert.equal(sandbox.subscriptionCleanName('<b>安全源</b>'), '安全源');
    assert.equal(sandbox.subscriptionCleanName(''), '订阅源');
    assert.equal(sandbox.subscriptionCleanName('x'.repeat(100)).length, 80);
});
