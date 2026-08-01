// proxy-core/safe-fetch.mjs
// 带大小限制的 fetch 包装器，防止恶意源返回 GB 级内容爆内存

import { checkContentLength, DEFAULT_MAX_RESPONSE_BYTES } from './security.mjs';

/**
 * fetch 并限制响应体大小。
 *
 * - 命中 Content-Length 超限：直接抛错，不读取 body
 * - 读取过程中累计字节数：超过上限也立即抛错（防御未声明长度的响应）
 * - 非 2xx 响应：默认抛错，可通过 opts.allowNonOk 关掉（用于上游 4xx 也合法的场景）
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] - 默认 50MB
 * @param {RequestInit} [opts.fetchInit] - 透传给 fetch
 * @param {boolean} [opts.allowNonOk] - 默认 false，非 2xx 抛错
 * @returns {Promise<{content: string, contentType: string, responseHeaders: Headers, status: number}>}
 */
export async function safeFetchText(url, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_RESPONSE_BYTES;
  const allowNonOk = opts.allowNonOk ?? false;
  const init = opts.fetchInit || {};

  const response = await fetch(url, init);
  const status = response.status;

  if (!allowNonOk && !response.ok) {
    // 只读取前 200 字节用于错误消息
    let preview = '';
    try { preview = (await response.text()).substring(0, 200); } catch { /* ignore */ }
    const err = new Error(`HTTP error ${status}: ${response.statusText}. URL: ${url}. Body: ${preview}`);
    err.status = status;
    throw err;
  }

  // 阶段 2.11：先看 Content-Length
  const check = checkContentLength(response.headers, maxBytes);
  if (!check.ok && check.length > 0) {
    throw new Error(`Response too large: Content-Length ${check.length} bytes exceeds limit ${check.limit}`);
  }

  // 阶段 2.11：读取时累计字节，超限立即中断
  if (!response.body) {
    return {
      content: await response.text(),
      contentType: response.headers.get('content-type') || '',
      responseHeaders: response.headers,
      status,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder(opts.encoding || 'utf-8');
  let received = 0;
  let content = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { reader.cancel(); } catch { /* 忽略 */ }
      throw new Error(`Response body exceeded ${maxBytes} bytes during streaming`);
    }
    content += decoder.decode(value, { stream: true });
  }
  content += decoder.decode();

  return {
    content,
    contentType: response.headers.get('content-type') || '',
    responseHeaders: response.headers,
    status,
  };
}