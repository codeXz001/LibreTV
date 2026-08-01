// netlify/edge-functions/inject-env.js
// Netlify Edge Function：把 PASSWORD SHA-256 注入到 HTML
// 公共逻辑下沉到 inject-env-core，本文件只剩 Netlify Edge 运行时差异

import { sha256Hex, injectPasswordHash } from '../../inject-env-core/index.mjs';

export default async (request, context) => {
  const url = new URL(request.url);

  const isHtmlPage = url.pathname.endsWith('.html') || url.pathname === '/';
  if (!isHtmlPage) return; // 直通

  const response = await context.next();
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const originalHtml = await response.text();
  const password = Netlify.env.get('PASSWORD') || '';
  const passwordHash = password ? await sha256Hex(password) : '';
  const modifiedHtml = injectPasswordHash(originalHtml, passwordHash);

  return new Response(modifiedHtml, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export const config = {
  path: ['/*'],
};