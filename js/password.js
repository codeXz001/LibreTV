// 密码保护功能

// 保存原始 js-sha256 实现(defer 化后内联保存脚本已移除;
// sha256.min.js 在文档顺序上先于本脚本执行,此处兜底保存供 sha256()/proxy-auth.js 使用)
if (typeof window._jsSha256 !== 'function' && typeof window.sha256 === 'function') {
    window._jsSha256 = window.sha256;
}

// 同步 SHA-256（js-sha256 提供，供内置密码在同步路径中计算哈希）
function sha256Sync(message) {
    if (typeof window._jsSha256 === 'function') return window._jsSha256(message);
    if (typeof window.sha256 === 'function') return window.sha256(message);
    return null;
}

function getConfiguredPasswordHash(name) {
    const value = window.__ENV__ && window.__ENV__[name];
    return typeof value === 'string' && value.length === 64 && !/^0+$/.test(value)
        ? value
        : '';
}

function getBuiltinPasswordHashes() {
    const cfg = window.ACCESS_PASSWORD_CONFIG;
    if (!cfg) return { user: '', admin: '' };
    const user = cfg.builtinUserPassword ? sha256Sync(cfg.builtinUserPassword) || '' : '';
    const admin = cfg.builtinAdminPassword ? sha256Sync(cfg.builtinAdminPassword) || '' : '';
    return { user, admin };
}

function getConfiguredPasswordEntries() {
    const entries = [];
    const envUserHash = getConfiguredPasswordHash('PASSWORD');
    const envAdminHash = getConfiguredPasswordHash('ADMIN_PASSWORD');
    if (envUserHash) entries.push({ role: 'user', hash: envUserHash });
    // 普通密码优先：两套环境变量误配为同一密码时，不授予管理员模式。
    if (envAdminHash && envAdminHash !== envUserHash) {
        entries.push({ role: 'admin', hash: envAdminHash });
    }

    // 内置密码兜底：环境变量未配置时，使用内置 999999 / 147258。
    // 仅当对应角色还没有有效哈希时才启用，避免与部署端配置冲突。
    const builtin = getBuiltinPasswordHashes();
    const hasUser = entries.some(e => e.role === 'user');
    const hasAdmin = entries.some(e => e.role === 'admin');
    if (!hasUser && builtin.user) entries.push({ role: 'user', hash: builtin.user });
    if (!hasAdmin && builtin.admin && builtin.admin !== builtin.user) {
        entries.push({ role: 'admin', hash: builtin.admin });
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

/**
 * 检查是否设置了密码保护。
 * 普通密码和管理员密码任一存在即启用密码保护。
 */
function isPasswordProtected() {
    return getConfiguredPasswordEntries().length > 0;
}

/**
 * 检查是否强制要求设置密码。
 * 未配置任何密码时保持兼容的无密码模式。
 */
function isPasswordRequired() {
    return false;
}

/**
 * 判断当前浏览器是否已经通过有效密码验证。
 */
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

/**
 * 获取当前访问模式：user / admin；未验证时返回 null。
 * admin 仅用于非色情管理界面，始终保留敏感内容过滤。
 */
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

/**
 * 强制密码保护检查 - 防止绕过。
 */
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

/**
 * 验证用户输入的密码是否正确（异步，使用 SHA-256 哈希）。
 */
async function verifyPassword(password) {
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
        // 代理鉴权统一使用普通密码的哈希：管理员/普通共用同一代理鉴权，
        // 服务端代理只认 PASSWORD(及可选的 ADMIN_PASSWORD)环境变量哈希。
        // 权限控制(资源采集站可见性/过滤)由前端访问模式负责，避免管理员请求被代理 401 拒绝。
        const userEntry = entries.find(entry => entry.role === 'user');
        localStorage.setItem('proxyAuthHash', userEntry ? userEntry.hash : matched.hash);
        return true;
    } catch (error) {
        console.error('验证密码时出错:', error);
        return false;
    }
}

window.verifyPassword = verifyPassword;
window.ensurePasswordProtection = ensurePasswordProtection;

// SHA-256 实现，可用 Web Crypto API
async function sha256(message) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
        const msgBuffer = new TextEncoder().encode(message);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // HTTP 下调用原始 js-sha256
    if (typeof window._jsSha256 === 'function') {
        return window._jsSha256(message);
    }
    throw new Error('No SHA-256 implementation available.');
}

/**
 * 显示密码验证弹窗。
 */
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
            if (description) description.textContent = '请输入访问密码继续';
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

/**
 * 隐藏密码验证弹窗。
 */
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

/**
 * 处理密码提交事件（异步）。
 */
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

/**
 * 初始化密码验证系统。
 */
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
