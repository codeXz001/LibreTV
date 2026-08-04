// proxy-core/auth.mjs
// 跨平台共享的代理鉴权

/**
 * 异步计算字符串的 SHA-256 十六进制摘要。
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
 * 未设置任何密码时为无密码模式；设置多个密码时，任一已配置密码
 * 对应的哈希都可以通过代理鉴权。权限控制仍由前端访问模式负责，
 * 代理只验证请求是否来自已验证会话。
 *
 * @param {object} args
 * @param {string|null|undefined} args.authHash - 客户端传来的 SHA-256 哈希
 * @param {string|null|undefined} args.timestamp - 客户端传来的时间戳（毫秒）
 * @param {string} args.serverPassword - 普通访问密码
 * @param {string[]} [args.alternatePasswords] - 额外访问密码
 * @param {number} [args.maxAgeMs] - 时间戳有效期，默认 10 分钟
 * @returns {Promise<boolean>}
 */
export async function validateAuth({
  authHash,
  timestamp,
  serverPassword,
  alternatePasswords = [],
  maxAgeMs = DEFAULT_MAX_AGE_MS,
}) {
  const passwords = [serverPassword, ...alternatePasswords]
    .filter(password => typeof password === 'string' && password.length > 0);

  // 未设置密码 = 无密码模式
  if (!passwords.length) return true;

  const serverHashes = await Promise.all(passwords.map(sha256Hex));
  if (!authHash || !serverHashes.includes(authHash)) return false;

  if (timestamp !== undefined && timestamp !== null && timestamp !== '') {
    const t = parseInt(timestamp, 10);
    if (isNaN(t)) return false;
    const now = Date.now();
    if (now - t > maxAgeMs) return false;
  }

  return true;
}
