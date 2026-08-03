#!/usr/bin/env node
// 检查天威资源的播放地址真实格式，判断能否接入 LibreTV
const BASE = 'https://cj.10010888.xyz/api.php/provide/vod';
async function req(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    clearTimeout(t);
    return await res.text();
  } catch (e) { clearTimeout(t); return 'ERR:' + e.message; }
}
const kw = '战狼';
const s = await req(`${BASE}?ac=videolist&wd=${encodeURIComponent(kw)}`);
const j = JSON.parse(s);
const item = j.list[0];
console.log('搜索命中:', item.vod_name, '| id:', item.vod_id, '| 海报:', item.vod_pic);
const d = await req(`${BASE}?ac=videolist&ids=${encodeURIComponent(item.vod_id)}`);
const j2 = JSON.parse(d);
const play = j2.list[0].vod_play_url;
console.log('\n原始 vod_play_url:\n', play.slice(0, 500));
console.log('\n是否含 .m3u8:', /\.m3u8/i.test(play));
console.log('是否含 .mp4:', /\.mp4/i.test(play));
console.log('是否含 $ 分隔:', play.includes('$'));
console.log('首段:', play.split('#')[0].slice(0, 160));
console.log('\n海报域名:', (() => { try { return new URL(item.vod_pic).origin; } catch { return 'n/a'; } })());
