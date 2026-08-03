#!/usr/bin/env node
// 健康检查：读 js/config.js 的现有 27 个源，逐个测「搜索+详情+耗时」，输出健康度。
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const TIMEOUT = Number(process.env.PROBE_TIMEOUT) || 12000;
const KEYWORDS = ['庆余年', '狂飙'];

function loadExistingSites() {
  const cfgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'config.js');
  const text = readFileSync(cfgPath, 'utf8');
  const start = text.indexOf('const API_SITES = {');
  let i = text.indexOf('{', start);
  let depth = 0, end = -1;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = text.slice(start + 'const API_SITES = '.length, end + 1);
  const sites = {};
  const re = /['"]?([\w-]+)['"]?\s*:\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const api = /api\s*:\s*['"]([^'"]+)['"]/.exec(m[2]);
    const name = /name\s*:\s*['"]([^'"]+)['"]/.exec(m[2]);
    if (api) sites[m[1]] = { api: api[1], name: name ? name[1] : m[1] };
  }
  return sites;
}

async function req(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    clearTimeout(t);
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) { clearTimeout(t); return { ok: false, status: 0, text: '', error: e.message }; }
}
function pj(t) { try { return JSON.parse(t); } catch { return null; } }

async function probe(key, site) {
  const base = site.api.replace(/\/+$/, '');
  const r = { key, name: site.name, api: site.api, search: false, detail: false, ms: 0, total: 0, note: '' };
  let data = null;
  for (const kw of KEYWORDS) {
    const t0 = Date.now();
    const res = await req(`${base}?ac=videolist&wd=${encodeURIComponent(kw)}`);
    const ms = Date.now() - t0;
    if (!res.ok) { r.note = res.error || `HTTP ${res.status}`; continue; }
    const j = pj(res.text);
    if (!j) { r.note = res.text.trim().startsWith('<') ? 'HTML非JSON' : '无法解析'; continue; }
    if (Number(j.code) !== 1) { r.note = `code=${j.code} ${j.msg || ''}`.trim(); continue; }
    const list = j.list || [];
    if (!list.length) { r.note = `无结果`; continue; }
    r.search = true; r.ms = ms; r.total = Number(j.total) || list.length; r.note = ''; data = list; break;
  }
  if (!r.search) return r;
  const id = data[0].vod_id;
  const res2 = await req(`${base}?ac=videolist&ids=${encodeURIComponent(id)}`);
  const j2 = pj(res2.text);
  const it = j2 && j2.list && j2.list[0];
  const pu = it && (it.vod_play_url || '');
  if (pu && /https?:\/\/[^\s$#]+\.m3u8/i.test(pu)) r.detail = true;
  else if (pu) r.note = '非m3u8';
  else r.note = r.note || '无播放地址';
  return r;
}

const sites = loadExistingSites();
const entries = Object.entries(sites);
console.log(`\n=== 健康检查：${entries.length} 个现有源（超时 ${TIMEOUT}ms）===\n`);
const results = [];
for (let i = 0; i < entries.length; i++) {
  const [k, s] = entries[i];
  const r = await probe(k, s);
  results.push(r);
  const f = r.search && r.detail ? 'OK ' : r.search ? '半 ' : 'XX ';
  console.log(`  [${String(i + 1).padStart(2)}/${entries.length}] ${f} ${r.name.padEnd(12)} ${r.search ? r.ms + 'ms 共' + r.total : r.note}`);
}
const good = results.filter(r => r.search && r.detail).sort((a, b) => a.ms - b.ms);
const half = results.filter(r => r.search && !r.detail);
const bad = results.filter(r => !r.search);
console.log(`\n健康：${good.length}  半可用：${half.length}  失效：${bad.length}`);
console.log('\n失效源：');
bad.forEach(r => console.log(`  ${r.name} (${r.key})  ${r.note}  ${r.api}`));
console.log('\n半可用（可搜不可播）：');
half.forEach(r => console.log(`  ${r.name} (${r.key})  ${r.note}  ${r.api}`));
console.log('\n按速度排序（前 10 快）：');
good.slice(0, 10).forEach(r => console.log(`  ${String(r.ms).padStart(5)}ms  ${r.name} (${r.key})`));

const out = join(dirname(fileURLToPath(import.meta.url)), 'health-report.json');
writeFileSync(out, JSON.stringify({ good, half, bad, all: results }, null, 2), 'utf8');
console.log(`\n报告：${out}\n`);
