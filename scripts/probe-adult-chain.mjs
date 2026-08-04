// 验证 10 个资源采集站源的完整链路：搜索(wd=1) → 详情(ids) → m3u8 播放地址
import { writeFileSync } from 'fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT = 15000;

const SOURCES = [
  ['xrbsp', 'https://www.xrbsp.com/api/json.php'],
  ['fhapi9', 'http://fhapi9.com/api.php/provide/vod/'],
  ['155api', 'https://155api.com/api.php/provide/vod/'],
  ['jkunzy', 'https://jkunzyapi.com/api.php/provide/vod/'],
  ['pgxdy', 'https://www.pgxdy.com/api/json.php'],
  ['gdlsp', 'https://www.gdlsp.com/api/json.php'],
  ['msnii', 'https://www.msnii.com/api/json.php'],
  ['kxgav', 'https://www.kxgav.com/api/json.php'],
  ['lbapi9', 'https://lbapi9.com/api.php/provide/vod/'],
  ['ddapi', 'https://api.ddapi.cc/api.php/provide/vod/'],
];

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, redirect: 'follow', signal: ctrl.signal });
    const txt = await res.text();
    return { ok: res.ok, body: txt, ms: Date.now() - started, status: res.status };
  } catch (e) {
    return { ok: false, err: e.name === 'AbortError' ? 'timeout' : (e.cause && e.cause.code) || e.message, ms: Date.now() - started };
  } finally { clearTimeout(t); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const results = [];
for (const [key, api] of SOURCES) {
  process.stdout.write(`\n[${key}] ${api}\n`);
  // 1) 搜索
  const base = api + (api.includes('?') ? '&' : '?');
  const s = await fetchJson(base + 'ac=videolist&wd=1');
  if (!s.ok || !s.body) { process.stdout.write(`  ✗ 搜索失败: ${s.err || s.status}\n`); results.push({ key, ok: false, why: '搜索失败' }); continue; }
  let j; try { j = JSON.parse(s.body); } catch { process.stdout.write(`  ✗ 非JSON\n`); results.push({ key, ok: false, why: '非JSON' }); continue; }
  const list = (j && Array.isArray(j.list)) ? j.list : [];
  if (!list.length) { process.stdout.write(`  ✗ 搜索无结果\n`); results.push({ key, ok: false, why: '搜索无结果' }); continue; }
  const id = list[0].vod_id;
  process.stdout.write(`  ✓ 搜索 ${s.ms}ms, 首条 id=${id}\n`);

  // 2) 详情
  const d = await fetchJson(base + 'ac=videolist&ids=' + encodeURIComponent(id));
  let dj = null; try { dj = JSON.parse(d.body); } catch {}
  const dlist = (dj && Array.isArray(dj.list)) ? dj.list : [];
  const detail = dlist[0] || null;
  if (!detail || !detail.vod_play_url) { process.stdout.write(`  ✗ 详情无播放地址 (${(d.body || '').slice(0, 60)})\n`); results.push({ key, ok: false, why: '详情无播放地址' }); continue; }
  const m3u8 = /m3u8/i.test(detail.vod_play_url);
  const direct = /http/i.test(detail.vod_play_url);
  process.stdout.write(`  ✓ 详情 ${d.ms}ms, 含m3u8=${m3u8} 含http=${direct}, 播放片段=${detail.vod_play_url.slice(0, 70)}\n`);

  // 3) 取一个真实播放地址做可达性探测(解析 $ 分隔的组)
  const groups = detail.vod_play_url.split('$$$').pop().split('#');
  const playUrl = groups.find(g => /^https?:\/\//i.test(g.trim())) || groups[0];
  const p = await fetchJson(playUrl.trim().split('$$$')[0]);
  const playOk = p.ok && (p.status === 200 || p.status === 206);
  process.stdout.write(`  ${playOk ? '✓' : '⚠'} 播放地址探测: ${p.ok ? p.status + ' ' + p.ms + 'ms' : p.err}, ${(p.body || '').slice(0, 30)}\n`);
  results.push({ key, ok: true, searchMs: s.ms, detailMs: d.ms, id, hasM3u8: m3u8, playUrl: playUrl.slice(0, 80), playOk });
  await sleep(200);
}

writeFileSync('scripts/probe-adult-chain.json', JSON.stringify(results, null, 2));
console.log('\n========== 汇总 ==========');
results.forEach(r => console.log(`  ${r.ok ? '✓' : '✗'} ${r.key}  ${r.why || ('搜索' + r.searchMs + 'ms 详情' + r.detailMs + 'ms 播放' + (r.playOk ? '可达' : '待确认'))}`));
console.log('写入 scripts/probe-adult-chain.json');
