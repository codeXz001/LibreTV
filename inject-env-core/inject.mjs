// inject-env-core/inject.mjs
// 跨平台共享的密码哈希注入函数

const PASSWORD_PLACEHOLDER = 'window.__ENV__.PASSWORD = "{{PASSWORD}}";';
const ADMIN_PASSWORD_PLACEHOLDER = 'window.__ENV__.ADMIN_PASSWORD = "{{ADMIN_PASSWORD}}";';
const PASSWORD_PREFIX = 'window.__ENV__.PASSWORD = "';
const ADMIN_PASSWORD_PREFIX = 'window.__ENV__.ADMIN_PASSWORD = "';
const REPLACEMENT_SUFFIX = '";';

/**
 * 把 HTML 中的普通密码和管理员密码占位符替换为 SHA-256 哈希。
 * 管理员密码只用于额外的非色情管理功能，不能关闭敏感内容保护。
 *
 * @param {string} html - 原始 HTML 内容
 * @param {string} passwordHash - 普通密码哈希
 * @param {string} [adminPasswordHash] - 管理员密码哈希
 * @returns {string} 注入后的 HTML
 */
export function injectPasswordConfig(html, passwordHash, adminPasswordHash = '') {
  let result = html.replace(
    PASSWORD_PLACEHOLDER,
    `${PASSWORD_PREFIX}${passwordHash || ''}${REPLACEMENT_SUFFIX}`
  );
  return result.replace(
    ADMIN_PASSWORD_PLACEHOLDER,
    `${ADMIN_PASSWORD_PREFIX}${adminPasswordHash || ''}${REPLACEMENT_SUFFIX}`
  );
}

/**
 * 兼容旧调用方：只注入普通密码哈希。
 *
 * @param {string} html - 原始 HTML 内容
 * @param {string} passwordHash - 普通密码哈希
 * @returns {string} 注入后的 HTML
 */
export function injectPasswordHash(html, passwordHash) {
  return injectPasswordConfig(html, passwordHash, '');
}
