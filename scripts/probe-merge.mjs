// 探测一批 TVBox 源 → 提取可用苹果CMS 接口 → 实测过滤 → 合并进 config.bin 订阅
// 用法: node scripts/probe-merge.mjs
// 输出: scripts/config.bin.new (合并后的订阅) + scripts/probe-merge-report.json (探测明细)
import { readFileSync, writeFileSync } from 'fs';
import https from 'https';
import punycode from 'node:punycode';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT = 15000;
const CONFIG = 'scripts/config.bin';

const SOURCES = [
  { url: 'https://iduo.us.ci/gt/leevi0709/one/main/config.bin', name: '1-主订阅config.bin(自身)' },
  { url: 'https://clun.top/box.json', name: '2-clun' },
  { url: 'https://gh-proxy.com/raw.githubusercontent.com/yw88075/tvbox/main/yw.json', name: '3-yw88075' },
  { url: 'https://gh-proxy.com/raw.githubusercontent.com/leevi0709/one/main/jsm.json', name: '4-leevi0709/jsm' },
  { url: 'http://hucongrong.web3v.work/%E9%A3%8E%E6%B0%B4/fxz/fxz.json', name: '5-风水' },
  { url: 'https://gitlab.com/lzc1021lzc/hjfggzs.hjys/-/raw/main/hjys.free.json', name: '6-韩剧坊' },
  { url: 'https://gitlab.com/duomv/dzhipy/-/raw/main/index.json', name: '7-duomv' },
  { url: 'https://cnb.cool/fish2018/zx/-/git/raw/master/FongMi.json', name: '8-fish2018' },
  { url: 'https://乐哥.xyz/dj.json', name: '9-乐哥' },
  { url: 'https://gitlab.com/noimank/tvbox/-/raw/main/tvbox1.json', name: '10-noimank' },
  { url: 'http://影视仓.com/', name: '11-影视仓官网' },
  { url: 'http://www.饭太硬.art/tv', name: '12-饭太硬' },
  { url: 'http://fty.888484.xyz/tv', name: '13-饭太硬2' },
  { url: 'https://gh-proxy.com/https://raw.githubusercontent.com/guot55/yg/main/pg/bh.json', name: '14-guot55' },
  { url: 'https://3043.kstore.space/bhvip/bh/box.json', name: '15-bhvip' },
  { url: 'http://xhztv.top/4k.json', name: '16-小盒子4K' },
];

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function encodeUrl(u){
  try { new URL(u); return u; } catch(e){
    const m = u.match(/^([a-z]+:\/\/)([^\/]+)(.*)$/i);
    if(!m) return u;
    const host = m[2];
    const pm = host.match(/:\d+$/);
    const h = pm ? host.slice(0, -pm[0].length) : host;
    const p = pm ? pm[0] : '';
    const eh = h.split('.').map(x=>/^[\x00-\x7f]+$/.test(x)?x:punycode.encode(x)).join('.');
    return m[1]+eh+p+m[3];
  }
}

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
    return { ok: true, status: res.status, ct: res.headers.get('content-type')||'', body: text, ms: Date.now()-started, finalUrl: res.url };
  } catch (e) {
    return { ok: false, err: e.name==='AbortError'?'timeout':(e.cause&&e.cause.code)||e.message, ms: Date.now()-started };
  } finally { clearTimeout(t); }
}

// 证书不验证的重试（自签/被拦截 https）
function fetchInsecure(url, ms){
  return new Promise((resolve)=>{
    const started = Date.now();
    let done = false;
    const finish = r => { if(!done){ done=true; resolve(r); } };
    const req = https.request(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, rejectUnauthorized: false }, res=>{
      const chunks = [];
      res.on('data', c=>chunks.push(c));
      res.on('end', ()=> finish({ ok: true, status: res.statusCode||0, ct: res.headers['content-type']||'', body: Buffer.concat(chunks).toString('utf8'), ms: Date.now()-started, finalUrl: url }));
    });
    req.setTimeout(ms, ()=>{ req.destroy(new Error('timeout')); });
    req.on('error', e=> finish({ ok: false, err: e.code||e.message, ms: Date.now()-started }));
    req.end();
  });
}

