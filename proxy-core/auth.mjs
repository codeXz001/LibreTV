// proxy-core/auth.mjs
// 跨平台共享的代理鉴权（阶段 2.3 统一为「未设 PASSWORD = 无密码」）

/**
 * 异步计算字符串的 SHA-256 十六进制摘要。
 * 在 Cloudflare Workers / Netlify Edge / Node 18+ 都可用。
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

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * 平台无关的鉴权校验。
 *
 * 行为（与 Cloudflare / Vercel 现有实现一致）：
 *   - 未设置 serverPassword → 视为无密码模式，返回 true
 *   - authHash 不匹配       → false
 *   - timestamp 过期或非法  → false
 *
 * @param {object} args
 * @param {string|null|undefined} args.authHash - 客户端传来的 SHA-256 哈希
 * @param {string|null|undefined} args.timestamp - 客户端传来的时间戳（毫秒）
 * @param {string} args.serverPassword - 服务端环境变量 PASSWORD 的明文
 * @param {number} [args.maxAgeMs] - 时间戳有效期，默认 10 分钟
 * @returns {Promise<boolean>}
 */
export async function validateAuth({ authHash, timestamp, serverPassword, maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  // 未设密码 = 无密码模式（与 CF / Vercel 现状一致）
  if (!serverPassword) return true;

  // 计算服务端哈希
  const serverHash = await sha256Hex(serverPassword);
  if (!authHash || authHash !== serverHash) return false;

  // 时间戳校验（阶段 2.4 NaN 防护）
  if (timestamp !== undefined && timestamp !== null && timestamp !== '') {
    const t = parseInt(timestamp, 10);
    if (isNaN(t)) return false;
    const now = Date.now();
    if (now - t > maxAgeMs) return false;
  }

  return true;
}