// 探测用户给的一批源：检测可达性 + 内容格式 + (苹果CMS 则做搜索实测 / TVBox 配置则提取内嵌的苹果CMS站点)
import { writeFileSync } from 'fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT = 15000;

const SOURCES = [
  { url: 'http://肥猫.com', name: '🚀1-肥猫' },
  { url: 'http://fty.xxooo.cf/tv', name: '🚀2-饭太硬推荐' },
  { url: 'http://xhztv.top/4k.json', name: '🚀3-小盒子4K' },
  { url: 'https://gitlab.com/noimank/tvbox/-/raw/main/tvbox1.json', name: '🚀4-健康家用' },
  { url: 'http://tvbox.xn--4kq62z5rby2qupq9ub.top/', name: '🚀5-王二小' },
  { url: 'https://gh-proxy.com/raw.githubusercontent.com//gaotianliuyun/gao/master/0827.json', name: '🚀6-FongMI线路' },
  { url: 'https://gh-proxy.org/https:/raw.githubusercontent.com/xyq254245/xyqonlinerule/main/XYQTVBox.json', name: '🚀7-香雅情' },
  { url: 'http://pandown.pro/tvbox/tvbox.json', name: '🚀8-巧计线路' },
  { url: 'http://tv.nxog.top/m/', name: '🚀9-欧歌4K' },
  { url: 'https://gh-proxy.com/raw.githubusercontent.com/gaotianliuyun/gao/master/js.json', name: '🚀10-高天流云js' },
  { url: 'https://gh-proxy.com/raw.githubusercontent.com/gaotianliuyun/gao/master/XYQ.json', name: '🚀11-高天流云 XYQ' },
  { url: 'http://www.lyyytv.cn/yt/yt.json', name: '🚀12-影探线路' },
  { url: 'https://gh-proxy.com/https://raw.githubusercontent.com/yoursmile66/TVBox/main/XC.json', name: '🚀13-南风' },
  { url: 'https://www.wya6.cn/tv/yc.json', name: '🚀14-无意线路' },
];

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function fetchWithTimeout(url, ms){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), ms);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const text = await res.text();
    const el = Date.now() - started;
    return { ok: true, status: res.status, ct: res.headers.get('content-type')||'', body: text, ms: el, finalUrl: res.url };
  } catch (e) {
    return { ok: false, err: e.name==='AbortError'?'timeout':(e.cause&&e.cause.code)||e.message, ms: Date.now()-started };
  } finally {
    clearTimeout(t);
  }
}

function classifyCMS(body){
  try {
    const j = JSON.parse(body);
    if (j && (j.list || j.code!==undefined) && Array.isArray(j.list) && j.list.length && j.list[0].vod_name!==undefined) return 'cms';
    if (j && (j.sites || j.lives || j.spider!==undefined || j.rules || j.video || j.drv)) return 'tvbox';
    if (j && Array.isArray(j.list)) return 'cms-list?';
    return 'json-other';
  } catch { return 'not-json'; }
}

// 对疑似苹果CMS的源做真实搜索测试：取 ?ac=videolist&wd= 验证
async function cmsSearchTest(baseApi){
  const url = baseApi + (baseApi.includes('?')?'&':'?') + 'ac=videolist&wd=' + encodeURIComponent('复仇者');
  const r = await fetchWithTimeout(url, 15000);
  if (!r.ok) return { ok:false, note: r.err||('HTTP '+r.status) };
  const cls = classifyCMS(r.body);
  if (cls !== 'cms') return { ok:false, note:'格式不符('+cls+')' };
  try {
    const j = JSON.parse(r.body);
    const list = j.list||[];
    if (!list.length) return { ok:false, note:'搜索无结果' };
    const sample = list[0];
    // 取一个播放地址看是否 m3u8
    const play = sample.vod_play_url||'';
    const m3u8 = /m3u8/i.test(play);
    return { ok:true, total:list.length, sampleName:sample.vod_name, hasM3u8: m3u8, playSample: play.slice(0,80) };
  } catch(e){ return { ok:false, note:'解析失败' }; }
}

// TVBox 配置里提取 type=1(苹果CMS V10) 的站点 api
function extractCMSSites(body){
  try {
    const j = JSON.parse(body);
    const sites = Array.isArray(j.sites)?j.sites:(Array.isArray(j)?j:[]);
    const out = [];
    for (const s of sites){
      if (!s || !s.api) continue;
      // type 1 = 苹果CMS V10(cms); 0/2/3/4 = 爬虫/嗅探/自定义, 不取
      const t = s.type;
      if (t===1 || t==='cms' || /cms/i.test(String(s.type||''))){
        out.push({ key:s.key||s.name, name:s.name||s.key, api:s.api, type:s.type });
      }
    }
    return out;
  } catch { return []; }
}

const report = { scanned: [], cmsAddable: [], tvboxConfigs: [], dead: [] };

for (const s of SOURCES){
  process.stdout.write(`\n[探测] ${s.name}  ${s.url}\n`);
  const r = await fetchWithTimeout(s.url, TIMEOUT);
  if (!r.ok){
    process.stdout.write(`  ✗ 不可达: ${r.err} (${r.ms}ms)\n`);
    report.dead.push({ name:s.name, url:s.url, err:r.err, ms:r.ms });
    continue;
  }
  const cls = classifyCMS(r.body);
  process.stdout.write(`  ✓ HTTP ${r.status}  ${r.ms}ms  ct=${r.ct.slice(0,40)}  格式=${cls}  len=${r.body.length}\n`);
  const entry = { name:s.name, url:s.url, status:r.status, ms:r.ms, cls, len:r.body.length, finalUrl:r.finalUrl };

  if (cls === 'cms'){
    const t = await cmsSearchTest(s.url);
    entry.search = t;
    if (t.ok){ report.cmsAddable.push(entry); process.stdout.write(`  → 苹果CMS可用: ${t.total}条, 含m3u8=${t.hasM3u8}, 样例=${t.sampleName}\n`); }
    else { process.stdout.write(`  → 苹果CMS格式但不满足播放条件: ${t.note}\n`); entry.note=t.note; }
  } else if (cls === 'tvbox'){
    const sites = extractCMSSites(r.body);
    entry.embeddedCMSSites = sites;
    report.tvboxConfigs.push(entry);
    process.stdout.write(`  → TVBox配置, 内嵌苹果CMS站点 ${sites.length} 个` + (sites.length?': '+sites.map(x=>x.name+'('+x.api+')').join(' | '):'') + '\n');
  } else {
    entry.note = '非苹果CMS/非TVBox: '+cls;
    report.dead.push(entry);
    process.stdout.write(`  → 格式不适用(${cls}), 不入LibreTV\n`);
  }
  report.scanned.push(entry);
  await sleep(200);
}

writeFileSync('scripts/probe-tvbox-report.json', JSON.stringify(report, null, 2));
console.log('\n========== 汇总 ==========');
console.log('可达:', report.scanned.length, ' 苹果CMS可入库:', report.cmsAddable.length, ' TVBox配置:', report.tvboxConfigs.length, ' 不可用:', report.dead.length);
console.log('写入 scripts/probe-tvbox-report.json');
