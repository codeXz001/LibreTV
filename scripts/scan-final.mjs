#!/usr/bin/env node
/**
 * 最终修正版全量验证(2026-08-04 v2)
 * 修复两处 bug:
 *   1. 播放地址完整保存(不再截断 80 字符)
 *   2. 成人源关键词修正(搜索 wd=1,而非误用"战狼")
 * 流程:搜索 → 详情取完整播放地址 → 请求验证:
 *   - 200 + mpegURL/#EXTM3U → 直接可播
 *   - HTML 播放页 → 提取内嵌 m3u8(绝对/相对)再请求 → 记录内嵌可播性
 *     (LibreTV 播放器不支持页面解析,故页面源判定「不可播」)
 * 每个源取搜索第一条视频(最贴近用户行为:搜词→点第一条)。
 * 结果写入 scripts/scan-final-report.json
 */
import { writeFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function loadSites() {
  const text = readFileSync(join(ROOT, 'js', 'config.js'), 'utf8');
  const start = text.indexOf('const API_SITES = {');
  let depth = 0, end = -1;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = text.slice(start, end + 1);
  const sites = {};
  const re = /['"]?([\w-]+)['"]?\s*:\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const key = m[1], inner = m[2];
    if (!inner.includes('api:')) continue;
    const api = /api\s*:\s*['"]([^'"]+)['"]/.exec(inner);
    const name = /name\s*:\s*['"]([^'"]+)['"]/.exec(inner);
    if (api) sites[key] = { api: api[1], name: name ? name[1] : key, adult: /adult\s*:\s*true/.test(inner) };
  }
  return sites;
}

async function get(url, referer) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) }, redirect: 'follow' });
    const text = await res.text();
    clearTimeout(t);
    return { ok: res.ok, status: res.status, ct: res.headers.get('content-type') || '', text, ms: Date.now() - started };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, ct: '', text: '', ms: Date.now() - started, err: e.name === 'AbortError' ? 'timeout' : ((e.cause && e.cause.code) || e.message) };
  }
}

