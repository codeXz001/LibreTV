// 探测首屏图片真实域名（豆瓣封面 + 资源站海报），用于决定 preconnect / dns-prefetch 名单
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

async function doubanHosts() {
  const url = 'https://movie.douban.com/j/search_subjects?type=movie&tag=%E7%83%AD%E9%97%A8&sort=recommend&page_limit=12&page_start=0';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://movie.douban.com/' } });
    const j = await r.json();
    const hosts = new Map();
    for (const s of j.subjects || []) {
      try {
        const h = new URL(s.cover).host;
        hosts.set(h, (hosts.get(h) || 0) + 1);
      } catch { /* ignore */ }
    }
    console.log('豆瓣封面图床域名：');
    for (const [h, n] of [...hosts].sort((a, b) => b[1] - a[1])) console.log(`  ${h}  x${n}`);
    const first = (j.subjects || [])[0];
    if (first) console.log(`  样例: ${first.cover}`);
  } catch (e) {
    console.log('豆瓣探测失败:', e.message);
  }
}

async function vodPicHosts() {
  const apis = [
    ['非凡M3U8', 'https://ffzy5.tv/api.php/provide/vod'],
    ['如意资源', 'https://cj.rycjapi.com/api.php/provide/vod'],
    ['猫眼资源', 'https://api.maoyanapi.top/api.php/provide/vod'],
    ['电影天堂', 'https://caiji.dyttzyapi.com/api.php/provide/vod'],
    ['艾旦影视', 'https://lovedan.net/api.php/provide/vod'],
    ['360资源', 'https://360zy.com/api.php/provide/vod'],
    ['暴风资源', 'https://bfzyapi.com/api.php/provide/vod'],
  ];
  console.log('\n资源站海报图床域名（各站取搜索首条）：');
  const all = new Map();
  for (const [name, api] of apis) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(`${api}?ac=videolist&wd=${encodeURIComponent('战狼')}`, {
        headers: { 'User-Agent': UA }, signal: ctrl.signal,
      });
      clearTimeout(t);
      const j = await r.json();
      const pic = (j.list || [])[0]?.vod_pic || '';
      let host = '(无)';
      try { host = new URL(pic).host; } catch { /* ignore */ }
      all.set(host, (all.get(host) || 0) + 1);
      console.log(`  ${name.padEnd(10)} -> ${host}`);
    } catch (e) {
      console.log(`  ${name.padEnd(10)} -> 失败 ${e.message}`);
    }
  }
  console.log('\n  域名分布：');
  for (const [h, n] of [...all].sort((a, b) => b[1] - a[1])) console.log(`    ${h}  x${n}`);
}

await doubanHosts();
await vodPicHosts();
