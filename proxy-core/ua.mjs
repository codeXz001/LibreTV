// proxy-core/ua.mjs
// 跨平台共享的 User-Agent 列表加载与随机选择

export const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
];

/**
 * 解析环境变量里的 USER_AGENTS_JSON，失败时回落到默认值。
 *
 * @param {string|undefined|null} jsonString - 环境变量原始值
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.onWarn] - 解析失败时的回调
 * @returns {string[]}
 */
export function parseUserAgents(jsonString, opts = {}) {
  const warn = opts.onWarn || (() => {});
  if (!jsonString) return [...DEFAULT_USER_AGENTS];
  try {
    const parsed = JSON.parse(jsonString);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(x => typeof x === 'string')) {
      return parsed;
    }
    warn('USER_AGENTS_JSON 不是有效的非空字符串数组，使用默认值');
    return [...DEFAULT_USER_AGENTS];
  } catch (e) {
    warn(`解析 USER_AGENTS_JSON 失败: ${e.message}，使用默认值`);
    return [...DEFAULT_USER_AGENTS];
  }
}

/**
 * 从 UA 列表里随机挑一个。
 *
 * @param {string[]} userAgents
 * @returns {string}
 */
export function randomUserAgent(userAgents) {
  if (!userAgents || userAgents.length === 0) return DEFAULT_USER_AGENTS[0];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}