// proxy-core/cors.mjs
// 跨平台共享的 CORS 响应头生成
// 4 套代理现状一致，仅组装方式不同

/**
 * 默认允许的方法与头部。
 */
export const DEFAULT_CORS_METHODS = 'GET, HEAD, POST, OPTIONS';
export const DEFAULT_CORS_ALLOW_ALL = '*';

/**
 * 构造一个通用的 CORS 头部对象。
 *
 * @param {object} [opts]
 * @param {string} [opts.allowOrigin] - 默认 '*'
 * @param {string} [opts.allowMethods] - 默认 'GET, HEAD, POST, OPTIONS'
 * @param {string} [opts.allowHeaders] - 默认 '*'
 * @returns {Record<string, string>}
 */
export function buildCorsHeaders(opts = {}) {
  return {
    'Access-Control-Allow-Origin': opts.allowOrigin || DEFAULT_CORS_ALLOW_ALL,
    'Access-Control-Allow-Methods': opts.allowMethods || DEFAULT_CORS_METHODS,
    'Access-Control-Allow-Headers': opts.allowHeaders || DEFAULT_CORS_ALLOW_ALL,
  };
}

/**
 * 判断给定 HTTP 方法是否为 CORS 预检。
 *
 * @param {string} method
 * @returns {boolean}
 */
export function isPreflight(method) {
  return (method || '').toUpperCase() === 'OPTIONS';
}

/**
 * 构造 CORS 预检响应（HTTP 204）。
 *
 * 返回值取决于调用方使用的运行时：
 *   - fetch 风格（CF / Vercel Functions / Edge）：返回 { status, headers, body? }
 *   - Express 风格（server.mjs）：返回 { status, headers }
 *
 * 调用方负责根据自身运行时做最终封装。
 *
 * @param {object} [opts]
 * @param {number} [opts.maxAge] - Access-Control-Max-Age 秒数，默认 86400
 * @returns {{status: number, headers: Record<string,string>}}
 */
export function preflightResponse(opts = {}) {
  const maxAge = opts.maxAge ?? 86400;
  return {
    status: 204,
    headers: {
      ...buildCorsHeaders(opts),
      'Access-Control-Max-Age': String(maxAge),
    },
  };
}

/**
 * 过滤需要从上游响应里剔除的敏感头。
 *
 * @param {string[]} [extra]
 * @returns {Set<string>}
 */
export function sensitiveHeaderSet(extra) {
  const base = [
    'content-security-policy',
    'cookie',
    'set-cookie',
    'x-frame-options',
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-max-age',
    'content-encoding', // node-fetch 已解压，原始编码头会让客户端解码失败
    'content-length',   // 长度已被改写
  ];
  return new Set([...base, ...(extra || [])].map(s => s.toLowerCase()));
}