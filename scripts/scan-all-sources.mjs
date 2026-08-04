#!/usr/bin/env node
/**
 * 全量源体检脚本(2026-08-04)
 *
 * 作用:对 js/config.js API_SITES 中【所有】源(普通 + adult)逐一体检,
 *       供「删除无用源」决策使用。失败/半可用源自动复测,复测仍不过才算「无用」。
 *
 * 判定标准(与 probe-sources.mjs / probe-adult.mjs 一致):
 *   1. 搜索:?ac=videolist&wd=<词> 返回 JSON 且 list 非空(adult 源可用 wd=1 / pg 列表兜底)
 *   2. 详情:?ac=videolist&ids=<id> 返回 vod_play_url 且能解析出 m3u8
 *   3. 速度:记录搜索响应耗时
 *
 * 用法:
 *   node scripts/scan-all-sources.mjs
 * 结果写入 scripts/scan-report.json
 */
import { writeFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TIMEOUT = Number(process.env.PROBE_TIMEOUT) || 10000;
const CONCURRENCY = 6;
const KEYWORDS = ['战狼', '庆余年'];   // 普通源关键词
const ADULT_KEYWORDS = ['1', '2'];      // 成人源中性词

// ---------- 1. 从 config.js 解析 API_SITES(保留 adult / detail 字段) ----------
function loadSites() {
  const cfgPath = join(ROOT, 'js', 'config.js');
  const text = readFileSync(cfgPath, 'utf8');
  const start = text.indexOf('const API_SITES = {');
  if (start < 0) throw new Error('config.js 中未找到 API_SITES');
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
    if (inner.includes('api:')) {
      const api = /api\s*:\s*['"]([^'"]+)['"]/.exec(inner);
      const name = /name\s*:\s*['"]([^'"]+)['"]/.exec(inner);
      const adult = /adult\s*:\s*true/.test(inner);
      const detail = /detail\s*:\s*['"]([^'"]+)['"]/.exec(inner);
      if (api) sites[key] = { api: api[1], name: name ? name[1] : key, adult, detail: detail ? detail[1] : '' };
    }
  }
  return sites;
}

// ---------- 2. 请求 ----------
async function req(url, timeout = TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
      redirect: 'follow',
    });
    const text = await res.text();
    clearTimeout(t);
    return { ok: res.ok, status: res.status, text, ms: Date.now() - started };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, text: '', ms: Date.now() - started, error: e.name === 'AbortError' ? 'timeout' : ((e.cause && e.cause.code) || e.message) };
  }
}

const parseJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

// 搜索:返回 {ok, ms, list, total, note}
async function searchTest(base, isAdult) {
  const kws = isAdult ? ADULT_KEYWORDS : KEYWORDS;
  for (const kw of kws) {
    const url = `${base}?ac=videolist&wd=${encodeURIComponent(kw)}`;
    const r = await req(url);
    if (!r.ok) continue;
    const j = parseJson(r.text);
    if (!j) continue;
    const list = Array.isArray(j.list) ? j.list : [];
    if (!list.length) continue;
    // adult 源可能没有 code 字段;标准源要求 code=1
    if (!isAdult && j.code !== undefined && Number(j.code) !== 1) continue;
    return { ok: true, ms: r.ms, list, total: Number(j.total) || list.length, via: `wd=${kw}` };
  }
  // 兜底:adult 源或搜索不支持的源,直接拉列表
  for (const q of ['ac=videolist&pg=1', 'ac=list&pg=1']) {
    const url = `${base}?${q}`;
    const r = await req(url);
    if (!r.ok) continue;
    const j = parseJson(r.text);
    if (!j) continue;
    const list = Array.isArray(j.list) ? j.list : [];
    if (!list.length) continue;
    return { ok: true, ms: r.ms, list, total: Number(j.total) || list.length, via: q };
  }
  return { ok: false, ms: 0, list: [], note: '搜索/列表均无结果' };
}

