// netlify/functions/proxy.mjs
// Netlify Function：/proxy/* → fetch + 改写 M3U8
// 公共逻辑（鉴权 / CORS / UA / M3U8 解析）下沉到 proxy-core，本文件只剩运行时差异

import {
  validateAuth,
  buildCorsHeaders,
  isPreflight,
  preflightResponse,
  parseUserAgents,
  randomUserAgent,
  getTargetUrlFromPath,
  getBaseUrl,
  processMediaPlaylist,
  isM3u8Content,
  isMasterPlaylist,
  pickBestVariant,
  safeFetchText,
  safeFetchBinary,
  isImageUrl,
  DEFAULT_CORS_ALLOW_ALL,
} from '../../proxy-core/index.mjs';

// --- Configuration ---
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10);
const MAX_RECURSION = parseInt(process.env.MAX_RECURSION || '10', 10); // 阶段 2.13 默认值提升
const USER_AGENTS = parseUserAgents(process.env.USER_AGENTS_JSON, {
  onWarn: (msg) => console.warn(`[Proxy Log Netlify] ${msg}`),
});

// --- Logging ---
function logDebug(message) {
  if (DEBUG_ENABLED) console.log(`[Proxy Log Netlify] ${message}`);
}

// --- Fetch (阶段 2.11：使用 safeFetchText 防 GB 级响应撑爆内存) ---
async function fetchContentWithType(targetUrl, requestHeaders) {
  const headers = {
    'User-Agent': randomUserAgent(USER_AGENTS),
    'Accept': requestHeaders?.accept || '*/*',
    'Accept-Language': requestHeaders?.['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': requestHeaders?.referer || new URL(targetUrl).origin,
  };
  for (const k of Object.keys(headers)) {
    if (headers[k] === undefined || headers[k] === null || headers[k] === '') delete headers[k];
  }

  try {
    const { content, contentType, responseHeaders } = await safeFetchText(targetUrl, {
      fetchInit: { headers, redirect: 'follow' },
    });
    logDebug(`Fetch success: ${targetUrl}, Content-Type: ${contentType}, Length: ${content.length}`);
    return { content, contentType, responseHeaders };
  } catch (error) {
    logDebug(`Fetch exception for ${targetUrl}: ${error.message}`);
    throw new Error(`Failed to fetch target URL ${targetUrl}: ${error.message}`);
  }
}

// --- M3U8 ---
// 递归处理：选带宽最高的子列表 → 拉取 → 再判断主/媒体列表 → 改写
async function processMasterPlaylist(url, content, recursionDepth) {
  if (recursionDepth > MAX_RECURSION) {
    throw new Error(`Max recursion depth (${MAX_RECURSION}) exceeded for master playlist: ${url}`);
  }
  const baseUrl = getBaseUrl(url);
  const bestVariantUrl = pickBestVariant(content, baseUrl);
  if (!bestVariantUrl) {
    logDebug(`No valid sub-playlist URI found in master: ${url}. Processing as media playlist.`);
    return processMediaPlaylist(url, content);
  }
  logDebug(`Selected sub-playlist: ${bestVariantUrl}`);

  const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl, {});
  if (!isM3u8Content(variantContent, variantContentType)) {
    logDebug(`Fetched sub-playlist ${bestVariantUrl} is not M3U8. Treating as media playlist.`);
    return processMediaPlaylist(bestVariantUrl, variantContent);
  }
  return processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1);
}

async function processM3u8Content(targetUrl, content, recursionDepth = 0) {
  if (isMasterPlaylist(content)) {
    logDebug(`Detected master playlist: ${targetUrl} (Depth: ${recursionDepth})`);
    return processMasterPlaylist(targetUrl, content, recursionDepth);
  }
  logDebug(`Detected media playlist: ${targetUrl} (Depth: ${recursionDepth})`);
  return processMediaPlaylist(targetUrl, content);
}

// --- Response shaping ---
function filterUpstreamHeaders(responseHeaders) {
  const out = {};
  responseHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      !lower.startsWith('access-control-') &&
      lower !== 'content-encoding' &&
      lower !== 'content-length'
    ) {
      out[key] = value;
    }
  });
  return out;
}

function buildErrorResponse(statusCode, message, targetUrl) {
  return {
    statusCode,
    headers: { ...buildCorsHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, error: message, targetUrl }),
  };
}

