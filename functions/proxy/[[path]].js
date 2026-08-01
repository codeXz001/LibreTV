// functions/proxy/[[path]].js
// Cloudflare Pages Function：/proxy/* → fetch + 改写 M3U8（带 KV 缓存）
// 公共逻辑下沉到 proxy-core，本文件保留 Cloudflare 特有的 KV 缓存层与 waitUntil 集成

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
} from '../../proxy-core/index.mjs';

// --- Configuration (from Cloudflare env bindings) ---
export async function onRequest(context) {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);

    const DEBUG_ENABLED = env.DEBUG === 'true';
    const CACHE_TTL = parseInt(env.CACHE_TTL || '86400');
    const MAX_RECURSION = parseInt(env.MAX_RECURSION || '10'); // 阶段 2.13 默认值提升
    const USER_AGENTS = parseUserAgents(env.USER_AGENTS_JSON, {
      onWarn: (msg) => logDebug(msg),
    });

    function logDebug(message) {
      if (DEBUG_ENABLED) console.log(`[Proxy Func] ${message}`);
    }

    // --- Auth: 单次校验（阶段 2.1 修复重复调用） ---
    const isValidAuth = await validateAuth({
      authHash: url.searchParams.get('auth'),
      timestamp: url.searchParams.get('t'),
      serverPassword: env.PASSWORD,
    });
    if (!isValidAuth) {
      return new Response(JSON.stringify({
        success: false,
        error: '代理访问未授权：请检查密码配置或鉴权参数',
      }), {
        status: 401,
        headers: {
          ...buildCorsHeaders(),
          'Content-Type': 'application/json',
        },
      });
    }

    // --- Response helpers ---
    function createResponse(body, status = 200, headers = {}) {
      const h = new Headers(headers);
      Object.entries(buildCorsHeaders()).forEach(([k, v]) => h.set(k, v));
      // OPTIONS 在调用方单独处理；这里只处理常规响应
      return new Response(body, { status, headers: h });
    }

    function createM3u8Response(content) {
      return createResponse(content, 200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
      });
    }

    // --- Fetch (阶段 2.11：使用 safeFetchText 防 GB 级响应撑爆内存) ---
    async function fetchContentWithType(targetUrl) {
      const headers = new Headers({
        'User-Agent': randomUserAgent(USER_AGENTS),
        'Accept': '*/*',
        'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': request.headers.get('Referer') || new URL(targetUrl).origin,
      });

      try {
        logDebug(`开始直接请求: ${targetUrl}`);
        const { content, contentType, responseHeaders } = await safeFetchText(targetUrl, {
          fetchInit: { headers, redirect: 'follow' },
        });
        logDebug(`请求成功: ${targetUrl}, Content-Type: ${contentType}, 内容长度: ${content.length}`);
        return { content, contentType, responseHeaders };
      } catch (error) {
        logDebug(`请求彻底失败: ${targetUrl}: ${error.message}`);
        throw new Error(`请求目标URL失败 ${targetUrl}: ${error.message}`);
      }
    }

    // --- M3U8 递归（含 KV 缓存层） ---
    let kvNamespace = null;
    try {
      kvNamespace = env.LIBRETV_PROXY_KV;
      if (!kvNamespace) throw new Error('KV 命名空间未绑定');
    } catch (e) {
      // 阶段 2.8：仅启动期提示一次，运行时不抛错
      logDebug(`KV 命名空间 'LIBRETV_PROXY_KV' 访问出错或未绑定: ${e.message}`);
      kvNamespace = null;
    }

    async function processMasterPlaylist(url, content, recursionDepth) {
      if (recursionDepth > MAX_RECURSION) {
        throw new Error(`处理主列表时递归层数过多 (${MAX_RECURSION}): ${url}`);
      }
      const baseUrl = getBaseUrl(url);
      const bestVariantUrl = pickBestVariant(content, baseUrl);
      if (!bestVariantUrl) {
        logDebug(`在主列表 ${url} 中未找到任何有效的子播放列表 URL，按媒体列表处理。`);
        return processMediaPlaylist(url, content);
      }

      // --- KV 读取子列表缓存 ---
      const cacheKey = `m3u8_processed:${bestVariantUrl}`;
      if (kvNamespace) {
        try {
          const cached = await kvNamespace.get(cacheKey);
          if (cached) {
            logDebug(`[缓存命中] 主列表的子列表: ${bestVariantUrl}`);
            return cached;
          }
        } catch (kvError) {
          logDebug(`从 KV 读取缓存失败 (${cacheKey}): ${kvError.message}`);
        }
      }

      logDebug(`选择的子列表: ${bestVariantUrl}`);
      const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl);
      if (!isM3u8Content(variantContent, variantContentType)) {
        logDebug(`获取到的子列表 ${bestVariantUrl} 不是 M3U8 内容 (类型: ${variantContentType})，按媒体列表处理。`);
        return processMediaPlaylist(bestVariantUrl, variantContent);
      }
      const processedVariant = await processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1);

      // --- KV 写入（异步，不阻塞响应） ---
      if (kvNamespace) {
        waitUntil(kvNamespace.put(cacheKey, processedVariant, { expirationTtl: CACHE_TTL }));
      }
      return processedVariant;
    }

    async function processM3u8Content(targetUrl, content, recursionDepth = 0) {
      if (isMasterPlaylist(content)) {
        logDebug(`检测到主播放列表: ${targetUrl}`);
        return processMasterPlaylist(targetUrl, content, recursionDepth);
      }
      logDebug(`检测到媒体播放列表: ${targetUrl}`);
      return processMediaPlaylist(targetUrl, content);
    }

    // --- Main handler ---
    try {
      const targetUrl = getTargetUrlFromPath(url.pathname.replace(/^\/proxy\//, ''));
      if (!targetUrl) {
        return createResponse('无效的代理请求。路径应为 /proxy/<经过编码的URL>', 400);
      }
      logDebug(`收到代理请求: ${targetUrl}`);

      // --- KV 原始内容缓存 ---
      const cacheKey = `proxy_raw:${targetUrl}`;
      if (kvNamespace) {
        try {
          const cachedJson = await kvNamespace.get(cacheKey);
          if (cachedJson) {
            const cachedData = JSON.parse(cachedJson);
            const content = cachedData.body;
            let headers = {};
            try { headers = JSON.parse(cachedData.headers); } catch { /* 忽略 */ }
            const contentType = headers['content-type'] || headers['Content-Type'] || '';
            if (isM3u8Content(content, contentType)) {
              logDebug(`缓存内容是 M3U8，重新处理: ${targetUrl}`);
              const processedM3u8 = await processM3u8Content(targetUrl, content, 0);
              return createM3u8Response(processedM3u8);
            }
            logDebug(`从缓存返回非 M3U8 内容: ${targetUrl}`);
            return createResponse(content, 200, new Headers(headers));
          }
        } catch (kvError) {
          logDebug(`从 KV 读取或解析缓存失败 (${cacheKey}): ${kvError.message}`);
        }
      }

      // --- 实际请求 ---
      const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl);

      // --- 写入原始内容缓存 ---
      if (kvNamespace) {
        try {
          const headersToCache = {};
          responseHeaders.forEach((value, key) => { headersToCache[key.toLowerCase()] = value; });
          const cacheValue = { body: content, headers: JSON.stringify(headersToCache) };
          waitUntil(kvNamespace.put(cacheKey, JSON.stringify(cacheValue), { expirationTtl: CACHE_TTL }));
        } catch (kvError) {
          logDebug(`向 KV 写入缓存失败 (${cacheKey}): ${kvError.message}`);
        }
      }

      // --- 处理响应 ---
      if (isM3u8Content(content, contentType)) {
        logDebug(`内容是 M3U8，开始处理: ${targetUrl}`);
        const processedM3u8 = await processM3u8Content(targetUrl, content, 0);
        return createM3u8Response(processedM3u8);
      }
      logDebug(`内容不是 M3U8 (类型: ${contentType})，直接返回: ${targetUrl}`);
      const finalHeaders = new Headers(responseHeaders);
      finalHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
      return createResponse(content, 200, finalHeaders);
    } catch (error) {
      logDebug(`处理代理请求时发生严重错误: ${error.message} \n ${error.stack}`);
      return createResponse(`代理处理错误: ${error.message}`, 500);
    }
}

// --- CORS 预检 ---
export async function onOptions() {
  const pre = preflightResponse();
  return new Response(null, { status: pre.status, headers: new Headers(pre.headers) });
}