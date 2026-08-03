// 全局常量配置
const PROXY_URL = '/proxy/';    // 适用于 Cloudflare, Netlify (带重写), Vercel (带重写)
// const HOPLAYER_URL = 'https://hoplayer.com/index.html';
const SEARCH_HISTORY_KEY = 'videoSearchHistory';
const MAX_HISTORY_ITEMS = 5;

// 密码保护配置
// 注意：PASSWORD 环境变量是必需的，所有部署都必须设置密码以确保安全
const PASSWORD_CONFIG = {
    localStorageKey: 'passwordVerified',  // 存储验证状态的键名
    verificationTTL: 90 * 24 * 60 * 60 * 1000  // 验证有效期（90天，约3个月）
};

// 网站信息配置
const SITE_CONFIG = {
    name: 'LibreTV',
    url: 'https://libretv.is-an.org',
    description: '免费在线视频搜索与观看平台',
    logo: 'image/logo.png',
    version: '1.0.3'
};

// API站点配置
// 这些是经过测试可用的苹果 CMS V10 资源站
// 失效的源会自动被前端跳过，无需手动删除
const API_SITES = {
    ffzy: {
        api: 'https://api.ffzyapi.com/api.php/provide/vod',
        name: '非凡资源',
        detail: 'https://ffzy5.tv',  // 非凡影视的详情页域名，用于特殊源处理
    },
    ffzy_backup: {
        api: 'https://cj.ffzyapi.com/api.php/provide/vod',
        name: '非凡采集',
    },
    subocaiji: {
        api: 'https://subocaiji.com/api.php/provide/vod',
        name: '速播资源',
    },
    guangsu: {
        api: 'https://api.guangsuapi.com/api.php/provide/vod',
        name: '光速资源',
    },
    bfzy: {
        api: 'https://bfzyapi.com/api.php/provide/vod',
        name: '暴风资源',
    },
    // ===== 2026-08-03 新增：以下 8 个源逐站实测通过 =====
    // 验证方式：直接请求 `?ac=videolist&wd=战狼`，均返回 JSON(code=1) 且有真实数据/海报。
    // 已排除：樱花(403)、猫眼(fetch failed)、牛牛/索尼/丫丫(暂不支持搜索)、快看(404)。
    hhzy: {
        api: 'https://hhzyapi.com/api.php/provide/vod',
        name: '豪华资源',
    },
    lzzy: {
        api: 'https://cj.lziapi.com/api.php/provide/vod',
        name: '量子资源',
    },
    jszy: {
        api: 'https://jszyapi.com/api.php/provide/vod',
        name: '极速资源',
    },
    wujin: {
        api: 'https://api.wujinapi.com/api.php/provide/vod',
        name: '无尽影视',
    },
    hongniu: {
        api: 'https://www.hongniuzy2.com/api.php/provide/vod',
        name: '红牛资源',
    },
    uku: {
        api: 'https://api.ukuapi88.com/api.php/provide/vod',
        name: 'U酷影视',
    },
    '360zy': {
        api: 'https://360zy.com/api.php/provide/vod',
        name: '360资源',
    },
    piaoling: {
        api: 'https://p2100.net/api.php/provide/vod',
        name: '飘零资源',
    },
    // ===== 2026-08-03 第二批新增：5 个源逐站实测通过（同一验证方式）=====
    // 已排除：山海(fetch failed)、旺旺(域名重定向到天涯首页)、闪电(暂不支持搜索)、
    // 四九/熊掌(fetch failed)、优质资源库(返回HTML而非JSON)。
    iqiyi: {
        api: 'https://iqiyizyapi.com/api.php/provide/vod',
        name: '爱奇艺资源',
    },
    modu: {
        api: 'https://caiji.moduapi.cc/api.php/provide/vod',
        name: '魔都动漫',
    },
    mdzy: {
        api: 'https://www.mdzyapi.com/api.php/provide/vod',
        name: '魔都资源',
    },
    // ===== 2026-08-03 第三批新增：4 个源逐站实测通过 =====
    zuidapi: {
        api: 'https://api.zuidapi.com/api.php/provide/vod',
        name: '最大资源',
    },
    bdzy: {
        api: 'https://api.apibdzy.com/api.php/provide/vod',
        name: '百度资源',
    },
    huya: {
        api: 'https://www.huyaapi.com/api.php/provide/vod/at/json',
        name: '虎牙资源',
    },
    // ===== 2026-08-03 第四批新增：8 个源（scripts/probe-sources.mjs 实测）=====
    // 验证标准比前几批更严：①搜索返回 code=1 且有结果 ②详情接口能取到真实 m3u8
    // 播放地址 ③记录响应耗时。仅"可搜 + 可播"双通过的才纳入。
    // 括号内为实测搜索响应耗时（单次，仅供参考，前端仍会动态测速排序）。
    ffzy_m3u8: {
        api: 'https://ffzy5.tv/api.php/provide/vod',
        name: '非凡M3U8',            // 347ms，当前最快
        detail: 'https://ffzy5.tv',
    },
    ruyi: {
        api: 'https://cj.rycjapi.com/api.php/provide/vod',
        name: '如意资源',            // 564ms
    },
    maoyan: {
        api: 'https://api.maoyanapi.top/api.php/provide/vod',
        name: '猫眼资源',            // 703ms
    },
    dyttzy: {
        api: 'https://caiji.dyttzyapi.com/api.php/provide/vod',
        name: '电影天堂',            // 918ms
        detail: 'https://caiji.dyttzyapi.com',
    },
    lovedan: {
        api: 'https://lovedan.net/api.php/provide/vod',
        name: '艾旦影视',            // 2131ms，片源数量最多（同关键词 22 条）
    },
    jinying: {
        api: 'https://jyzyapi.com/api.php/provide/vod',
        name: '金鹰资源',            // 2738ms
    },
    xinlang: {
        api: 'https://api.xinlangapi.com/xinlangapi.php/provide/vod',
        name: '新浪资源',            // 3143ms，注意路径是 xinlangapi.php 而非 api.php
    },
    zy360bak: {
        api: 'https://360zyzz.com/api.php/provide/vod',
        name: '360备用',            // 5033ms，较慢，作为 360zy 的兜底
    },
    // ===== 2026-08-03 已移除（实测失效，DNS 解析失败 / 连接被拒，串行长超时复测仍不通）=====
    // zuidazy  最大点播      https://zuidazy.me/api.php/provide/vod
    // ikun     爱坤资源      https://ikunzyapi.com/api.php/provide/vod
    // lzzy2    量子资源备用  https://cj.lzcaiji.com/api.php/provide/vod
};

