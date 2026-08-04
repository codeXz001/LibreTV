// 密码保护功能
//
// 关键设计：内置密码哈希在脚本加载时立即启动异步预计算，
// verifyPassword 异步路径会先 await 计算完毕，确保 999999/147258 一定能登录。
// 即便浏览器因 Service Worker 缓存等原因导致 js-sha256 库加载失败，
// 这里仍可纯走 Web Crypto API（crypto.subtle.digest）完成验证。

// 尝试保留 js-sha256 作为高性能同步路径的兜底（HTTP 上无法用 Web Crypto 时尤其重要）
if (typeof window._jsSha256 !== 'function' && typeof window.sha256 === 'function') {
    window._jsSha256 = window.sha256;
}

// 同步 SHA-256：优先走 js-sha256
function sha256Sync(message) {
    if (typeof window._jsSha256 === 'function') return window._jsSha256(message);
    if (typeof window.sha256 === 'function') return window.sha256(message);
    return null;
}

// 异步 SHA-256：优先走 Web Crypto API（永远可用）
async function sha256(message) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
        try {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
            return Array.from(new Uint8Array(buf))
                .map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            // 某些特殊环境下 Web Crypto 不可用，降级到 js-sha256
        }
    }
    if (typeof window._jsSha256 === 'function') return window._jsSha256(message);
    if (typeof window.sha256 === 'function') return window.sha256(message);
    throw new Error('No SHA-256 implementation available.');
}

function getConfiguredPasswordHash(name) {
    const value = window.__ENV__ && window.__ENV__[name];
    return typeof value === 'string' && value.length === 64 && !/^0+$/.test(value)
        ? value
        : '';
}

// 内置密码哈希：模块加载时立即同步算（若 js-sha256 可用），并启动异步保险计算。
const __builtinHashes = { user: '', admin: '', asyncReady: false };

function computeBuiltinHashesSync() {
    const cfg = window.ACCESS_PASSWORD_CONFIG;
    if (!cfg) return;
    if (cfg.builtinUserPassword && !__builtinHashes.user) {
        __builtinHashes.user = sha256Sync(cfg.builtinUserPassword) || '';
    }
    if (cfg.builtinAdminPassword && !__builtinHashes.admin) {
        __builtinHashes.admin = sha256Sync(cfg.builtinAdminPassword) || '';
    }
}

// 同步预算
computeBuiltinHashesSync();

// 异步预算：JS 加载后立即发起，verifyPassword 异步路径上会自然 await
(async () => {
    const cfg = window.ACCESS_PASSWORD_CONFIG;
    if (!cfg) return;
    if (cfg.builtinUserPassword && !__builtinHashes.user) {
        try { __builtinHashes.user = await sha256(cfg.builtinUserPassword); } catch (e) {}
    }
    if (cfg.builtinAdminPassword && !__builtinHashes.admin) {
        try { __builtinHashes.admin = await sha256(cfg.builtinAdminPassword); } catch (e) {}
    }
    __builtinHashes.asyncReady = true;
})();

function getBuiltinPasswordHashes() {
    return { user: __builtinHashes.user, admin: __builtinHashes.admin };
}

function getConfiguredPasswordEntries() {
    const entries = [];
    const envUserHash = getConfiguredPasswordHash('PASSWORD');
    const envAdminHash = getConfiguredPasswordHash('ADMIN_PASSWORD');
    const builtin = getBuiltinPasswordHashes();
    const builtinUser = builtin.user;
    const builtinAdmin = builtin.admin;

    // 角色优先级：
    //   用户密码 = 环境变量 PASSWORD(若设置) -> 内置 999999
    //   管理员密码 = 环境变量 ADMIN_PASSWORD(若设置) -> 内置 147258
    // 任一部署下都能用 999999 / 147258 登录，
    // 同时允许部署端用环境变量覆盖任一套内置密码而保留另一套。
    const userHash = envUserHash || builtinUser;
    const adminHash = envAdminHash || builtinAdmin;

    if (userHash) entries.push({ role: 'user', hash: userHash });
    // 同一密码不能同时授予两种身份
    if (adminHash && adminHash !== userHash) {
        entries.push({ role: 'admin', hash: adminHash });
    }
    return entries;
}

function readVerificationState() {
    try {
        const raw = localStorage.getItem(PASSWORD_CONFIG.localStorageKey);
        if (!raw) return null;
        const state = JSON.parse(raw);
        return state && typeof state === 'object' ? state : null;
    } catch (error) {
        console.warn('读取密码验证状态失败:', error);
        return null;
    }
}

function isPasswordProtected() {
    return getConfiguredPasswordEntries().length > 0;
}

function isPasswordRequired() {
    return false;
}

function isPasswordVerified() {
    try {
        if (!isPasswordProtected()) return true;

        const stored = readVerificationState();
        if (!stored || stored.verified !== true || !stored.timestamp || !stored.passwordHash) return false;

        const current = getConfiguredPasswordEntries().find(entry => entry.hash === stored.passwordHash);
        return !!current && Date.now() - stored.timestamp < PASSWORD_CONFIG.verificationTTL;
    } catch (error) {
        console.error('检查密码验证状态时出错:', error);
        return false;
    }
}

function getAccessMode() {
    if (!isPasswordProtected()) return 'user';
    if (!isPasswordVerified()) return null;

    const stored = readVerificationState();
    const entry = getConfiguredPasswordEntries().find(item => item.hash === stored?.passwordHash);
    return entry ? entry.role : 'user';
}