// --- Netlify Handler ---
export const handler = async (event) => {
  const corsHeaders = buildCorsHeaders();
  const method = event.httpMethod;

  if (isPreflight(method)) {
    logDebug('Handling OPTIONS preflight');
    const pre = preflightResponse();
    return { statusCode: pre.status, headers: pre.headers, body: '' };
  }

  // 阶段 2.1 / 2.3：单次鉴权，统一为「未设 PASSWORD = 无密码」
  const queryParams = event.queryStringParameters || {};
  const isAuthorized = await validateAuth({
    authHash: queryParams.auth,
    timestamp: queryParams.t,
    serverPassword: process.env.PASSWORD,
  });
  if (!isAuthorized) {
    console.warn('Netlify 代理请求鉴权失败');
    return buildErrorResponse(401, '代理访问未授权：请检查密码配置或鉴权参数');
  }

  // --- Extract Target URL ---
  const proxyPrefix = '/proxy/';
  let encodedUrlPath = '';
  if (event.path?.startsWith(proxyPrefix)) {
    encodedUrlPath = event.path.substring(proxyPrefix.length);
  } else {
    logDebug(`Could not extract encoded path from event.path: ${event.path}`);
  }

  const targetUrl = getTargetUrlFromPath(encodedUrlPath);
  logDebug(`Resolved target URL: ${targetUrl || 'null'}`);
  if (!targetUrl) {
    return buildErrorResponse(400, 'Invalid proxy request path. Could not extract target URL.');
  }

  // --- 二进制图片快速通道：直接透传字节，避免被当作文本做 UTF-8 解码而损坏 ---
  if (isImageUrl(targetUrl)) {
    try {
      const imgHeaders = {
        'User-Agent': randomUserAgent(USER_AGENTS),
        'Accept': 'image/*,*/*',
        'Accept-Language': event.headers?.['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': event.headers?.referer || new URL(targetUrl).origin,
      };
      const { buffer, contentType, responseHeaders } = await safeFetchBinary(targetUrl, {
        fetchInit: { headers: imgHeaders, redirect: 'follow' },
      });
      logDebug(`图片代理透传: ${targetUrl}, Content-Type: ${contentType}, 字节: ${buffer.byteLength}`);
      const netlifyHeaders = { ...corsHeaders, ...filterUpstreamHeaders(responseHeaders) };
      netlifyHeaders['Content-Type'] = contentType || 'application/octet-stream';
      netlifyHeaders['Cache-Control'] = `public, max-age=${CACHE_TTL}`;
      return { statusCode: 200, headers: netlifyHeaders, body: Buffer.from(buffer) };
    } catch (imgErr) {
      logDebug(`图片代理失败: ${imgErr.message}`);
      return buildErrorResponse((imgErr.status && imgErr.status < 500) ? imgErr.status : 502, `图片代理失败: ${imgErr.message}`, targetUrl);
    }
  }

  // --- Fetch + Process ---
  try {
    const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl, event.headers || {});

    if (isM3u8Content(content, contentType)) {
      logDebug(`Processing M3U8 content: ${targetUrl}`);
      const processedM3u8 = await processM3u8Content(targetUrl, content);
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/vnd.apple.mpegurl;charset=utf-8',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
        },
        body: processedM3u8,
      };
    }

    logDebug(`Returning non-M3U8 content directly: ${targetUrl}, Type: ${contentType}`);
    const netlifyHeaders = { ...corsHeaders, ...filterUpstreamHeaders(responseHeaders) };
    netlifyHeaders['Cache-Control'] = `public, max-age=${CACHE_TTL}`;
    return { statusCode: 200, headers: netlifyHeaders, body: content };
  } catch (error) {
    logDebug(`ERROR in proxy processing for ${targetUrl}: ${error.message}`);
    console.error(`[Proxy Error Stack Netlify] ${error.stack}`);
    const statusCode = error.status || 500;
    return buildErrorResponse(statusCode, `Proxy processing error: ${error.message}`, targetUrl);
  }
};

// 避免 lint 报 unused 警告（DEFAULT_CORS_ALLOW_ALL 在 buildCorsHeaders 默认值用到）
void DEFAULT_CORS_ALLOW_ALL;