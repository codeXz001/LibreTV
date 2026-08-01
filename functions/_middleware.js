// functions/_middleware.js
// Cloudflare Pages Middleware：把 PASSWORD SHA-256 注入到 HTML
// 公共逻辑下沉到 inject-env-core，本文件只剩 Cloudflare Pages 运行时差异

import { sha256Hex, injectPasswordHash } from '../inject-env-core/index.mjs';

export async function onRequest(context) {
  const { next, env } = context;
  const response = await next();
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('text/html')) return response;

  const html = await response.text();
  const password = env.PASSWORD || '';
  const passwordHash = password ? await sha256Hex(password) : '';
  const modified = injectPasswordHash(html, passwordHash);

  return new Response(modified, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}