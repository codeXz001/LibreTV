#!/usr/bin/env node
// 聚焦复测：只测「上一轮因超时被误判的源」+「本轮新发现的候选源」。
// 用法：PROBE_TIMEOUT=25000 node scripts/probe-focused.mjs
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const TIMEOUT = Number(process.env.PROBE_TIMEOUT) || 25000;
const KEYWORDS = ['战狼', '庆余年'];

const TARGETS = {
  // —— 本轮 Web 搜索新发现的候选域名（均不在现有 config / 候选池）——
  huawei_hw8: { api: 'https://hw8.live/api.php/provide/vod',           name: '华为吧(hw8)' },
  feisu:      { api: 'https://www.feisuzyapi.com/api.php/provide/vod', name: '飞速资源' },
  ckzy:       { api: 'https://ckzy.me/api.php/provide/vod',            name: 'CK资源' },
  kuaibo2:    { api: 'https://caiji.kczyapi.com/api.php/provide/vod',  name: '快播资源' },
  wolong_cc:  { api: 'https://collect.wolongzy.cc/api.php/provide/vod',name: '卧龙资源(cc)' },
  siquan:     { api: 'https://pg.fenwe078.cf/api.php/provide/vod',     name: '四圈资源' },
  jinying_zy: { api: 'https://jinyingzy.com/api.php/provide/vod',      name: '金鹰资源(zy)' },
  okzy_w9:    { api: 'https://okzyw9.com/api.php/provide/vod',         name: 'OK资源(w9)' },
  baopian:    { api: 'https://zpsps.com/api.php/provide/vod',          name: '宝片资源' },
  aosi:       { api: 'https://aosikazy.com/api.php/provide/vod',       name: '奥斯卡资源' },
};

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
  const result = { key, name: site.name, api: site.api, search: false, detail: false, ms: 0, total: 0, note: '' };
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
    result.search = true; result.ms = ms; result.total = Number(j.total) || list.length;
    result.sample = list[0].vod_name || ''; result.note = ''; data = list; break;
  }
  if (!result.search) return result;
  const id = data[0].vod_id;
  const r2 = await req(`${base}?ac=videolist&ids=${encodeURIComponent(id)}`);
  const j2 = parseJson(r2.text);
  const item = j2 && j2.list && j2.list[0];
  const playUrl = item && (item.vod_play_url || '');
  if (playUrl && /https?:\/\/[^\s$#]+\.m3u8/i.test(playUrl)) {
    result.detail = true;
    result.playSample = String(playUrl.split('#')[0].split('$').pop() || '').slice(0, 90);
  } else if (playUrl) {
    result.note = '有播放地址但非 m3u8';
  } else {
    result.note = '无法获取播放地址';
  }
  return result;
}

const entries = Object.entries(TARGETS);
console.log(`\n=== 聚焦复测（${entries.length} 个，超时 ${TIMEOUT}ms）===\n`);
const results = [];
for (let i = 0; i < entries.length; i++) {
  const [key, site] = entries[i];
  const r = await probe(key, site);
  results.push(r);
  const flag = r.search && r.detail ? 'OK ' : r.search ? '半可用' : '失败';
  console.log(`  [${String(i + 1).padStart(2)}/${entries.length}] ${flag.padEnd(6)} ${r.name.padEnd(12)} ${r.search ? r.ms + 'ms' : '-'.padEnd(6)} ${r.search ? '共' + r.total + '条' : ''} ${r.note}`);
}

const good = results.filter(r => r.search && r.detail).sort((a, b) => a.ms - b.ms);
console.log(`\n=== 结果：${good.length} 个完全可用 ===`);
for (const r of good) console.log(`  ${String(r.ms).padStart(5)}ms  ${r.name.padEnd(12)} ${r.api}`);

const out = join(dirname(fileURLToPath(import.meta.url)), 'probe-focused-report.json');
writeFileSync(out, JSON.stringify({ timeout: TIMEOUT, good, all: results }, null, 2), 'utf8');
console.log(`\n报告：${out}\n`);
