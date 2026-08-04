// 探测一批成人资源站：可达性 + 苹果CMS结构验证 + 搜索实测
// 与 probe-tvbox.mjs 不同：这类站不收录常规影视片名，搜索实测改用中性词，
// 并增加「无 wd 直接拉列表」的兜底验证（部分站要求 pg 参数）。
import { writeFileSync } from 'fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT = 15000;

const SOURCES = [
  { api: 'https://api.apilyzy.com/api.php/provide/vod/', name: '老鸭资源' },
  { api: 'https://www.xrbsp.com/api/json.php', name: '淫水机资源' },
  { api: 'http://fhapi9.com/api.php/provide/vod/', name: '番号资源' },
  { api: 'https://155api.com/api.php/provide/vod/', name: '155资源' },
  { api: 'https://155api.com/api.php/provide/vod/at/json', name: '155资源(at)' },
  { api: 'https://jkunzyapi.com/api.php/provide/vod/', name: '鸡坤资源' },
  { api: 'https://www.pgxdy.com/api/json.php', name: '黄AV资源' },
  { api: 'https://www.gdlsp.com/api/json.php', name: '香奶儿资源' },
  { api: 'https://www.msnii.com/api/json.php', name: '美少女资源' },
  { api: 'https://www.kxgav.com/api/json.php', name: '白嫖资源' },
  { api: 'https://lbapi9.com/api.php/provide/vod/', name: '乐播资源' },
  { api: 'https://lbapi9.com/api.php/provide/vod/at/json', name: '乐播资源(at)' },
  { api: 'https://api.ddapi.cc/api.php/provide/vod/', name: '滴滴资源' },
  { api: 'https://api.ddapi.cc/api.php/provide/vod/at/json', name: '滴滴资源(at)' },
  { api: 'https://www.jingpinx.com/api.php/provide/vod/', name: '精品资源' },
];

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function fetchText(url, ms){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), ms);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const body = await res.text();
    return { ok: true, status: res.status, ct: res.headers.get('content-type')||'', body, ms: Date.now()-started, finalUrl: res.url };
  } catch (e) {
    return { ok: false, err: e.name==='AbortError'?'timeout':(e.cause&&e.cause.code)||e.message, ms: Date.now()-started };
  } finally { clearTimeout(t); }
}

// 判断是否为苹果CMS结构：JSON 且有 list 数组
function classifyCMS(body){
  try {
    const j = JSON.parse(body);
    if (j && Array.isArray(j.list)) {
      if (j.list.length && j.list[0].vod_name!==undefined) return 'cms';
      return 'cms-empty';
    }
    return 'json-other';
  } catch { return 'not-json'; }
}

// 搜索实测：优先中性词 wd=1；无结果再试不带 wd 拉列表（部分站列表即最新更新）
async function cmsSearchTest(baseApi){
  const attempts = [
    baseApi + (baseApi.includes('?')?'&':'?') + 'ac=videolist&wd=1',
    baseApi + (baseApi.includes('?')?'&':'?') + 'ac=videolist&pg=1',
    baseApi + (baseApi.includes('?')?'&':'?') + 'ac=list&pg=1',
  ];
  for (const url of attempts){
    const r = await fetchText(url, TIMEOUT);
    if (!r.ok) return { ok:false, note:'请求失败:'+(r.err||('HTTP '+r.status)) };
    const cls = classifyCMS(r.body);
    if (cls !== 'cms') continue;
    try {
      const j = JSON.parse(r.body);
      const list = j.list||[];
      if (!list.length) continue;
      const play = (list[0].vod_play_url||'');
      return {
        ok:true, via: url.includes('wd=')?'搜索wd=1':'列表拉取', total:list.length,
        hasM3u8:/m3u8/i.test(play), playSample:play.slice(0,60),
      };
    } catch(e){ continue; }
  }
  return { ok:false, note:'无匹配结构(试过 wd=1 / 列表 / ac=list)' };
}

const report = { scanned: [], addable: [], dead: [] };

for (const s of SOURCES){
  process.stdout.write(`\n[探测] ${s.name}  ${s.api}\n`);
  const r = await fetchText(s.api, TIMEOUT);
  if (!r.ok){
    process.stdout.write(`  ✗ 不可达: ${r.err} (${r.ms}ms)\n`);
    report.dead.push({ ...s, err:r.err, ms:r.ms });
    continue;
  }
  const cls = classifyCMS(r.body);
  process.stdout.write(`  ✓ HTTP ${r.status}  ${r.ms}ms  ct=${r.ct.slice(0,30)}  格式=${cls}  len=${r.body.length}\n`);
  const entry = { ...s, status:r.status, ms:r.ms, cls, len:r.body.length, finalUrl:r.finalUrl };

  if (cls === 'cms'){
    const t = await cmsSearchTest(s.api);
    entry.search = t;
    if (t.ok){
      report.addable.push(entry);
      process.stdout.write(`  → 可用: ${t.via}, ${t.total}条, 含m3u8=${t.hasM3u8}\n`);
    } else {
      entry.note = t.note;
      report.dead.push(entry);
      process.stdout.write(`  → 结构存在但实测失败: ${t.note}\n`);
    }
  } else {
    entry.note = '非苹果CMS结构: '+cls;
    report.dead.push(entry);
    process.stdout.write(`  → 格式不适用(${cls})\n`);
  }
  report.scanned.push(entry);
  await sleep(200);
}

writeFileSync('scripts/probe-adult-report.json', JSON.stringify(report, null, 2));
console.log('\n========== 汇总 ==========');
console.log('探测:', report.scanned.length, ' 可用:', report.addable.length, ' 不可用:', report.dead.length);
report.addable.forEach(a=>console.log(`  + ${a.name}  ${a.api}  (${a.ms}ms ${a.search.via})`));
console.log('写入 scripts/probe-adult-report.json');
