#!/usr/bin/env node
/**
 * 对 probe-report.json 中失败的源做「串行 + 长超时 + 重试」复测，
 * 排除并发抖动造成的误判。
 *
 * 用法：node scripts/retry-failed.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TIMEOUT = 25000;
const RETRY = 2;
const KEYWORDS = ['战狼', '庆余年'];

async function req(url, timeout = TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': new URL(url).origin + '/',
      },
    });
    clearTimeout(t);
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, text: '', error: e.message };
  }
}

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

async function probeOnce(base) {
  for (const kw of KEYWORDS) {
    const t0 = Date.now();
    const r = await req(`${base}?ac=videolist&wd=${encodeURIComponent(kw)}`);
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, note: r.error || `HTTP ${r.status}`, ms };
    const j = parse(r.text);
    if (!j) return { ok: false, note: r.text.trim().startsWith('<') ? '返回HTML非JSON' : '响应无法解析', ms };
    if (Number(j.code) !== 1) return { ok: false, note: `code=${j.code} ${j.msg || ''}`.trim(), ms };
    const list = j.list || [];
    if (!list.length) continue;
    return { ok: true, ms, list, total: Number(j.total) || list.length };
  }
  return { ok: false, note: '搜索无结果' };
}

(async () => {
  const reportPath = join(__dirname, 'probe-report.json');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  // --timeout-only：只复测因超时被判失败的源（排除明确 404/403/非 JSON 的）
  const timeoutOnly = process.argv.includes('--timeout-only');
  let failed = report.all.filter(r => !r.search);
  if (timeoutOnly) {
    // 仅超时（aborted）值得复测；fetch failed 多为 DNS/连接被拒，首轮复测已证实无一复活
    failed = failed.filter(r => /aborted|timeout/i.test(r.note || ''));
  }
  console.log(`\n复测 ${failed.length} 个失败源（串行，超时 ${TIMEOUT / 1000}s，最多重试 ${RETRY} 次）\n`);

  const revived = [];
  for (let i = 0; i < failed.length; i++) {
    const item = failed[i];
    const base = item.api.replace(/\/+$/, '');
    let res = null;
    for (let a = 0; a <= RETRY; a++) {
      res = await probeOnce(base);
      if (res.ok) break;
      if (/forbids keyword search|HTTP 403|HTML/.test(res.note || '')) break; // 明确拒绝，不重试
    }
    const tag = res.ok ? 'OK  ' : '失败 ';
    console.log(`  [${String(i + 1).padStart(2)}/${failed.length}] ${tag} ${item.name.padEnd(14)} ${res.ok ? res.ms + 'ms  共' + res.total + '条' : res.note}`);

    if (res.ok) {
      // 补测播放地址
      const id = res.list[0].vod_id;
      const r2 = await req(`${base}?ac=videolist&ids=${encodeURIComponent(id)}`);
      const j2 = parse(r2.text);
      const play = j2 && j2.list && j2.list[0] && j2.list[0].vod_play_url;
      const playable = play && /https?:\/\/[^\s$#]+\.m3u8/i.test(play);
      console.log(`            播放地址: ${playable ? '可用 m3u8' : (play ? '非 m3u8' : '无')}`);
      if (playable) revived.push({ ...item, ms: res.ms, total: res.total, search: true, detail: true });
    }
  }

  console.log(`\n=== 复测结果：${revived.length} 个源实际可用（之前被误判）===`);
  for (const r of revived.sort((a, b) => a.ms - b.ms)) {
    console.log(`  ${String(r.ms).padStart(5)}ms  ${r.name.padEnd(14)} ${r.api}`);
  }
  writeFileSync(join(__dirname, 'retry-report.json'), JSON.stringify(revived, null, 2), 'utf8');
  console.log('');
})();
