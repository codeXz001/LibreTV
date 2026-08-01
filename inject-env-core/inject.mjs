// inject-env-core/inject.mjs
// 跨平台共享的 PASSWORD 注入函数
// 3 套中间件的逻辑等价：把 HTML 里的占位符 `{{PASSWORD}}` 替换为真实 SHA-256 哈希

const PLACEHOLDER_FULL = 'window.__ENV__.PASSWORD = "{{PASSWORD}}";';
const REPLACEMENT_PREFIX = 'window.__ENV__.PASSWORD = "';
const REPLACEMENT_SUFFIX = '";';

/**
 * 把 HTML 字符串里的 PASSWORD 占位符替换成已计算好的 SHA-256 哈希。
 *
 * 哈希计算放在调用方（因为不同平台可用的 crypto API 略有差异，
 * Vercel Edge / CF Pages / Netlify Edge / Node 18+ 行为统一，
 * 但保留调用方灵活性）。
 *
 * @param {string} html - 原始 HTML 内容
 * @param {string} passwordHash - 已经计算好的 SHA-256 哈希（64 位十六进制）
 * @returns {string} 注入后的 HTML
 */
export function injectPasswordHash(html, passwordHash) {
  const replacement = `${REPLACEMENT_PREFIX}${passwordHash}${REPLACEMENT_SUFFIX}`;
  return html.replace(PLACEHOLDER_FULL, replacement);
}