// 第二轮：① 对 FongMI 内嵌的 3 个新 CMS 站点做搜索实测；② 对若干(not-json)配置用正则挖出藏着的 provide/vod 接口并实测
import { writeFileSync } from 'fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT = 15000;
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function fetchText(url, ms){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers:{'User-Agent':UA,'Accept':'*/*'}, redirect:'follow', signal:ctrl.signal });
    const txt = await res.text();
    return { ok:true, status:res.status, body:txt, finalUrl:res.url };
  } catch(e){ return { ok:false, err:e.name==='AbortError'?'timeout':(e.cause&&e.cause.code)||e.message }; }
  finally { clearTimeout(t); }
}

// 已知 config 域名（去重用）
const KNOWN_HOSTS = new Set(['360zy.com','360zyzz.com','api.apibdzy.com','api.ffzyapi.com','api.guangsuapi.com','api.maoyanapi.top','api.ukuapi88.com','api.wujinapi.com','api.xinlangapi.com','api.zuidapi.com','bfzyapi.com','caiji.dyttzyapi.com','caiji.moduapi.cc','cj.ffzyapi.com','cj.lziapi.com','cj.rycjapi.com','ffzy5.tv','hhzyapi.com','iqiyizyapi.com','jszyapi.com','jyzyapi.com','lovedan.net','p2100.net','subocaiji.com','www.hongniuzy2.com','www.huyaapi.com','www.mdzyapi.com']);

function hostOf(u){ try { return new URL(u).host.replace(/^www\./,''); } catch { return null; } }

// 搜索实测：取 ?ac=videolist&wd= 验证 code=1 + 有结果 + 取到一个 m3u8
async function cmsSearchTest(baseApi){
  const url = baseApi + (baseApi.includes('?')?'&':'?') + 'ac=videolist&wd=' + encodeURIComponent('流浪地球');
  const r = await fetchText(url, TIMEOUT);
  if (!r.ok) return { ok:false, note:r.err||('HTTP '+r.status) };
  try {
    const j = JSON.parse(r.body);
    const list = (j&&Array.isArray(j.list))?j.list:[];
    if (!list.length) return { ok:false, note:'搜索无结果(code='+(j&&j.code)+')' };
    const play = (list[0].vod_play_url||'');
    return { ok:true, total:list.length, sampleName:list[0].vod_name, hasM3u8:/m3u8/i.test(play), playSample:play.slice(0,90) };
  } catch(e){ return { ok:false, note:'非苹果CMS JSON:'+(r.body.slice(0,40)) }; }
}

// —— FongMI 内嵌的 3 个新 CMS 站点 ——
const fongNew = [
  { api:'https://haiwaikan.com/api.php/provide/vod', name:'海外看' },
  { api:'https://suoniapi.com/api.php/provide/vod', name:'索尼' },
  { api:'https://api.kuaifan.tv/api.php/provide/vod', name:'快帆' },
];

// —— 待正则扫描的配置源 ——
const configUrls = [
  { url:'https://gh-proxy.org/https:/raw.githubusercontent.com/xyq254245/xyqonlinerule/main/XYQTVBox.json', name:'香雅情' },
  { url:'http://xhztv.top/4k.json', name:'小盒子4K' },
  { url:'https://gh-proxy.com/raw.githubusercontent.com/gaotianliuyun/gao/master/XYQ.json', name:'高天流云XYQ' },
  { url:'https://gh-proxy.com/https://raw.githubusercontent.com/yoursmile66/TVBox/main/XC.json', name:'南风' },
  { url:'https://www.wya6.cn/tv/yc.json', name:'无意线路' },
  { url:'https://gitlab.com/noimank/tvbox/-/raw/main/tvbox1.json', name:'健康家用' },
  { url:'https://gh-proxy.com/raw.githubusercontent.com/gaotianliuyun/gao/master/js.json', name:'高天流云js' },
];

const found = []; // 从配置里挖出的候选 api
for (const c of configUrls){
  process.stdout.write(`\n[扫描配置] ${c.name}\n`);
  const r = await fetchText(c.url, TIMEOUT);
  if (!r.ok){ process.stdout.write(`  ✗ ${r.err}\n`); continue; }
  const matches = r.body.match(/https?:\/\/[^"')\s]+?\/api\.php\/provide\/vod[^"')\s]*/gi) || [];
  const seen = new Set();
  for (const m of matches){
    const api = m.replace(/['"]/g,'');
    const h = hostOf(api);
    if (!h || seen.has(api)) continue;
    seen.add(api);
    if (KNOWN_HOSTS.has(h)){ process.stdout.write(`  - 已存在: ${h}\n`); continue; }
    found.push({ api, from:c.name, host:h });
    process.stdout.write(`  + 新接口: ${api}\n`);
  }
  if (!matches.length) process.stdout.write(`  (未找到 provide/vod 接口，可能为加密配置)\n`);
  await sleep(150);
}

// 汇总所有待实测候选：FongMI 3 个 + 从配置挖出的
const candidates = [...fongNew.map(x=>({...x, from:'FongMI内嵌'})), ...found];
const results = [];
for (const c of candidates){
  process.stdout.write(`\n[实测] ${c.name}  ${c.api}  (来自 ${c.from})\n`);
  const t = await cmsSearchTest(c.api);
  if (t.ok){
    process.stdout.write(`  ✓ 可用: ${t.total}条, 含m3u8=${t.hasM3u8}, 样例=${t.sampleName}\n`);
    results.push({ ...c, ...t, addable:true });
  } else {
    process.stdout.write(`  ✗ 不可用: ${t.note}\n`);
    results.push({ ...c, ...t, addable:false });
  }
  await sleep(200);
}

const addable = results.filter(r=>r.addable);
writeFileSync('scripts/probe-tvbox2-report.json', JSON.stringify({addable, all:results}, null, 2));
console.log('\n========== 汇总 ==========');
console.log('实测候选:', results.length, ' 可入库:', addable.length);
addable.forEach(a=>console.log(`  + ${a.name}  ${a.api}  ${a.ms||''}  ${a.total}条 m3u8=${a.hasM3u8}`));
console.log('写入 scripts/probe-tvbox2-report.json');