function isAdminMode() {
    return getAccessMode() === 'admin';
}

function ensurePasswordProtection() {
    if (isPasswordRequired()) {
        showPasswordModal();
        throw new Error('Password protection is required');
    }
    if (isPasswordProtected() && !isPasswordVerified()) {
        showPasswordModal();
        throw new Error('Password verification required');
    }
    return true;
}

window.isPasswordProtected = isPasswordProtected;
window.isPasswordRequired = isPasswordRequired;
window.isPasswordVerified = isPasswordVerified;
window.getAccessMode = getAccessMode;
window.isAdminMode = isAdminMode;
window.getConfiguredPasswordEntries = getConfiguredPasswordEntries;
window.getConfiguredPasswordHash = getConfiguredPasswordHash;

/**
 * 验证用户输入的密码:异步计算内置密码哈希并保证条目已就绪,
 * 确保 SW 缓存失败导致 js-sha256 缺失时仍能验证内置密码。
 */
async function verifyPassword(password) {
    // 等待内置密码哈希预计算完成（首次调用时只跑一次）
    if (!__builtinHashes.asyncReady && !__builtinHashes.user && !__builtinHashes.admin) {
        // 已经在脚本加载时触发了后台计算,在这里再 await 一次兜底
        await new Promise(resolve => {
            const check = () => {
                if (__builtinHashes.asyncReady || __builtinHashes.user || __builtinHashes.admin) resolve();
                else setTimeout(check, 20);
            };
            check();
        });
    }

    try {
        const entries = getConfiguredPasswordEntries();
        if (!entries.length) return false;

        const inputHash = await sha256(password);
        const matched = entries.find(entry => entry.hash === inputHash);
        if (!matched) return false;

        localStorage.setItem(PASSWORD_CONFIG.localStorageKey, JSON.stringify({
            verified: true,
            timestamp: Date.now(),
            passwordHash: matched.hash,
            role: matched.role
        }));
        localStorage.setItem('accessMode', matched.role);
        localStorage.removeItem('proxyAuthHash');
        return true;
    } catch (error) {
        console.error('验证密码时出错:', error);
        return false;
    }
}

window.verifyPassword = verifyPassword;
window.ensurePasswordProtection = ensurePasswordProtection;
window.sha256 = sha256;

function showPasswordModal() {
    const passwordModal = document.getElementById('passwordModal');
    if (passwordModal) {
        const doubanArea = document.getElementById('doubanArea');
        if (doubanArea) doubanArea.classList.add('hidden');
        const cancelButton = document.getElementById('passwordCancelBtn');
        if (cancelButton) cancelButton.classList.add('hidden');

        const title = passwordModal.querySelector('h2');
        const description = passwordModal.querySelector('p');
        const form = passwordModal.querySelector('form');
        const errorMsg = document.getElementById('passwordError');

        if (isPasswordRequired()) {
            if (title) title.textContent = '需要设置密码';
            if (description) description.textContent = '请先在部署平台设置 PASSWORD 环境变量来保护您的实例';
            if (form) form.style.display = 'none';
            if (errorMsg) {
                errorMsg.textContent = '为确保安全，必须设置密码才能使用本服务，请联系管理员进行配置';
                errorMsg.classList.remove('hidden');
                errorMsg.className = 'text-red-500 mt-2 font-medium';
            }
        } else {
            if (title) title.textContent = '访问验证';
            if (description) description.textContent = '请输入密码继续访问';
            if (form) form.style.display = 'block';
            if (errorMsg) {
                errorMsg.textContent = '密码错误，请重试';
                errorMsg.className = 'text-red-500 mt-2 hidden';
            }
        }

        passwordModal.style.display = 'flex';

        if (!isPasswordRequired()) {
            setTimeout(() => {
                const passwordInput = document.getElementById('passwordInput');
                if (passwordInput) passwordInput.focus();
            }, 100);
        }
    }
}

function hidePasswordModal() {
    const passwordModal = document.getElementById('passwordModal');
    if (passwordModal) {
        hidePasswordError();
        const passwordInput = document.getElementById('passwordInput');
        if (passwordInput) passwordInput.value = '';
        passwordModal.style.display = 'none';

        if (localStorage.getItem('doubanEnabled') === 'true') {
            const doubanArea = document.getElementById('doubanArea');
            if (doubanArea) doubanArea.classList.remove('hidden');
            if (typeof initDouban === 'function') initDouban();
        }
    }
}

function showPasswordError() {
    const errorElement = document.getElementById('passwordError');
    if (errorElement) errorElement.classList.remove('hidden');
}

function hidePasswordError() {
    const errorElement = document.getElementById('passwordError');
    if (errorElement) errorElement.classList.add('hidden');
}

async function handlePasswordSubmit() {
    const passwordInput = document.getElementById('passwordInput');
    const password = passwordInput ? passwordInput.value.trim() : '';
    if (await verifyPassword(password)) {
        const role = getAccessMode();
        hidePasswordModal();
        document.dispatchEvent(new CustomEvent('passwordVerified', { detail: { role } }));
    } else {
        showPasswordError();
        if (passwordInput) {
            passwordInput.value = '';
            passwordInput.focus();
        }
    }
}

function initPasswordProtection() {
    if (isPasswordRequired()) {
        showPasswordModal();
        return;
    }
    if (isPasswordProtected() && !isPasswordVerified()) {
        showPasswordModal();
    }
}

document.addEventListener('DOMContentLoaded', function () {
    initPasswordProtection();
});
