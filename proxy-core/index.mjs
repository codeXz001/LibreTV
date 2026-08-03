// proxy-core/index.mjs
// 聚合导出，方便各平台薄壳一次 import。

export {
  extractEncodedFromPath,
  getTargetUrlFromPath,
  getBaseUrl,
  resolveUrl,
  rewriteUrlToProxy,
  isM3u8Content,
  processKeyLine,
  processMapLine,
  processMediaPlaylist,
  pickBestVariant,
  isMasterPlaylist,
} from './m3u8.mjs';

export { sha256Hex, validateAuth } from './auth.mjs';
export { isValidUrl, checkContentLength, DEFAULT_MAX_RESPONSE_BYTES } from './security.mjs';
export {
  buildCorsHeaders,
  isPreflight,
  preflightResponse,
  sensitiveHeaderSet,
  DEFAULT_CORS_METHODS,
  DEFAULT_CORS_ALLOW_ALL,
} from './cors.mjs';
export { parseUserAgents, randomUserAgent, DEFAULT_USER_AGENTS } from './ua.mjs';
export { safeFetchText, safeFetchBinary, isImageUrl } from './safe-fetch.mjs';