// 播放地址验证:返回 {verdict, detail}
async function verifyPlayUrl(url, referer) {
  const r = await get(url, referer);
  if (!r.ok || r.status >= 400) return { verdict: 'dead', status: r.status || 0, note: r.err || ('HTTP ' + r.status) };
  if (/mpegurl|mpeg/i.test(r.ct) || /^#EXTM3U/.test(r.text.trim())) return { verdict: 'direct', status: r.status, ct: r.ct };
  // HTML 页面:提取内嵌 m3u8
  let embedded = '';
  const abs = r.text.match(/https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*/i);
  if (abs) embedded = abs[0];
  else {
    const rel = r.text.match(/(["'])(\/[^"']+?\.m3u8[^"']*)\1/i);
    if (rel) { try { embedded = new URL(rel[2], url).href; } catch { /* ignore */ } }
  }
  if (!embedded) return { verdict: 'page', status: r.status, ct: r.ct, note: '页面无内嵌m3u8', pageText: r.text.slice(0, 300) };
  const e = await get(embedded, referer);
  const embedOK = e.ok && e.status < 400 && (e.ct.includes('mpeg') || /^#EXTM3U/.test(e.text.trim()));
  return { verdict: 'page', status: r.status, ct: r.ct, embedded, embedOK, embedStatus: e.status, note: embedOK ? '内嵌m3u8可访问' : `内嵌m3u8不可访问(${e.status || e.err})` };
}

// 完整流程:搜索第一条 → 详情 → 播放地址(完整) → 验证
async function probe(key, site) {
  const base = site.api.replace(/\/+$/, '');
  const kw = site.adult ? '1' : '战狼';
  const referer = `https://${new URL(site.api).host}/`;

  // 1. 搜索
  const r = await get(`${base}?ac=videolist&wd=${encodeURIComponent(kw)}`);
  if (!r.ok) return { key, name: site.name, adult: site.adult, verdict: 'search-fail', note: r.err || ('HTTP ' + r.status) };
  let j; try { j = JSON.parse(r.text); } catch { return { key, name: site.name, adult: site.adult, verdict: 'search-fail', note: '搜索返回非JSON' }; }
  const list = Array.isArray(j.list) ? j.list : [];
  if (!list.length) return { key, name: site.name, adult: site.adult, verdict: 'search-fail', note: '搜索无结果' };

  // 2. 详情取完整播放地址
  const item = list[0];
  const d = await get(`${base}?ac=videolist&ids=${encodeURIComponent(item.vod_id)}`);
  if (!d.ok) return { key, name: site.name, adult: site.adult, verdict: 'search-fail', note: '详情请求失败' };
  let dj; try { dj = JSON.parse(d.text); } catch { return { key, name: site.name, adult: site.adult, verdict: 'search-fail', note: '详情非JSON' }; }
  const di = dj.list && dj.list[0];
  const play = (di && di.vod_play_url) || '';
  // 解析第一条线路的第一个地址(完整保留)
  const urls = play.split('$$$')[0].split('#').map(ep => { const p = ep.split('$'); return p[p.length - 1].trim(); }).filter(u => /^https?:/.test(u));
  if (!urls.length) return { key, name: site.name, adult: site.adult, verdict: 'search-fail', note: '详情无播放地址' };

  // 3. 逐条验证(前 3 条),任一直链可播即算可播
  for (let i = 0; i < Math.min(3, urls.length); i++) {
    const v = await verifyPlayUrl(urls[i], referer);
    if (v.verdict === 'direct') return { key, name: site.name, adult: site.adult, verdict: 'direct', ms: r.ms, url: urls[i], detail: v };
  }
  // 全为页面或死链 → 用第一条详情信息汇报
  const first = await verifyPlayUrl(urls[0], referer);
  return { key, name: site.name, adult: site.adult, verdict: 'unplayable', ms: r.ms, url: urls[0], detail: first, tried: urls.length };
}

(async () => {
  const sites = loadSites();
  const entries = Object.entries(sites);
  console.log(`\n=== v2 最终验证(全部 ${entries.length} 源,取搜索第一条视频)===\n`);
  const results = [];
  for (let i = 0; i < entries.length; i++) {
    const [key, site] = entries[i];
    const r = await probe(key, site);
    results.push(r);
    const flag = r.verdict === 'direct' ? 'OK ' : r.verdict === 'search-fail' ? '搜!' : r.verdict === 'unplayable' ? '不可播' : '?';
    console.log(`  [${String(i + 1).padStart(2)}/${entries.length}] ${flag}  ${String(r.name).padEnd(14)} ${r.note || (r.verdict === 'direct' ? (r.ms + 'ms') : '')}${r.detail ? ' | ' + (r.detail.note || r.detail.ct || '') : ''}`);
    if (r.detail && r.detail.embedded) console.log(`        内嵌: ${r.detail.embedded.slice(0, 110)}`);
    await new Promise(res => setTimeout(res, 150));
  }

  const direct = results.filter(r => r.verdict === 'direct');
  const unplayable = results.filter(r => r.verdict === 'unplayable');
  const searchFail = results.filter(r => r.verdict === 'search-fail');

  console.log(`\n=== 汇总 ===`);
  console.log(`  直链可播:${direct.length}  不可播(页面/死链):${unplayable.length}  搜索失败:${searchFail.length}`);
  if (unplayable.length) {
    console.log(`\n  >>> 不可播源(建议删除):`);
    for (const r of unplayable) console.log(`      ${r.name.padEnd(14)} ${(r.detail && r.detail.note) || ''}  ${r.url}`);
  }
  if (searchFail.length) {
    console.log(`\n  >>> 搜索失败源:`);
    for (const r of searchFail) console.log(`      ${r.name.padEnd(14)} ${r.note}`);
  }
  writeFileSync(join(__dirname, 'scan-final-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), summary: { direct: direct.length, unplayable: unplayable.length, searchFail: searchFail.length }, results }, null, 2));
  console.log(`\n  详情:scripts/scan-final-report.json`);
})();
