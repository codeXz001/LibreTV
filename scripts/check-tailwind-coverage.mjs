// 校验静态 Tailwind CSS 类覆盖完整性
import { readFileSync, existsSync } from 'fs';

const css = readFileSync('css/tailwind-static.css', 'utf8');
const files = [
  'index.html', 'player.html', 'watch.html', 'about.html',
  'js/app.js', 'js/home.js', 'js/ui.js', 'js/player.js', 'js/douban.js',
  'js/search.js', 'js/api.js', 'js/password.js', 'js/customer_site.js',
  'js/config.js', 'js/watch.js', 'js/index-page.js',
  'js/subscription.js', 'js/pwa-register.js',
];
const used = new Set();
const re2 = /class(Name)?\s*=\s*[`"']([^`"']*)[`"']/g;
for (const f of files) {
  if (!existsSync(f)) continue;
  const s = readFileSync(f, 'utf8');
  let mm;
  while ((mm = re2.exec(s))) {
    mm[2].split(/\s+/).forEach(t => { if (t && !t.includes('${')) used.add(t); });
  }
}
// classList 动态添加
const re3 = /classList\.(add|toggle|remove)\(['"]([^'"]+)['"]/g;
for (const f of files) {
  if (!existsSync(f)) continue;
  const s = readFileSync(f, 'utf8');
  let mm;
  while ((mm = re3.exec(s))) used.add(mm[2]);
}

const twish = (t) => /^(bg|text|flex|grid|hidden|p-|m-|w-|h-|max-|min-|rounded|border|space|gap|items|justify|overflow|fixed|absolute|relative|z-|top|bottom|left|right|transition|duration|ease|hover|focus|opacity|transform|scale|translate|rotate|shadow|ring|font|leading|tracking|line|cursor|select|pointer|object|aspect|sr|container|mx|my|px|py|mt|mb|ml|mr|pt|pb|pl|pr|inset|col|row|block|inline|table|clear|float|break|whitespace|truncate|text-|blur|backdrop|fill|stroke|animate|group|peer|empty|checked|disabled|first|last|odd|even|sm:|md:|lg:|xl:|2xl:|!|\[\d)/.test(t);

const missing = [];
for (const t of used) {
  if (!twish(t)) continue;
  // CSS 选择器转义: # -> \#, : -> \:, ! -> \!, [ -> \[, ] -> \], . -> \.
  const probe = t
    .replace(/#/g, '\\#')
    .replace(/:/g, '\\:')
    .replace(/!/g, '\\!')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\./g, '\\.')
    .replace(/\//g, '\\/');
  if (!css.includes(probe) && !css.includes(t)) missing.push(t);
}
console.log('HTML+JS 使用类总数:', used.size);
console.log('疑似 tailwind 类:', [...used].filter(twish).length);
console.log('CSS 未覆盖类:', missing.length);
if (missing.length) console.log('缺失列表:', missing.join(', '));
