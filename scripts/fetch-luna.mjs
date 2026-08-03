#!/usr/bin/env node
// 拉取 LunaTV-config 全量源，列出所有 api_site（含成人 🎬 标记），供人工筛选
import { writeFileSync } from 'fs';

const URLS = [
  'https://cdn.jsdelivr.net/gh/hafrey1/LunaTV-config@main/LunaTV-config.json',
  'https://fastly.jsdelivr.net/gh/hafrey1/LunaTV-config@main/LunaTV-config.json',
];

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(t);
    return null;
  }
}

const all = {};
for (const url of URLS) {
  const j = await fetchJson(url);
  if (!j) { console.log('失败', url); continue; }
  const sites = j.api_site || j;
  for (const [k, v] of Object.entries(sites)) {
    if (!v || typeof v.api !== 'string' || !v.api.startsWith('http')) continue;
    // 保留原始键，记录是否含成人标记
    const isAdult = /[\u{1F51E}\u{1F3AC}]/u.test(k) || /[\u{1F51E}\u{1F3AC}]/u.test(v.name || '');
    all[k] = { api: v.api, name: v.name || k, detail: v.detail, isAdult };
  }
  console.log(`已加载 ${Object.keys(sites).length} 个源 from ${url.split('/').pop()}`);
}

const arr = Object.entries(all).map(([k, v]) => ({ key: k, ...v }));
arr.sort((a, b) => (a.isAdult - b.isAdult) || a.name.localeCompare(b.name));
writeFileSync(new URL('./luna-sources.json', import.meta.url), JSON.stringify(arr, null, 2), 'utf8');

const adult = arr.filter(x => x.isAdult).length;
console.log(`\n全量源：${arr.length} 个（成人/标记源 ${adult} 个，普通源 ${arr.length - adult} 个）`);
console.log('普通源清单：');
for (const x of arr.filter(a => !a.isAdult)) {
  console.log(`  ${x.name.padEnd(16)} ${x.api}`);
}
