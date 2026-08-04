// api/proxy/[...path].mjs
// Vercel Serverless Function：/proxy/* → fetch + 改写 M3U8
// 公共逻辑下沉到 proxy-core，本文件只剩 Vercel 运行时差异（req/res 风格）

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
} from '../../proxy-core/index.mjs';

// --- Configuration ---
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10); // 默认 24 小时
const MAX_RECURSION = parseInt(process.env.MAX_RECURSION || '10', 10); // 阶段 2.13 默认值提升
const USER_AGENTS = parseUserAgents(process.env.USER_AGENTS_JSON, {
  onWarn: (msg) => console.warn(`[代理日志] ${msg}`),
});

function logDebug(message) {
  if (DEBUG_ENABLED) console.log(`[代理日志] ${message}`);
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
  logDebug(`准备请求目标: ${targetUrl}，请求头: ${JSON.stringify(headers)}`);

  try {
    const { content, contentType, responseHeaders } = await safeFetchText(targetUrl, {
      fetchInit: { headers, redirect: 'follow' },
    });
    // 注意：safeFetchText 不区分 4xx / 5xx，需要在调用方检查
    // 这里通过 contentType / content 长度判断是否合法
    logDebug(`请求成功: ${targetUrl}, Content-Type: ${contentType}, 内容长度: ${content.length}`);
    return { content, contentType, responseHeaders };
  } catch (error) {
    logDebug(`请求异常 ${targetUrl}: ${error.message}`);
    throw new Error(`请求目标 URL 失败 ${targetUrl}: ${error.message}`);
  }
}

// --- M3U8 递归 ---
async function processMasterPlaylist(url, content, recursionDepth) {
  if (recursionDepth > MAX_RECURSION) {
    throw new Error(`处理主播放列表时，递归深度超过最大限制 (${MAX_RECURSION}): ${url}`);
  }
  const baseUrl = getBaseUrl(url);
  const bestVariantUrl = pickBestVariant(content, baseUrl);
  if (!bestVariantUrl) {
    logDebug(`在主播放列表 ${url} 中未找到有效的子列表 URI，将其作为媒体列表处理。`);
    return processMediaPlaylist(url, content);
  }
  logDebug(`选择的子播放列表: ${bestVariantUrl}`);
  const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl, {});
  if (!isM3u8Content(variantContent, variantContentType)) {
    logDebug(`获取的子播放列表 ${bestVariantUrl} 不是 M3U8 (类型: ${variantContentType})，将其作为媒体列表处理。`);
    return processMediaPlaylist(bestVariantUrl, variantContent);
  }
  return processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1);
}

async function processM3u8Content(targetUrl, content, recursionDepth = 0) {
  if (isMasterPlaylist(content)) {
    logDebug(`检测到主播放列表: ${targetUrl} (深度: ${recursionDepth})`);
    return processMasterPlaylist(targetUrl, content, recursionDepth);
  }
  logDebug(`检测到媒体播放列表: ${targetUrl} (深度: ${recursionDepth})`);
  return processMediaPlaylist(targetUrl, content);
}