// 宽松 JSON 修复: 剥注释 + 字符串内裸控制字符转义
function fixLooseJson(src){
  let out = '', inStr = false, esc = false, i = 0;
  while (i < src.length){
    const c = src[i], nx = src[i+1];
    if (inStr){
      if (esc){ out += c; esc = false; i++; }
      else if (c === '\\'){ out += c; esc = true; i++; }
      else if (c === '"'){ out += c; inStr = false; i++; }
      else if (c === '\n'){ out += '\\n'; i++; }
      else if (c === '\r'){ out += '\\r'; i++; }
      else if (c === '\t'){ out += '\\t'; i++; }
      else if (c.charCodeAt(0) < 0x20){ out += '\\u00' + c.charCodeAt(0).toString(16).padStart(2,'0'); i++; }
      else { out += c; i++; }
    } else if (c === '"'){ inStr = true; out += c; i++; }
    else if (c === '/' && nx === '/'){ while (i < src.length && src[i] !== '\n') i++; }
    else if (c === '/' && nx === '*'){ i += 2; while (i < src.length && !(src[i] === '*' && src[i+1] === '/')) i++; i += 2; }
    else if (c === ','){ // 尾随逗号(JSON5风格): 逗号后紧跟 ] 或 } 则丢弃
      let j = i+1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === ']' || src[j] === '}') i++;
      else { out += c; i++; }
    }
    else { out += c; i++; }
  }
  return out;
}

