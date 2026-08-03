// proxy-core/security.mjs
// 跨平台共享的 URL 安全校验
// 原始逻辑来源于 server.mjs 的 isValidUrl（阶段 2.6 会增强 IPv6 防护）

const DEFAULT_BLOCKED_HOSTNAMES = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
// 私有/链路本地网段前缀（172.16.0.0/12 需精确到 172.16.-172.31.，避免误伤 172.217.x 等公网段）
const DEFAULT_BLOCKED_PREFIXES = ['192.168.', '10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.', '169.254.', '100.64.', 'fc00:', 'fd00:'];

/**
 * 判断主机名是否为私有/保留 IP 段（基于前缀匹配，含 IPv6 ULA 与 link-local）
 */
function isBlockedHostname(hostname, blockedPrefixes) {
  for (const prefix of blockedPrefixes) {
    if (hostname.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 验证目标 URL 是否可被代理。
 *
 * 检查项：
 *   1. 协议必须为 http / https
 *   2. 主机名不能在黑名单内（localhost、内网等）
 *   3. 主机名前缀不能在黑名单内（192.168./10./172. 等内网段，含 IPv6 ULA 与 link-local）
 *
 * @param {string} urlString - 任意 URL 字符串
 * @param {object} [opts]
 * @param {string[]} [opts.blockedHostnames] - 额外主机名黑名单
 * @param {string[]} [opts.blockedPrefixes] - 额外主机名前缀黑名单
 * @returns {boolean}
 */
export function isValidUrl(urlString, opts = {}) {
  const blockedHostnames = (opts.blockedHostnames || DEFAULT_BLOCKED_HOSTNAMES).map(s => String(s).trim()).filter(Boolean);
  const blockedPrefixes = (opts.blockedPrefixes || DEFAULT_BLOCKED_PREFIXES).map(s => String(s).trim()).filter(Boolean);

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }

  const allowedProtocols = ['http:', 'https:'];
  if (!allowedProtocols.includes(parsed.protocol)) return false;

  // URL.hostname 对 IPv6 字面量会自动去除方括号，例如 "[::1]" → "::1"
  const hostname = parsed.hostname;
  if (!hostname) return false;

  if (blockedHostnames.includes(hostname)) return false;

  if (isBlockedHostname(hostname, blockedPrefixes)) return false;

  return true;
}

/**
 * 默认上限：50MB。防止恶意源返回 GB 级内容撑爆内存。
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/**
 * 根据 Content-Length 头判断是否超过字节上限。
 *
 * @param {Headers|object} headers - 类似 fetch Headers 的对象，有 get(name) 方法
 * @param {number} [maxBytes] - 上限字节数
 * @returns {{ok: boolean, length: number, limit: number}}
 */
export function checkContentLength(headers, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const raw = headers && typeof headers.get === 'function'
    ? headers.get('content-length')
    : (headers && (headers['content-length'] || headers['Content-Length'])) || '';
  const length = parseInt(raw, 10) || 0;
  return { ok: length <= maxBytes, length, limit: maxBytes };
}