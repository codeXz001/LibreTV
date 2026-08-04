#!/usr/bin/env node
/**
 * 第三关验证:实际请求每个源返回的 m3u8 播放地址(2026-08-04)
 * 判定「无用源」的最后一关:API 可搜可返回地址 ≠ 播放地址真实可播。
 * 每地址测两轮:无 Referer / 带源 API 域名 Referer(规避部分防盗链)。
 * 结果写入 scripts/scan-play-verify.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const report = JSON.parse(readFileSync(join(__dirname, 'scan-report.json'), 'utf8'));
const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }

async function head(url, referer) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Referer': referer || undefined },
      redirect: 'follow',
    });
    // 只读前 500 字节判断内容类型,避免下载整个流
    const reader = res.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    const head = value ? new TextDecoder().decode(value.slice(0, 500)) : '';
    clearTimeout(t);
    const ct = res.headers.get('content-type') || '';
    return {
      ok: res.ok, status: res.status, ct, ms: Date.now() - started,
      looksLikePlaylist: /#EXTM3U|#EXT-X-/i.test(head),
      headSample: head.replace(/\n/g, ' ').slice(0, 60),
      finalUrl: res.url,
    };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, ct: '', ms: Date.now() - started, err: e.name === 'AbortError' ? 'timeout' : ((e.cause && e.cause.code) || e.message) };
  }
}

const results = [];
for (const r of report.usable) {
  const url = r.sample;
  if (!url) { results.push({ ...r, play: '无地址' }); continue; }
  const apiHost = hostOf(r.api);
  const r1 = await head(url);
  const directOK = r1.ok && r1.status >= 200 && r1.status < 400;
  let r2 = null;
  if (!directOK || !r1.looksLikePlaylist) {
    await new Promise(res => setTimeout(res, 300));
    r2 = await head(url, `https://${apiHost}/`);
  }
  const final = r2 || r1;
  const verdict = (final.ok && final.status < 400) ? (final.looksLikePlaylist ? '可播' : '非直接流') : '打不开';
  results.push({ key: r.key, name: r.name, api: r.api, url, verdict, status: final.status, ct: final.ct, ms: final.ms, referer: r2 ? apiHost : '', looksLikePlaylist: final.looksLikePlaylist, headSample: final.headSample, finalUrl: final.finalUrl });
  const flag = verdict === '可播' ? 'OK ' : verdict === '非直接流' ? '?? ' : '死 ';
  console.log(`  [${flag}] ${String(r.name).padEnd(14)} ${verdict}  ${final.status || ''} ${final.ms}ms  ${(final.ct || '').slice(0, 30)}`);
  console.log(`       ${url.slice(0, 110)}`);
}

const playable = results.filter(r => r.verdict === '可播');
const indirect = results.filter(r => r.verdict === '非直接流');
const dead = results.filter(r => r.verdict === '打不开');

console.log(`\n=== 播放地址验证汇总 ===`);
console.log(`  直接可播:${playable.length}  非直接流(需播放器解析):${indirect.length}  打不开:${dead.length}`);
if (dead.length) {
  console.log(`\n  >>> 打不开的源(可能无用):`);
  for (const r of dead) console.log(`      ${r.name.padEnd(14)} ${r.status || r.err}  ${r.url.slice(0, 100)}`);
}
if (indirect.length) {
  console.log(`\n  >>> 非直接流(返回页面,不一定不能播):`);
  for (const r of indirect) console.log(`      ${r.name.padEnd(14)} ${r.status} ${(r.ct || '').slice(0, 24)}  ${r.headSample}`);
}

writeFileSync(join(__dirname, 'scan-play-verify.json'), JSON.stringify({ generatedAt: new Date().toISOString(), playable, indirect, dead }, null, 2));
console.log(`\n  详情:scripts/scan-play-verify.json`);
