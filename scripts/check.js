// scripts/check.js —— 全量 JS 语法检查（node --check 语义，跨平台）
// 用法：npm run check
// 遍历 js/、proxy-core/ 及根目录 .js/.mjs（排除 node_modules、libs、build 产物）
import { spawnSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE = new Set(['node_modules', 'libs', '.git', 'functions', 'api', 'netlify', 'inject-env-core']);
const EXT = new Set(['.js', '.mjs']);

function collect(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (EXCLUDE.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      collect(full, out);
    } else if (EXT.has(name.slice(name.lastIndexOf('.')))) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(root);
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${f}\n${(r.stderr || r.stdout || '').trim()}`);
  } else {
    console.log(`✓ ${f}`);
  }
}
console.log(`\n检查完成：${files.length} 个文件，${failed} 个失败`);
process.exit(failed ? 1 : 0);
