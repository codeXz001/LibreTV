// proxy-core/m3u8.mjs
// 跨平台共享的 M3U8 处理工具
// 4 套代理里的 11 个函数完全等价，这里统一为单一实现

/**
 * 把路径前缀替换为空，拿到编码后的目标 URL。
 *
 * @param {string} pathname - 类似 "/proxy/https%3A%2F%2F..."
 * @param {string} prefix - 类似 "/proxy/"
 * @returns {string} 编码后的 URL 字符串；空则返回 ''
 */
export function extractEncodedFromPath(pathname, prefix) {
  if (!pathname || !prefix) return '';
  if (!pathname.startsWith(prefix)) return '';
  return pathname.substring(prefix.length);
}

/**
 * 从代理请求路径中提取真正的目标 URL。
 *
 * 行为与原 4 套代理的 `getTargetUrlFromPath` 完全一致：
 *   1. 先尝试 `decodeURIComponent`；
 *   2. 解码后必须以 http(s):// 开头，否则尝试把原 path 当作 URL；
 *   3. 都失败返回 null。
 *
 * @param {string} encodedPath
 * @returns {string|null}
 */
export function getTargetUrlFromPath(encodedPath) {
  if (!encodedPath) return null;
  try {
    const decoded = decodeURIComponent(encodedPath);
    if (decoded.match(/^https?:\/\/.+/i)) return decoded;
    if (encodedPath.match(/^https?:\/\/.+/i)) return encodedPath;
    return null;
  } catch {
    return null;
  }
}

/**
 * 取 URL 的基础路径（去掉最后一段），用于解析相对引用。
 *
 * @param {string} urlStr
 * @returns {string}
 */
export function getBaseUrl(urlStr) {
  if (!urlStr) return '';
  try {
    const parsed = new URL(urlStr);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length <= 1) return `${parsed.origin}/`;
    segments.pop();
    return `${parsed.origin}/${segments.join('/')}/`;
  } catch {
    const lastSlash = urlStr.lastIndexOf('/');
    if (lastSlash > urlStr.indexOf('://') + 2) return urlStr.substring(0, lastSlash + 1);
    return urlStr + '/';
  }
}

/**
 * 把相对 URL 转绝对 URL。
 *
 * @param {string} baseUrl
 * @param {string} relativeUrl
 * @returns {string}
 */
export function resolveUrl(baseUrl, relativeUrl) {
  if (!relativeUrl) return '';
  if (relativeUrl.match(/^https?:\/\/.+/i)) return relativeUrl;
  if (!baseUrl) return relativeUrl;
  try {
    return new URL(relativeUrl, baseUrl).toString();
  } catch {
    if (relativeUrl.startsWith('/')) {
      try {
        const origin = new URL(baseUrl).origin;
        return `${origin}${relativeUrl}`;
      } catch {
        return relativeUrl;
      }
    }
    return `${baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)}${relativeUrl}`;
  }
}

/**
 * 把绝对 URL 改写为内部代理路径。
 *
 * 注意：这里固定使用 `/proxy/` 前缀，与前端 `PROXY_URL = '/proxy/'`、
 * Vercel `vercel.json` 的 rewrite 规则、Netlify `netlify.toml` 的 redirect 规则保持一致。
 *
 * @param {string} targetUrl
 * @returns {string}
 */
export function rewriteUrlToProxy(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') return '';
  return `/proxy/${encodeURIComponent(targetUrl)}`;
}

/**
 * 判断响应内容是否为 M3U8。
 *
 * @param {string} content
 * @param {string} contentType
 * @returns {boolean}
 */
export function isM3u8Content(content, contentType) {
  if (contentType && (
    contentType.includes('application/vnd.apple.mpegurl') ||
    contentType.includes('application/x-mpegurl') ||
    contentType.includes('audio/mpegurl')
  )) {
    return true;
  }
  return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

/**
 * 处理 M3U8 中的 #EXT-X-KEY 行的 URI（加密密钥）。
 *
 * @param {string} line
 * @param {string} baseUrl
 * @returns {string}
 */
export function processKeyLine(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const absoluteUri = resolveUrl(baseUrl, uri);
    return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
  });
}

/**
 * 处理 M3U8 中的 #EXT-X-MAP 行的 URI（初始化片段）。
 *
 * @param {string} line
 * @param {string} baseUrl
 * @returns {string}
 */
export function processMapLine(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const absoluteUri = resolveUrl(baseUrl, uri);
    return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
  });
}

/**
 * 处理媒体 M3U8 播放列表（包含视频/音频片段）。
 *
 * @param {string} url
 * @param {string} content
 * @returns {string}
 */
export function processMediaPlaylist(url, content) {
  const baseUrl = getBaseUrl(url);
  const lines = content.split('\n');
  const output = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line && i === lines.length - 1) {
      output.push(line);
      continue;
    }
    if (!line) continue;

    if (line.startsWith('#EXT-X-KEY')) {
      output.push(processKeyLine(line, baseUrl));
      continue;
    }
    if (line.startsWith('#EXT-X-MAP')) {
      output.push(processMapLine(line, baseUrl));
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      output.push(line);
      continue;
    }
    if (!line.startsWith('#')) {
      const absoluteUrl = resolveUrl(baseUrl, line);
      output.push(rewriteUrlToProxy(absoluteUrl));
      continue;
    }
    output.push(line);
  }

  return output.join('\n');
}

/**
 * 找出主播放列表中带宽最高的子列表 URI。
 *
 * @param {string} content
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function pickBestVariant(content, baseUrl) {
  const lines = content.split('\n');
  let highestBandwidth = -1;
  let bestVariantUrl = '';

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
      let variantUriLine = '';
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();
        if (line && !line.startsWith('#')) {
          variantUriLine = line;
          i = j;
          break;
        }
      }
      if (variantUriLine && currentBandwidth >= highestBandwidth) {
        highestBandwidth = currentBandwidth;
        bestVariantUrl = resolveUrl(baseUrl, variantUriLine);
      }
    }
  }

  // 主列表里没有 BANDWIDTH 时，按 .m3u8 结尾顺序找第一个子列表
  if (!bestVariantUrl) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.startsWith('#') && line.match(/\.m3u8($|\?.*)/i)) {
        bestVariantUrl = resolveUrl(baseUrl, line);
        break;
      }
    }
  }

  return bestVariantUrl || null;
}

/**
 * 判断 M3U8 内容是否是主播放列表（含 STREAM-INF 或 MEDIA 标签）。
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isMasterPlaylist(content) {
  return content && (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:'));
}