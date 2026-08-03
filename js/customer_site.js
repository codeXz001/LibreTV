// 客户站点注入（已废弃保留文件，避免 index.html / player.html 的引用报错）
// ===== 2026-08-03 体检结果：以下三个源全部失效，已从配置中排除 =====
// 1. qiqi（七七资源 https://www.qiqidys.com）：fetch failed（域名不可达）
// 2. maota（茅台资源 https://caiji.maotaa.com）：fetch failed（域名不可达）
// 3. bfzy（暴风资源 https://bfzy.tv）：Cloudflare 拦截（bot 防护）
//    注意：此覆盖曾导致 config.js 中可用的 https://bfzyapi.com 被替换为失效地址，
//    已恢复由 config.js 提供 bfzy = https://bfzyapi.com（实测可用）。
//
// 若后续有新的客户站点需要注入，按以下格式添加：
// const CUSTOMER_SITES = { key: { api: 'https://...', name: '...' } };
// if (window.extendAPISites) { window.extendAPISites(CUSTOMER_SITES); }
const CUSTOMER_SITES = {};
if (window.extendAPISites) {
    window.extendAPISites(CUSTOMER_SITES);
}
