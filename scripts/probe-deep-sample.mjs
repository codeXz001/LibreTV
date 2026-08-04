#!/usr/bin/env node
/**
 * 深度抽样复验(2026-08-04)
 * 对疑似失效源(首条播放地址 404 / 返回播放页)各取最多 5 条视频验证:
 *   - 直接 m3u8:请求播放地址,200 且 mpegURL → 可播
 *   - 播放页:尝试解析页面内嵌的 m3u8 并验证(若 LibreTV 播放器不支持解析,则算不可播)
 * 判定:该源 >=1 条直接可播 → 保留;全部 404/仅页面 → 无用
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const verify = JSON.parse(readFileSync(join(__dirname, 'scan-play-verify.json'), 'utf8'));
const suspect = [...verify.dead, ...verify.indirect];
const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MAX_SAMPLES = 5;

async function get(url, referer) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) }, redirect: 'follow' });
    const text = await res.text();
    clearTimeout(t);
    return { ok: res.ok, status: res.status, ct: res.headers.get('content-type') || '', text };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, ct: '', text: '', err: e.name === 'AbortError' ? 'timeout' : ((e.cause && e.cause.code) || e.message) };
  }
}

// 播放地址验证:返回 {verdict: 'direct'|'page'|'dead', directUrl}
async function classifyPlayUrl(url, referer) {
  const r = await get(url, referer);
  if (!r.ok || r.status >= 400) return { verdict: 'dead', directUrl: '' };
  if (/mpegurl|application\/vnd\.appl/i.test(r.ct) || /^#EXTM3U/.test(r.text.trim())) return { verdict: 'direct', directUrl: url };
  // HTML 播放页:提取内嵌 m3u8(绝对或相对路径)
  const abs = r.text.match(/https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*/i);
  if (abs) return { verdict: 'page', directUrl: abs[0] };
  const rel = r.text.match(/(["'])(\/[^"']+?\.m3u8[^"']*)\1/i);
  if (rel) {
    try { return { verdict: 'page', directUrl: new URL(rel[2], url).href }; } catch { /* fallthrough */ }
  }
  return { verdict: 'page', directUrl: '' };
}

// 取某源第 n 条视频的播放地址:搜索+详情
async function getPlayUrl(api, adult, n) {
  const base = api.replace(/\/+$/, '');
  const kw = adult ? '1' : '战狼';
  const url = `${base}?ac=videolist&wd=${encodeURIComponent(kw)}&pg=1`;
  const r = await get(url);
  if (!r.ok) return null;
  let j; try { j = JSON.parse(r.text); } catch { return null; }
  const list = Array.isArray(j.list) ? j.list : [];
  if (!list.length) return null;
  const item = list[n % list.length];
  const d = await get(`${base}?ac=videolist&ids=${encodeURIComponent(item.vod_id)}`);
  if (!d.ok) return null;
  let dj; try { dj = JSON.parse(d.text); } catch { return null; }
  const di = dj.list && dj.list[0];
  const play = (di && di.vod_play_url) || '';
  const m = play.split('$$$')[0].split('#')[0].split('$');
  const u = m.length > 1 ? m[m.length - 1].trim() : '';
  return u.startsWith('http') ? u : null;
}

// 一个源的抽样:找第一条直接可播的
async function probeSource(s) {
  const referer = `https://${new URL(s.api).host}/`;
  const found = [];
  for (let i = 0; i < MAX_SAMPLES; i++) {
    const u = await getPlayUrl(s.api, s.adult || false, i);
    if (!u) { found.push({ i, verdict: 'no-url' }); continue; }
    const c = await classifyPlayUrl(u, referer);
    found.push({ i, verdict: c.verdict, url: u.slice(0, 100), directUrl: c.directUrl ? c.directUrl.slice(0, 100) : '' });
    if (c.verdict === 'direct') break;  // 找到可播即可停
    await new Promise(r => setTimeout(r, 250));
  }
  const direct = found.find(f => f.verdict === 'direct');
  return { ...s, samples: found, usable: !!direct };
}

const out = [];
for (const s of suspect) {
  process.stdout.write(`[抽样] ${s.name} ... `);
  const r = await probeSource(s);
  out.push(r);
  process.stdout.write(r.usable ? `✓ 可播(第${r.samples.find(f => f.verdict === 'direct').i + 1}条直链) ${r.samples.length}条样本\n` : `✗ ${r.samples.length}条样本均不可直播\n`);
  for (const f of r.samples) {
    process.stdout.write(`      #${f.i + 1} ${String(f.verdict).padEnd(7)} ${(f.url || f.directUrl || '').slice(0, 90)}\n`);
  }
  await new Promise(r => setTimeout(r, 200));
}

const usable = out.filter(r => r.usable);
const useless = out.filter(r => !r.usable);
console.log(`\n=== 疑似源深度抽样汇总 ===`);
console.log(`  抽样 ${out.length} 个,其中有可直播视频:${usable.length},全部不可直播:${useless.length}`);
if (useless.length) {
  console.log(`\n  >>> 无用源(建议删除):`);
  for (const r of useless) console.log(`      ${r.name.padEnd(14)} ${r.api}`);
}
writeFileSync(join(__dirname, 'scan-deep-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), useless, usable }, null, 2));
console.log(`\n  详情:scripts/scan-deep-report.json`);
