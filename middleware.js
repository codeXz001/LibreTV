// middleware.js
// Vercel Edge Middleware：把 PASSWORD SHA-256 注入到 HTML
// 公共逻辑下沉到 inject-env-core，本文件只剩 Vercel Edge 运行时差异

import { sha256Hex, injectPasswordHash } from './inject-env-core/index.mjs';

export default async function middleware(request) {
  const url = new URL(request.url);

  // 只处理 HTML 页面
  const isHtmlPage = url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  if (!isHtmlPage) return; // 让其他请求直通

  const response = await fetch(request);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const originalHtml = await response.text();
  const password = process.env.PASSWORD || '';
  const passwordHash = password ? await sha256Hex(password) : '';

  const modifiedHtml = injectPasswordHash(originalHtml, passwordHash);

  return new Response(modifiedHtml, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const config = {
  matcher: ['/', '/((?!api|_next/static|_vercel|favicon.ico).*)'],
};