// 风水源已确认存在两处缺失起始引号，限定只修复这两个已知字面量，避免泛化改写源内容
function repairKnownSourceTypos(src){
  return src
    .replace(/,日韩剧",/g, ',"日韩剧",')
    .replace(/,其他片",/g, ',"其他片",');
}

// 增强解析: 直接 JSON → 宽松修复 → 已知源修复 → 图片尾部 base64。返回 {json, via} 或 null
function tryParse(body, options = {}){
  try { return { json: JSON.parse(body), via: 'plain' }; } catch {}
  try { return { json: JSON.parse(fixLooseJson(body)), via: 'loose' }; } catch {}
  if (options.repairKnownSourceTypos){
    const repaired = repairKnownSourceTypos(body);
    try { return { json: JSON.parse(fixLooseJson(repaired)), via: 'loose+known-fixes' }; } catch {}
  }
  const b64s = body.match(/[A-Za-z0-9+/=]{100,}/g) || [];
  for (const s of b64s){
    try {
      const j = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
      if (j && (j.sites || j.lives)) return { json: j, via: 'base64-tail' };
    } catch {}
  }
  return null;
}

function classify(j){
  if (j && (j.sites || j.lives || j.spider!==undefined || j.rules || j.video || j.drv)) return 'tvbox';
  if (j && (j.list || j.code!==undefined) && Array.isArray(j.list) && j.list.length && j.list[0].vod_name!==undefined) return 'cms';
  if (j && Array.isArray(j.list)) return 'cms-list?';
  return 'json-other';
}

function extractCMSSites(j){
  const sites = Array.isArray(j.sites) ? j.sites : (Array.isArray(j) ? j : []);
  const out = [];
  for (const s of sites){
    if (!s || !s.api) continue;
    const t = s.type;
    if (t===1 || t==='cms' || /cms/i.test(String(s.type||''))){
      out.push({ key:s.key||s.name, name:s.name||s.key, api:s.api, type:s.type, searchable:s.searchable });
    }
  }
  return out;
}

function siteTypeDist(j){
  const sites = Array.isArray(j.sites) ? j.sites : (Array.isArray(j) ? j : []);
  const d = {};
  for (const s of sites) d[s.type] = (d[s.type]||0)+1;
  return d;
}

// XML 采集列表判定 (rss 5.1)
function xmlHasList(body){
  const t = body.trimStart();
  if (!t.startsWith('<')) return null;
  return /<list[\s>][\s\S]*?<video[\s>]/i.test(t) || /<vod_name>/i.test(t);
}

// 苹果CMS 验证: 标准列表接口 ac=videolist&pg=1 (不带 wd, 避免 WAF 拦截)
async function cmsTest(api){
  const url = api + (api.includes('?')?'&':'?') + 'ac=videolist&pg=1';
  let r = await fetchWithTimeout(url, 15000);
  if (!r.ok && /cert/i.test(r.err||'')) r = await fetchInsecure(url, 15000);
  if (!r.ok) return { ok:false, note: r.err||('HTTP '+r.status) };
  if (/^\s*</.test(r.body)){ // XML 或 HTML
    if (xmlHasList(r.body)) return { ok:true, xml:true, ms:r.ms };
    return { ok:false, note:'非JSON非XML列表('+r.status+')' };
  }
  try {
    const j = JSON.parse(fixLooseJson(r.body));
    const list = Array.isArray(j.list) ? j.list : [];
    if (j.code !== undefined && j.code !== 1 && !list.length) return { ok:false, note:'业务错误code='+j.code+' '+String(j.msg||'').slice(0,40) };
    if (!list.length) return { ok:false, note:'列表为空' };
    const s0 = list[0];
    return { ok:true, total:list.length, sample:s0.vod_name||s0.name||'', hasPlay: !!(s0.vod_play_url||s0.play_url), ms:r.ms };
  } catch(e){ return { ok:false, note:'解析失败' }; }
}

// 并发池
async function pool(tasks, concurrency){
  const results = new Array(tasks.length);
  let idx = 0;
  const worker = async () => {
    while (idx < tasks.length){
      const i = idx++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({length: concurrency}, worker));
  return results;
}

// ============ 1. 探测源 ============
const report = { scanned: [], merged: [], failed: [], notMergeable: [] };
const rawParsed = [];

for (const s of SOURCES){
  process.stdout.write(`\n[探测] ${s.name}  ${s.url}\n`);
  let r = await fetchWithTimeout(encodeUrl(s.url), TIMEOUT);
  if (!r.ok && /cert/i.test(r.err||'')) r = await fetchInsecure(encodeUrl(s.url), TIMEOUT);
  if (!r.ok){
    process.stdout.write(`  ✗ 不可达: ${r.err} (${r.ms}ms)\n`);
    report.failed.push({ name:s.name, url:s.url, reason:r.err });
    continue;
  }
  const entry = { name:s.name, url:s.url, status:r.status, ms:r.ms, ct:r.ct.slice(0,40), len:r.body.length, finalUrl:r.finalUrl };

  if (s.name.includes('config.bin(自身)')){
    entry.note = '主订阅自身, 已存在';
    entry.self = true;
    report.scanned.push(entry);
    process.stdout.write(`  ✓ 主订阅自身(已存在), 跳过\n`);
    continue;
  }

  const p = tryParse(r.body, { repairKnownSourceTypos: s.name === '5-风水' });
  if (!p){
    entry.note = '无法解析(疑似加密: len='+r.body.length+', 前缀='+r.body.slice(0,40).replace(/[^\x20-\x7e]/g,'·')+')';
    report.notMergeable.push(entry);
    report.scanned.push(entry);
    process.stdout.write(`  ✗ 无法解析, 疑似加密 (${entry.note.slice(0,60)})\n`);
    continue;
  }
  entry.via = p.via;

  // 业务错误识别 (如 cnb.cool 仓库冻结)
  if (p.json.errcode !== undefined || p.json.errmsg !== undefined){
    entry.note = '业务错误: '+JSON.stringify({errcode:p.json.errcode, errmsg:p.json.errmsg});
    report.failed.push({ name:s.name, url:s.url, reason:entry.note });
    report.scanned.push(entry);
    process.stdout.write(`  ✗ ${entry.note}\n`);
    continue;
  }

  const cls = classify(p.json);
  entry.cls = cls;
  entry.siteDist = siteTypeDist(p.json);
  if (cls === 'cms'){
    const t = await cmsTest(s.url);
    entry.test = t;
    if (t.ok){
      rawParsed.push({ name:s.name, url:s.url, sites:[{ key:s.name, name:s.name, api:s.url, type:1 }] });
      report.merged.push({ name:s.name, url:s.url, via:p.via, siteCount:1, cmsCount:1 });
      process.stdout.write(`  ✓ 直接CMS可用: ${t.total}条 样例=${t.sample}${t.xml?'(XML)':''}\n`);
    } else {
      entry.note = 'CMS格式但接口验证失败: '+t.note;
      report.notMergeable.push(entry);
      process.stdout.write(`  ✗ CMS格式但接口验证失败: ${t.note}\n`);
    }
  } else if (cls === 'tvbox'){
    const sites = extractCMSSites(p.json);
    if (sites.length){
      rawParsed.push({ name:s.name, url:s.url, sites });
      report.merged.push({ name:s.name, url:s.url, via:p.via, siteCount:(p.json.sites||[]).length, cmsCount:sites.length });
      process.stdout.write(`  ✓ TVBox配置(${p.via}), type=1站点 ${sites.length} 个\n`);
    } else {
      entry.note = 'TVBox配置但无type=1站点, 类型分布: '+JSON.stringify(entry.siteDist);
      report.notMergeable.push(entry);
      process.stdout.write(`  ✗ TVBox配置但无type=1站点(类型分布: ${JSON.stringify(entry.siteDist)})\n`);
    }
  } else {
    entry.note = '格式不适用: '+cls;
    report.notMergeable.push(entry);
    process.stdout.write(`  ✗ 格式不适用(${cls})\n`);
  }
  report.scanned.push(entry);
  await sleep(200);
}

// ============ 2. 收集候选站点 (按api规范化去重) ============
const base = JSON.parse(readFileSync(CONFIG, 'utf8'));
const norm = a => String(a||'').replace(/\/+$/,'').split('?')[0];
const seenNorm = new Set((base.sites||[]).map(s=>norm(s.api)).filter(Boolean));
const seenKey = new Set((base.sites||[]).map(s=>s.key).filter(Boolean));
const candidates = [];
for (const e of rawParsed){
  for (const s of e.sites){
    if (!s.api || !/^https?:/.test(s.api)) continue;
    const n = norm(s.api);
    if (seenNorm.has(n) || seenKey.has(s.key)) continue;
    seenNorm.add(n); seenKey.add(s.key);
    candidates.push({ site:s, from:e.name });
  }
}
process.stdout.write(`\n[验证] 候选新站点 ${candidates.length} 个, 标准列表接口实测(并发6)...\n`);

// ============ 3. 实测过滤 ============
const tests = await pool(candidates.map(c => () => cmsTest(c.site.api)), 6);
const passed = [], failedTests = [];
candidates.forEach((c, i) => {
  if (tests[i] && tests[i].ok) passed.push({ ...c, test: tests[i] });
  else failedTests.push({ ...c, reason: (tests[i]&&tests[i].note)||'unknown' });
});
process.stdout.write(`实测通过 ${passed.length} / ${candidates.length}\n`);

// ============ 4. 合并 ============
const merged = { ...base, sites: [...(base.sites||[])] };
for (const c of passed){
  const s = c.site;
  merged.sites.push({
    key: s.key,
    name: s.name,
    type: 1,
    api: s.api,
    searchable: s.searchable ?? 1,
    changeable: 1,
  });
}

writeFileSync('scripts/config.bin.new', JSON.stringify(merged, null, '\t'));
writeFileSync('scripts/probe-merge-report.json', JSON.stringify({
  ...report,
  candidates, passed, failedTests,
  summary: {
    sources: SOURCES.length,
    mergedSources: report.merged.length,
    candidateSites: candidates.length,
    passedSites: passed.length,
    failedSites: failedTests.length,
    before: base.sites.length,
    after: merged.sites.length,
  },
}, null, 2));

console.log('\n========== 汇总 ==========');
console.log('源总数:', SOURCES.length);
console.log('成功提取的源:', report.merged.map(e=>`${e.name}(+${e.cmsCount})`).join('  '));
console.log('候选新站点:', candidates.length, '→ 实测通过:', passed.length, ' 失败:', failedTests.length);
console.log('原站点:', base.sites.length, '→ 合并后:', merged.sites.length);
console.log('写入: scripts/config.bin.new  (+scripts/probe-merge-report.json)');