// 定义合并方法
function extendAPISites(newSites) {
    Object.assign(API_SITES, newSites);
}

// 暴露到全局
window.API_SITES = API_SITES;
window.extendAPISites = extendAPISites;


// 添加聚合搜索的配置选项
const AGGREGATED_SEARCH_CONFIG = {
    enabled: true,             // 是否启用聚合搜索
    timeout: 8000,            // 单个源超时时间（毫秒）
    maxResults: 10000,          // 最大结果数量
    parallelRequests: true,   // 是否并行请求所有源
    showSourceBadges: true    // 是否显示来源徽章
};

// 抽象API请求配置
const API_CONFIG = {
    search: {
        // 只拼接参数部分，不再包含 /api.php/provide/vod/
        path: '?ac=videolist&wd=',
        pagePath: '?ac=videolist&wd={query}&pg={page}',
        maxPages: 50, // 最大获取页数
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        }
    },
    detail: {
        // 只拼接参数部分
        path: '?ac=videolist&ids=',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        }
    }
};

// 优化后的正则表达式模式
const M3U8_PATTERN = /\$https?:\/\/[^"'\s]+?\.m3u8/g;

// 添加自定义播放器URL
const CUSTOM_PLAYER_URL = 'player.html'; // 使用相对路径引用本地player.html

// 增加视频播放相关配置
const PLAYER_CONFIG = {
    autoplay: true,
    allowFullscreen: true,
    width: '100%',
    height: '600',
    timeout: 15000,  // 播放器加载超时时间
    filterAds: true,  // 是否启用广告过滤
    autoPlayNext: true,  // 默认启用自动连播功能
    // 2026-08-03：默认关闭分片广告过滤——旧实现会删除所有 #EXT-X-DISCONTINUITY 行，
    // 破坏正常流的码率切换/续播结构，且广告分段并未真正移除。
    // 开启时走改进后的域名黑名单过滤（见 player.js filterAdsFromM3U8）。
    adFilteringEnabled: false,
    adFilteringStorage: 'adFilteringEnabled' // 存储广告过滤设置的键名
};

// 增加错误信息本地化
const ERROR_MESSAGES = {
    NETWORK_ERROR: '网络连接错误，请检查网络设置',
    TIMEOUT_ERROR: '请求超时，服务器响应时间过长',
    API_ERROR: 'API接口返回错误，请尝试更换数据源',
    PLAYER_ERROR: '播放器加载失败，请尝试其他视频源',
    UNKNOWN_ERROR: '发生未知错误，请刷新页面重试'
};

// 添加进一步安全设置
const SECURITY_CONFIG = {
    enableXSSProtection: true,  // 是否启用XSS保护
    sanitizeUrls: true,         // 是否清理URL
    maxQueryLength: 100,        // 最大搜索长度
    // allowedApiDomains 不再需要，因为所有请求都通过内部代理
};

// 添加多个自定义API源的配置
const CUSTOM_API_CONFIG = {
    separator: ',',           // 分隔符
    maxSources: 5,            // 最大允许的自定义源数量
    testTimeout: 5000,        // 测试超时时间(毫秒)
    namePrefix: 'Custom-',    // 自定义源名称前缀
    validateUrl: true,        // 验证URL格式
    cacheResults: true,       // 缓存测试结果
    cacheExpiry: 5184000000,  // 缓存过期时间(2个月)
    adultPropName: 'isAdult' // 用于标记成人内容的属性名
};

// 隐藏内置黄色采集站API的变量
const HIDE_BUILTIN_ADULT_APIS = false;

// ===== 首页分类推荐配置 =====
// tags 为该分类的候选采集站分类名（按序 fallback）：
// 个别源对同一分类的命名不同（如动漫可能叫"日本动画"/"动画片"），按序尝试直到命中非空
const HOME_CATEGORIES = [
    { id: 'movie',   name: '电影',   tags: ['电影'] },
    { id: 'tv',      name: '电视剧', tags: ['电视剧'] },
    { id: 'anime',   name: '动漫',   tags: ['动漫', '日本动画', '动画片'] },
    { id: 'variety', name: '综艺',   tags: ['综艺'] },
];

// 黄色内容过滤的分类黑名单（app.js 搜索与 home.js 首页推荐共用，单一事实源）
const BANNED_TYPE_NAMES = ['伦理片', '福利', '里番动漫', '门事件', '萝莉少女', '制服诱惑', '国产传媒', 'cosplay', '黑丝诱惑', '无码', '日本无码', '有码', '日本有码', 'SWAG', '网红主播', '色情片', '同性片', '福利视频', '福利片'];

// 首页推荐配置
const HOME_CONFIG = {
    cacheTTL: 5 * 60 * 1000,   // 分类结果缓存时间
    pageSize: 24,              // 单页条数（与采集站默认一致）
    hotStripLimit: 12,         // "正在热映"横滑条最多展示条数
    concurrency: 4             // 聚合请求并发上限
};

// 暴露到全局
window.HOME_CATEGORIES = HOME_CATEGORIES;
window.BANNED_TYPE_NAMES = BANNED_TYPE_NAMES;
window.HOME_CONFIG = HOME_CONFIG;

// ===== 首屏预连接（preconnect / dns-prefetch）=====
// 【2026-08-03 修正】原实现给每个资源站 API 域名都加 preconnect + dns-prefetch，实测证明是无效开销：
//   1. 所有 API 请求都经由同源 /proxy/ 转发（见 js/api.js），浏览器【从不直连】资源站域名，
//      27 个源会生成 54 个 link 标签，每个 preconnect 还会真实建立 TCP+TLS 连接并保持约 10s。
//   2. 资源站的海报图床域名与 API 域名完全不同，静态枚举不到：
//      ffzy5.tv -> tupian.ffeiimg.com、cj.rycjapi.com -> ps.ryzypics.com、
//      caiji.dyttzyapi.com -> vod.dyttimage.com、bfzyapi.com -> img.bfzypic.com …
//   3. 豆瓣封面真实图床是 img{1,2,3,9}.doubanio.com，而原来预连的是 movie.douban.com
//      （豆瓣数据接口同样走 /proxy/），预连对象完全错位。
// 现在只静态预连"确定会直连且高频"的豆瓣图床，其余图床域名由 hintImageHosts() 在渲染时动态提示。
// 静态预连的图床域名（模块级，供 hintImageHosts 复用，避免重复预算）
const PRECONNECT = [
    'https://img1.doubanio.com',
    'https://img2.doubanio.com',
    'https://img3.doubanio.com',
];
(function preconnectResources() {
    // 豆瓣封面走 img1/2/3/9 轮询，取命中率最高的三个；首页开启豆瓣推荐时首屏即用。
    PRECONNECT.forEach(h => {
        if (document.querySelector(`link[rel="preconnect"][href="${h}"]`)) return;
        const pre = document.createElement('link');
        pre.rel = 'preconnect';
        pre.href = h;
        pre.crossOrigin = 'anonymous';   // 图片为匿名跨域请求，不加则连接无法复用
        document.head.appendChild(pre);
    });
})();
// 记录静态预连域名，hintImageHosts 会跳过它们（已 preconnect，再 dns-prefetch 纯属浪费预算）
window.__preconnectedHosts = window.__preconnectedHosts || new Set(PRECONNECT);

// ===== 运行时图片域名提示 =====
// 渲染搜索结果 / 推荐列表后调用，对实际出现的图床域名补 dns-prefetch。
// 只做 dns-prefetch（仅 DNS 解析，不占用连接，成本远低于 preconnect），并设全局上限，
// 避免源数量增长后又退化成"几十个无效 link"。
window.__hintedImageHosts = window.__hintedImageHosts || new Set();
window.hintImageHosts = function hintImageHosts(urls, limit = 16) {
    if (!Array.isArray(urls) || !urls.length) return;
    const preconnected = window.__preconnectedHosts;
    for (const u of urls) {
        if (window.__hintedImageHosts.size >= limit) return;
        if (!u || typeof u !== 'string' || !u.startsWith('http')) continue;
        let origin;
        try {
            origin = new URL(u).origin;
        } catch (e) {
            continue;   // 个别脏数据不影响整体
        }
        if (preconnected && preconnected.has(origin)) continue;   // 已 preconnect，跳过
        if (window.__hintedImageHosts.has(origin)) continue;
        window.__hintedImageHosts.add(origin);
        const dns = document.createElement('link');
        dns.rel = 'dns-prefetch';
        dns.href = origin;
        document.head.appendChild(dns);
    }
};
