// functions/_middleware.js
// Cloudflare Pages Middleware：把 PASSWORD SHA-256 注入到 HTML
// 公共逻辑下沉到 inject-env-core，本文件只剩 Cloudflare Pages 运行时差异

import { sha256Hex, injectPasswordConfig } from '../inject-env-core/index.mjs';

export async function onRequest(context) {
  const { next, env } = context;
  const response = await next();
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('text/html')) return response;

  const html = await response.text();
  const password = env.PASSWORD || '';
  const adminPassword = env.ADMIN_PASSWORD || '';
  const passwordHash = password ? await sha256Hex(password) : '';
  const adminPasswordHash = adminPassword ? await sha256Hex(adminPassword) : '';
  const modified = injectPasswordConfig(html, passwordHash, adminPasswordHash);

  const headers = new Headers(response.headers);
  // 宽松 CSP（与 server.mjs 一致，防御纵深）
  headers.set(
    'Content-Security-Policy',
    "default-src 'self' data: https: http:; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https: http: blob:; " +
    "media-src 'self' https: http: blob:; " +
    "connect-src 'self' https: http:; " +
    "frame-src 'self' https: http:; " +
    "font-src 'self' data:; " +
    "worker-src 'self' blob:;"
  );

  return new Response(modified, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}