// --- Vercel Handler ---
export default async function handler(req, res) {
  // CORS 头一次性设置，避免后续错误响应漏掉
  const corsHeaders = buildCorsHeaders({ allowMethods: 'GET, HEAD, OPTIONS' });
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (isPreflight(req.method)) {
    logDebug('处理 OPTIONS 预检请求');
    const pre = preflightResponse();
    res.status(pre.status).setHeader('Access-Control-Max-Age', pre.headers['Access-Control-Max-Age']).end();
    return;
  }

  let targetUrl = null;
  try {
    // 阶段 2.1 / 2.3：单次鉴权，统一为「未设 PASSWORD = 无密码」
    const isAuthorized = await validateAuth({
      authHash: req.query.auth,
      timestamp: req.query.t,
      serverPassword: process.env.PASSWORD,
      alternatePasswords: [process.env.ADMIN_PASSWORD],
    });
    if (!isAuthorized) {
      console.warn('代理请求鉴权失败');
      res.status(401).json({ success: false, error: '代理访问未授权：请检查密码配置或鉴权参数' });
      return;
    }

    // --- Extract Target URL ---
    const pathData = req.query['...path'];
    let encodedUrlPath = '';
    if (pathData) {
      encodedUrlPath = Array.isArray(pathData) ? pathData.join('/') : String(pathData);
    } else if (req.url?.startsWith('/proxy/')) {
      encodedUrlPath = req.url.substring('/proxy/'.length);
    }
    if (!encodedUrlPath) throw new Error('无法从请求中确定编码后的目标路径。');

    targetUrl = getTargetUrlFromPath(encodedUrlPath);
    logDebug(`解析出的目标 URL: ${targetUrl || 'null'}`);
    if (!targetUrl) throw new Error(`无效的代理请求路径。无法从组合路径 "${encodedUrlPath}" 中提取有效的目标 URL。`);

    logDebug(`开始处理目标 URL 的代理请求: ${targetUrl}`);

    // --- 二进制图片快速通道：直接透传字节，避免被当作文本做 UTF-8 解码而损坏 ---
    if (isImageUrl(targetUrl)) {
      try {
        const imgHeaders = {
          'User-Agent': randomUserAgent(USER_AGENTS),
          'Accept': 'image/*,*/*',
          'Accept-Language': req.headers?.['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
          'Referer': req.headers?.referer || new URL(targetUrl).origin,
        };
        const { buffer, contentType, responseHeaders } = await safeFetchBinary(targetUrl, {
          fetchInit: { headers: imgHeaders, redirect: 'follow' },
        });
        logDebug(`图片代理透传: ${targetUrl}, Content-Type: ${contentType}, 字节: ${buffer.byteLength}`);
        responseHeaders.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (!lower.startsWith('access-control-') && lower !== 'content-encoding' && lower !== 'content-length') {
            res.setHeader(key, value);
          }
        });
        res
          .status(200)
          .setHeader('Content-Type', contentType || 'application/octet-stream')
          .setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`)
          .send(Buffer.from(buffer));
        return;
      } catch (imgErr) {
        logDebug(`图片代理失败: ${imgErr.message}`);
        if (!res.headersSent) {
          res.status((imgErr.status && imgErr.status < 500) ? imgErr.status : 502)
            .setHeader('Content-Type', 'application/json')
            .json({ success: false, error: `图片代理失败: ${imgErr.message}`, targetUrl });
        } else if (!res.writableEnded) {
          res.end();
        }
        return;
      }
    }

    // --- Fetch + Process ---
    const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl, req.headers);

    if (isM3u8Content(content, contentType)) {
      logDebug(`正在处理 M3U8 内容: ${targetUrl}`);
      const processedM3u8 = await processM3u8Content(targetUrl, content);
      res
        .status(200)
        .setHeader('Content-Type', 'application/vnd.apple.mpegurl;charset=utf-8')
        .setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`)
        .removeHeader('content-encoding') // node-fetch 已解压
        .removeHeader('content-length')   // 长度已改变
        .send(processedM3u8);
      return;
    }

    logDebug(`直接返回非 M3U8 内容: ${targetUrl}, 类型: ${contentType}`);
    responseHeaders.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!lower.startsWith('access-control-') && lower !== 'content-encoding' && lower !== 'content-length') {
        res.setHeader(key, value);
      }
    });
    res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`).status(200).send(content);
  } catch (error) {
    console.error(`[代理错误] 目标: ${targetUrl || '解析失败'} | 类型: ${error.constructor.name} | 消息: ${error.message}`);
    logDebug(`堆栈: ${error.stack}`);
    const statusCode = error.status || 500;
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      res.status(statusCode).json({
        success: false,
        error: `代理处理错误: ${error.message}`,
        targetUrl,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}