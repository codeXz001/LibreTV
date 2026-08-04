/**
 * 代理请求鉴权模块
 * 为代理请求添加基于普通密码或管理员密码的鉴权机制。
 * 管理员密码只用于非色情管理模式，内容过滤仍由前端强制开启。
 */
let cachedPasswordHash = null;

function readVerifiedPasswordHash() {
    try {
        const raw = localStorage.getItem('passwordVerified');
        if (!raw) return null;
        const state = JSON.parse(raw);
        if (!state || state.verified !== true || !state.passwordHash) return null;
        if (typeof window.isPasswordVerified === 'function' && !window.isPasswordVerified()) return null;
        return state.passwordHash;
    } catch (error) {
        console.warn('读取密码鉴权状态失败:', error);
        return null;
    }
}

/**
 * 获取当前会话的密码哈希。
 */
async function getPasswordHash() {
    if (cachedPasswordHash) return cachedPasswordHash;

    const verifiedHash = readVerifiedPasswordHash();
    if (verifiedHash) {
        localStorage.setItem('proxyAuthHash', verifiedHash);
        cachedPasswordHash = verifiedHash;
        return verifiedHash;
    }

    // 兼容旧版手动保存的 userPassword。
    const userPassword = localStorage.getItem('userPassword');
    if (userPassword) {
        try {
            const sha256Fn = window._jsSha256 || window.sha256;
            if (typeof sha256Fn !== 'function') throw new Error('sha256 实现不可用');
            const hash = await sha256Fn(userPassword);
            localStorage.setItem('proxyAuthHash', hash);
            cachedPasswordHash = hash;
            return hash;
        } catch (error) {
            console.error('生成密码哈希失败:', error);
        }
    }

    // 无密码模式下不添加鉴权参数；服务端会按无密码模式处理。
    return null;
}

/**
 * 为代理请求 URL 添加鉴权参数。
 */
async function addAuthToProxyUrl(url) {
    try {
        const hash = await getPasswordHash();
        if (!hash) return url;

        const timestamp = Date.now();
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}auth=${encodeURIComponent(hash)}&t=${timestamp}`;
    } catch (error) {
        console.error('添加代理鉴权失败:', error);
        return url;
    }
}

/**
 * 验证代理请求鉴权。
 */
function validateProxyAuth(authHash, serverPasswordHash, timestamp) {
    if (!authHash || !serverPasswordHash) return false;
    if (authHash !== serverPasswordHash) return false;

    const now = Date.now();
    const maxAge = 10 * 60 * 1000;
    if (timestamp && (now - parseInt(timestamp, 10)) > maxAge) {
        console.warn('代理请求时间戳过期');
        return false;
    }
    return true;
}

function clearAuthCache() {
    cachedPasswordHash = null;
    localStorage.removeItem('proxyAuthHash');
}

window.addEventListener('storage', (e) => {
    if (e.key === 'userPassword' || e.key === 'passwordVerified' || e.key === 'accessMode') {
        clearAuthCache();
    }
});

document.addEventListener('passwordVerified', clearAuthCache);

window.ProxyAuth = {
    addAuthToProxyUrl,
    validateProxyAuth,
    clearAuthCache,
    getPasswordHash
};
