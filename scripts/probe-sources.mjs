#!/usr/bin/env node
/**
 * 资源站体检 / 探测脚本
 *
 * 用法：
 *   node scripts/probe-sources.mjs            # 体检现有源 + 探测候选源
 *   node scripts/probe-sources.mjs --only-new # 只探测候选源
 *
 * 判定标准（三关全过才算「可用」）：
 *   1. 搜索：?ac=videolist&wd=<关键词> 返回 JSON，code=1，list 非空
 *   2. 详情：?ac=videolist&ids=<id> 返回 vod_play_url，且能解析出 m3u8
 *   3. 速度：记录搜索响应耗时，用于排序
 *
 * 结果写入 scripts/probe-report.json
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TIMEOUT = Number(process.env.PROBE_TIMEOUT) || 10000;
const CONCURRENCY = 6;
const KEYWORDS = ['战狼', '庆余年'];

// ---------- 1. 现有源（从 js/config.js 解析）----------
function loadExistingSites() {
  const cfgPath = join(ROOT, 'js', 'config.js');
  const text = readFileSync(cfgPath, 'utf8');
  const start = text.indexOf('const API_SITES = {');
  if (start < 0) return {};
  // 找到匹配的结束大括号
  let i = text.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = text.slice(start + 'const API_SITES = '.length, end + 1);
  const sites = {};
  const re = /['"]?([\w-]+)['"]?\s*:\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const key = m[1];
    const inner = m[2];
    const api = /api\s*:\s*['"]([^'"]+)['"]/.exec(inner);
    const name = /name\s*:\s*['"]([^'"]+)['"]/.exec(inner);
    if (api) sites[key] = { api: api[1], name: name ? name[1] : key };
  }
  return sites;
}

// ---------- 2. 候选源池 ----------
// 来源：公开的苹果 CMS V10 采集站（已剔除成人站点）
const CANDIDATES = {
  dyttzy:    { api: 'https://caiji.dyttzyapi.com/api.php/provide/vod', name: '电影天堂资源' },
  heimuer:   { api: 'https://json.heimuer.xyz/api.php/provide/vod',    name: '黑木耳' },
  ruyi:      { api: 'https://cj.rycjapi.com/api.php/provide/vod',      name: '如意资源' },
  tyyszy:    { api: 'https://tyyszy.com/api.php/provide/vod',          name: '天涯资源' },
  wolong:    { api: 'https://wolongzyw.com/api.php/provide/vod',       name: '卧龙资源' },
  wolong2:   { api: 'https://collect.wolongzyw.com/api.php/provide/vod', name: '卧龙采集' },
  jkun:      { api: 'https://jkunzyapi.com/api.php/provide/vod',       name: 'jkun资源' },
  kuaibo:    { api: 'https://www.kuaibozy.com/api.php/provide/vod',    name: '快播资源' },
  tiankong:  { api: 'https://api.tiankongapi.com/api.php/provide/vod', name: '天空资源' },
  xiaomaomi: { api: 'https://zy.xiaomaomi.cc/api.php/provide/vod',     name: '小猫咪资源' },
  senlin:    { api: 'https://slapibf.com/api.php/provide/vod',         name: '森林资源' },
  jinying:   { api: 'https://jyzyapi.com/api.php/provide/vod',         name: '金鹰资源' },
  tiantian:  { api: 'https://ttzyapi.com/api.php/provide/vod',         name: '天天资源' },
  xinlang:   { api: 'https://api.xinlangapi.com/xinlangapi.php/provide/vod', name: '新浪资源' },
  shandian:  { api: 'https://sdzyapi.com/api.php/provide/vod',         name: '闪电资源' },
  '1080zyk': { api: 'https://api.1080zyku.com/api.php/provide/vod',    name: '神马资源' },
  huawei:    { api: 'https://cjhwba.com/api.php/provide/vod',          name: '华为吧资源' },
  yinghua:   { api: 'https://m3u8.apiyhzy.com/api.php/provide/vod',    name: '樱花资源' },
  naixxzy:   { api: 'https://naixxzy.com/api.php/provide/vod',         name: '奶香香资源' },
  '360zz':   { api: 'https://360zyzz.com/api.php/provide/vod',         name: '360资源备用' },
  wujin2:    { api: 'https://api.wujinapi.me/api.php/provide/vod',     name: '无尽资源备用' },
  yayazy:    { api: 'https://cj.yayazy.net/api.php/provide/vod',       name: '丫丫资源' },
  fantuan:   { api: 'https://api.fantuan.tv/api.php/provide/vod',      name: '饭团资源' },
  xiaoji:    { api: 'https://api.xiaojiys.com/api.php/provide/vod',    name: '小鸡资源' },
  liangzi3:  { api: 'https://cj.lzcaiji.com/api.php/provide/vod',      name: '量子备用2' },
  yongjiu:   { api: 'https://api.yongjiuzy1.com/api.php/provide/vod',  name: '永久资源' },
  souav:     { api: 'https://api.souavzy.vip/api.php/provide/vod',     name: 'souav' }, // 待过滤
  wwzy:      { api: 'https://wwzy.tv/api.php/provide/vod',             name: '旺旺短剧' },
  hh2:       { api: 'https://cjhhzy.com/api.php/provide/vod',          name: '豪华资源2' },
  mtzy:      { api: 'https://caiji.maotaizy.cc/api.php/provide/vod',   name: '茅台资源' },
  zy360:     { api: 'https://api.360zyx.vip/api.php/provide/vod',      name: '360资源x' },
  dbzy:      { api: 'https://dbzy.tv/api.php/provide/vod',             name: '豆瓣资源' },
  mozhua:    { api: 'https://mozhuazy.com/api.php/provide/vod',        name: '魔爪资源' },
  ukzy:      { api: 'https://api.ukuapi.com/api.php/provide/vod',      name: 'U酷备用' },
  guangsu2:  { api: 'https://api.guangsuapi.com/api.php/provide/vod',  name: '光速资源' },
  yzzy:      { api: 'https://api.yzzy-api.com/inc/apijson.php',        name: '优质资源库' },

  // ===== 第二批手工候选 =====
  kuaiche:   { api: 'https://caiji.kuaichezy.org/api.php/provide/vod', name: '快车资源' },
  suoni:     { api: 'https://suoniapi.com/api.php/provide/vod',        name: '索尼资源' },
  niuniu:    { api: 'https://api.niuniuzy.me/api.php/provide/vod',     name: '牛牛资源' },
  guochan:   { api: 'https://api.guochanzyk.com/api.php/provide/vod',  name: '国产资源库' },
  hdzyk:     { api: 'https://hdzyk.com/api.php/provide/vod',           name: '高清资源库' },
  lajiao:    { api: 'https://apilj.com/api.php/provide/vod',           name: '辣椒资源' },
  dadi:      { api: 'https://dadiapi.com/api.php/provide/vod',         name: '大地资源' },
  fanshu:    { api: 'https://fsapi.xyz/api.php/provide/vod',           name: '番薯资源' },
  okzy:      { api: 'https://cj.okzy.tv/api.php/provide/vod',          name: 'OK资源' },
  bingdou:   { api: 'https://bdzy.cc/api.php/provide/vod',             name: '冰豆资源' },
  taopian:   { api: 'https://taopianapi.com/home/cjapi/mc10/vod/json', name: '淘片资源' },
  wanzy:     { api: 'https://wanzyapi.com/api.php/provide/vod',        name: '万能资源' },
  hulan:     { api: 'https://hulanzy.com/api.php/provide/vod',         name: '葫芦资源' },
  laoya:     { api: 'https://api.apilyzy.com/api.php/provide/vod',     name: '老鸭资源' },
  jisu2:     { api: 'https://api.jisuzy.com/api.php/provide/vod',      name: '极速资源2' },
  yingshi:   { api: 'https://api.yingshi.tv/api.php/provide/vod',      name: '影视资源' },
  haiwai:    { api: 'https://haiwaikan.com/api.php/provide/vod',       name: '海外看' },
  ppzy:      { api: 'https://www.ppzy.com/api.php/provide/vod',        name: '皮皮资源' },
  tianmei:   { api: 'https://tianmeizy.com/api.php/provide/vod',       name: '天美资源' },
  '178zy':   { api: 'https://178zy.com/api.php/provide/vod',           name: '178资源' },
  hongniu3:  { api: 'https://api.hongniuzy3.com/api.php/provide/vod',  name: '红牛资源3' },
  ffzy3:     { api: 'https://ffzy5.tv/api.php/provide/vod',            name: '非凡资源3' },
  wujin3:    { api: 'https://api.wujinapi.cc/api.php/provide/vod',     name: '无尽资源3' },
  '1080zyk2':{ api: 'https://api.1080zyku.com/inc/api.php',            name: '神马资源2' },
  kubo:      { api: 'https://kuboziyuan.com/api.php/provide/vod',      name: '酷播资源' },
  huawei2:   { api: 'https://huawei8.live/api.php/provide/vod',        name: '华为吧2' },
  siwa:      { api: 'https://siwazyw.tv/api.php/provide/vod',          name: '丝袜资源' }, // 待过滤
  yhzy:      { api: 'https://api.yinghuazy.com/api.php/provide/vod',   name: '樱花资源2' },
  bwzy:      { api: 'https://api.bwzyz.com/api.php/provide/vod',       name: '百万资源' },
  ukuapi:    { api: 'https://api.ukuapi.com/api.php/provide/vod',      name: 'U酷资源' },
  jinying2:  { api: 'https://jyzyapi.com/provide/vod',                 name: '金鹰备用' },
  moduo:     { api: 'https://caiji.moduapi.cc/api.php/provide/vod',    name: '魔都备用' },
  yayaya:    { api: 'https://yayazy.net/api.php/provide/vod',          name: '丫丫备用' },
  hmr:       { api: 'https://json02.heimuer.xyz/api.php/provide/vod',  name: '黑木耳2' },
  hmr3:      { api: 'https://heimuer.tv/api.php/provide/vod',          name: '黑木耳3' },

  // ===== 第三批手工候选（本轮新增探索）=====
  tianwei:   { api: 'https://cj.10010888.xyz/api.php/provide/vod',      name: '天威资源' },   // 搜索结果确认的真实聚合站
  mosu:      { api: 'https://api.mosuapi.com/api.php/provide/vod',      name: '魔速资源' },
  haoyun:    { api: 'https://api.haoyunapi.com/api.php/provide/vod',    name: '好运资源' },
  zhizhen:   { api: 'https://api.zhizhenapi.com/api.php/provide/vod',   name: '知真资源' },
  duoduo:    { api: 'https://cj.duoduozyapi.com/api.php/provide/vod',   name: '多多资源' },
  huya2:     { api: 'https://cj.huyaapi.com/api.php/provide/vod',       name: '虎牙资源2' },
  bingdou2:  { api: 'https://api.bingdouapi.com/api.php/provide/vod',   name: '冰豆资源2' },
  okzy2:     { api: 'https://cj.okzy.net/api.php/provide/vod',          name: 'OK资源2' },
  lajiao2:   { api: 'https://api.lajiaoapi.com/api.php/provide/vod',    name: '辣椒资源2' },
  huawei3:   { api: 'https://cj.huawei8.live/api.php/provide/vod',      name: '华为吧3' },
};

// 成人 / 不适宜内容源关键词，命中直接剔除
const BLOCKLIST = /souav|18|色|jav|hsck|xxx|porn|丝袜|里番|成人|福利|伦理|\u{1F51E}/iu;

// ---------- 3. 远端补充（公开的资源站配置，每日自动检测状态）----------
// 完整版含成人源，靠 BLOCKLIST + 🎬 标记过滤
const REMOTE_SOURCES = [
  'https://cdn.jsdelivr.net/gh/hafrey1/LunaTV-config@main/LunaTV-config.json',
  'https://cdn.jsdelivr.net/gh/hafrey1/LunaTV-config@main/jin18.json',
  'https://fastly.jsdelivr.net/gh/hafrey1/LunaTV-config@main/jin18.json',
  'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jin18.json',
];

async function fetchRemoteCandidates() {
  const merged = {};
  for (const url of REMOTE_SOURCES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const json = await res.json();
      const sites = json.api_site || json;
      let n = 0;
      for (const [k, v] of Object.entries(sites)) {
        if (!v || typeof v.api !== 'string' || !v.api.startsWith('http')) continue;
        if (merged[k]) continue;
        merged[k] = { api: v.api, name: v.name || k, detail: v.detail };
        n++;
      }
      console.log(`  [远端] ${url.split('/').pop()} -> +${n} 个源`);
    } catch (e) {
      console.log(`  [远端] 失败 ${url.split('/')[2]}: ${e.message}`);
    }
  }
  return merged;
}

// ---------- 4. 单源探测 ----------
async function req(url, timeout = TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    });
    clearTimeout(t);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, text: '', error: e.message };
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function probe(key, site) {
  const base = site.api.replace(/\/+$/, '');
  const result = {
    key, name: site.name, api: site.api,
    search: false, detail: false, ms: 0,
    total: 0, sample: '', note: '',
  };

  // --- 搜索测试 ---
  let data = null;
  for (const kw of KEYWORDS) {
    const t0 = Date.now();
    const r = await req(`${base}?ac=videolist&wd=${encodeURIComponent(kw)}`);
    const ms = Date.now() - t0;
    if (!r.ok) { result.note = r.error || `HTTP ${r.status}`; continue; }
    const j = parseJson(r.text);
    if (!j) { result.note = r.text.trim().startsWith('<') ? '返回HTML非JSON' : '响应无法解析'; continue; }
    if (Number(j.code) !== 1) { result.note = `code=${j.code} ${j.msg || ''}`.trim(); continue; }
    const list = j.list || [];
    if (!list.length) { result.note = `搜索"${kw}"无结果`; continue; }
    result.search = true;
    result.ms = ms;
    result.total = Number(j.total) || list.length;
    result.sample = list[0].vod_name || '';
    result.note = '';
    data = list;
    break;
  }
  if (!result.search) return result;

  // --- 详情/播放地址测试 ---
  const id = data[0].vod_id;
  const r2 = await req(`${base}?ac=videolist&ids=${encodeURIComponent(id)}`);
  const j2 = parseJson(r2.text);
  const item = j2 && j2.list && j2.list[0];
  const playUrl = item && (item.vod_play_url || '');
  if (playUrl && /https?:\/\/[^\s$#]+\.m3u8/i.test(playUrl)) {
    result.detail = true;
    const first = playUrl.split('#')[0].split('$').pop();
    result.playSample = (first || '').slice(0, 90);
  } else if (playUrl) {
    result.note = '有播放地址但非 m3u8';
    result.playSample = String(playUrl).slice(0, 90);
  } else {
    result.note = '无法获取播放地址';
  }
  return result;
}

// ---------- 5. 并发调度 ----------
async function runAll(entries) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < entries.length) {
      const i = idx++;
      const [key, site] = entries[i];
      const r = await probe(key, site);
      results.push(r);
      const flag = r.search && r.detail ? 'OK ' : r.search ? '半可用' : '失败';
      const pad = (s, n) => String(s).padEnd(n, ' ');
      console.log(
        `  [${String(results.length).padStart(2)}/${entries.length}] ${pad(flag, 6)} ` +
        `${pad(r.name, 14)} ${r.search ? pad(r.ms + 'ms', 7) : pad('-', 7)} ` +
        `${r.search ? pad('共' + r.total + '条', 10) : ''}${r.note}`
      );
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- main ----------
(async () => {
  const onlyNew = process.argv.includes('--only-new');

  console.log('\n=== 1. 读取现有配置 ===');
  const existing = loadExistingSites();
  console.log(`  现有源：${Object.keys(existing).length} 个`);

  console.log('\n=== 2. 拉取远端候选（LunaTV 禁18源，每日自动检测）===');
  const remote = await fetchRemoteCandidates();

  // 合并候选池：本地候选 + 远端，按 api 域名去重（含现有源）
  const seen = new Set();
  const norm = (u) => {
    try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; }
  };
  // 剥离第三方 CF 代理前缀（?url=xxx），只保留原始站点地址
  const unwrap = (u) => {
    const m = /^https?:\/\/[^/]+\/\?url=(https?:\/\/.+)$/i.exec(u);
    return m ? decodeURIComponent(m[1]) : u;
  };
  for (const s of Object.values(existing)) seen.add(norm(s.api));

  // 已测过且有结论的源，默认跳过（--recheck 可强制重测）
  const recheck = process.argv.includes('--recheck');
  const prevPath = join(__dirname, 'probe-report.json');
  let prev = [];
  if (!recheck && existsSync(prevPath)) {
    try {
      prev = JSON.parse(readFileSync(prevPath, 'utf8')).all || [];
      for (const r of prev) seen.add(norm(r.api));
      console.log(`  已有历史结论：${prev.length} 个源（跳过重测，加 --recheck 可强制）`);
    } catch { /* ignore */ }
  }

  const pool = {};
  for (const [k, v] of Object.entries({ ...CANDIDATES, ...remote })) {
    if (BLOCKLIST.test(k) || BLOCKLIST.test(v.name || '')) continue;
    const api = unwrap(v.api);
    const h = norm(api);
    if (seen.has(h)) continue;
    seen.add(h);
    pool[k] = { ...v, api };
  }
  console.log(`  候选新源（已去重、已过滤）：${Object.keys(pool).length} 个`);

  const targets = onlyNew
    ? Object.entries(pool)
    : [...Object.entries(existing).map(([k, v]) => [k, { ...v, __existing: true }]), ...Object.entries(pool)];

  console.log(`\n=== 3. 开始实测（共 ${targets.length} 个，并发 ${CONCURRENCY}）===`);
  const t0 = Date.now();
  const results = await runAll(targets);
  console.log(`\n  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 合并历史结论，形成完整报告
  const merged = [...results];
  for (const p of prev) {
    if (!merged.some(r => norm(r.api) === norm(p.api))) merged.push(p);
  }

  const existingKeys = new Set(Object.keys(existing));
  const good = merged.filter(r => r.search && r.detail).sort((a, b) => a.ms - b.ms);
  const half = merged.filter(r => r.search && !r.detail);
  const bad = merged.filter(r => !r.search);

  console.log('\n=== 4. 汇总 ===');
  console.log(`  完全可用（可搜+可播）：${good.length}`);
  console.log(`  半可用（可搜不可播）：${half.length}`);
  console.log(`  不可用：${bad.length}`);

  const newGood = good.filter(r => !existingKeys.has(r.key));
  const oldBad = [...half, ...bad].filter(r => existingKeys.has(r.key));

  if (newGood.length) {
    console.log(`\n  >>> 可新增的源（${newGood.length} 个，按响应速度排序）：`);
    for (const r of newGood) {
      console.log(`      ${String(r.ms).padStart(5)}ms  ${r.name.padEnd(14)} ${r.api}`);
    }
  }
  if (oldBad.length) {
    console.log(`\n  >>> 现有源中已失效/降级（${oldBad.length} 个）：`);
    for (const r of oldBad) {
      console.log(`      ${r.name.padEnd(14)} ${r.note}  ${r.api}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    summary: { good: good.length, half: half.length, bad: bad.length },
    newUsable: newGood,
    existingBroken: oldBad,
    all: merged.sort((a, b) => (b.search - a.search) || (a.ms - b.ms)),
  };
  const out = join(__dirname, 'probe-report.json');
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n  详细报告：${out}\n`);
})();
