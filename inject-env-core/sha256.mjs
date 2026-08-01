// inject-env-core/sha256.mjs
// 跨平台共享的 SHA-256（用于把 PASSWORD 哈希后注入到 HTML）

/**
 * 异步 SHA-256，输出小写十六进制。
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}