// 详情:取第一条 vod_id 的播放地址
async function detailTest(base, id) {
  const url = `${base}?ac=videolist&ids=${encodeURIComponent(String(id))}`;
  const r = await req(url);
  if (!r.ok) return { ok: false, note: r.error || `HTTP ${r.status}` };
  const j = parseJson(r.text);
  const item = j && j.list && j.list[0];
  const play = (item && item.vod_play_url) || '';
  if (play && /https?:\/\/[^\s$#]+\.m3u8/i.test(play)) {
    const first = play.split('#')[0].split('$').pop() || '';
    return { ok: true, sample: first.slice(0, 80) };
  }
  if (play) return { ok: false, note: '有播放地址但非 m3u8', sample: play.slice(0, 60) };
  return { ok: false, note: '详情无播放地址' };
}

// 单源体检:最多 ROUNDS 轮,任一轮通过即算通过
async function probeOnce(key, site) {
  const base = site.api.replace(/\/+$/, '');
  const r0 = await searchTest(base, site.adult);
  if (!r0.ok) return { key, name: site.name, api: site.api, adult: site.adult, ok: false, stage: 'search', note: r0.note || '不可达', ms: r0.ms };
  const d = await detailTest(base, r0.list[0].vod_id);
  if (!d.ok) return { key, name: site.name, api: site.api, adult: site.adult, ok: false, stage: 'detail', note: d.note, ms: r0.ms };
  return { key, name: site.name, api: site.api, adult: site.adult, ok: true, ms: r0.ms, via: r0.via, total: r0.total, sample: d.sample, note: '' };
}

const ROUNDS = 2;
async function probeFull(key, site) {
  let last = null;
  for (let round = 1; round <= ROUNDS; round++) {
    last = await probeOnce(key, site);
    if (last.ok) return last;
    if (round === 1) await new Promise(r => setTimeout(r, 1500));  // 失败后稍等再复测
  }
  return { ...last, retried: true };
}

// ---------- 3. 并发调度 ----------
async function runAll(entries) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < entries.length) {
      const i = idx++;
      const [key, site] = entries[i];
      const r = await probeFull(key, site);
      results.push(r);
      const flag = r.ok ? 'OK ' : r.retried ? '无用' : '失败';
      const pad = (s, n) => String(s).padEnd(n, ' ');
      console.log(
        `  [${String(results.length).padStart(2)}/${entries.length}] ${pad(flag, 4)} ` +
        `${pad(r.name, 14)} ${r.ok ? pad(r.ms + 'ms', 7) : pad('-', 7)} ` +
        `${r.ok ? pad('共' + r.total + '条', 10) : ''}${r.note || r.sample || ''}`
      );
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- main ----------
(async () => {
  const sites = loadSites();
  const entries = Object.entries(sites);
  console.log(`\n=== 扫描 API_SITES 全部 ${entries.length} 个源(普通 ${entries.filter(e => !e[1].adult).length} + adult ${entries.filter(e => e[1].adult).length},并发 ${CONCURRENCY},每源最多 ${ROUNDS} 轮)===\n`);
  const t0 = Date.now();
  const results = await runAll(entries);
  console.log(`\n  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const good = results.filter(r => r.ok).sort((a, b) => a.ms - b.ms);
  const bad = results.filter(r => !r.ok);

  console.log(`\n=== 汇总 ===`);
  console.log(`  可用:${good.length}  无用:${bad.length}`);
  if (bad.length) {
    console.log(`\n  >>> 无用源清单(建议删除):`);
    for (const r of bad) console.log(`      ${r.name.padEnd(14)} [${r.stage}] ${r.note}  ${r.api}`);
  }
  if (good.length) {
    console.log(`\n  >>> 可用源(按速度排序,前 5):`);
    for (const r of good.slice(0, 5)) console.log(`      ${String(r.ms).padStart(5)}ms  ${r.name.padEnd(14)} ${r.via} 共${r.total}条`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    summary: { good: good.length, bad: bad.length },
    usable: good,
    broken: bad,
  };
  writeFileSync(join(__dirname, 'scan-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n  详细报告:scripts/scan-report.json\n`);
})();
