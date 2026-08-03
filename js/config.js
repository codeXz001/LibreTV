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
    zuidazy: {
        api: 'https://zuidazy.me/api.php/provide/vod',
        name: '最大点播',
    },
    modu: {
        api: 'https://caiji.moduapi.cc/api.php/provide/vod',
        name: '魔都动漫',
    },
    mdzy: {
        api: 'https://www.mdzyapi.com/api.php/provide/vod',
        name: '魔都资源',
    },
    ikun: {
        api: 'https://ikunzyapi.com/api.php/provide/vod',
        name: '爱坤资源',
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
    lzzy2: {
        api: 'https://cj.lzcaiji.com/api.php/provide/vod',
        name: '量子资源备用',
    },
    huya: {
        api: 'https://www.huyaapi.com/api.php/provide/vod/at/json',
        name: '虎牙资源',
    },
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

// ===== 首屏预连接（preconnect / dns-prefetch）=====
// 浏览器提前建立到资源站与豆瓣图床的连接，减少首屏图片与数据请求的握手延迟。
// 在 API_SITES 定义后执行，动态收集域名；重复访问时去重。
(function preconnectResources() {
    const hosts = new Set(['https://movie.douban.com']);
    try {
        Object.keys(API_SITES || {}).forEach(key => {
            const api = API_SITES[key];
            if (api && api.api) {
                const origin = new URL(api.api).origin;
                if (/^https?:$/.test(new URL(origin).protocol)) hosts.add(origin);
            }
        });
    } catch (e) {
        // 个别异常域名不影响整体
    }
    hosts.forEach(h => {
        if (document.querySelector(`link[href="${h}"]`)) return;
        const pre = document.createElement('link');
        pre.rel = 'preconnect';
        pre.href = h;
        document.head.appendChild(pre);
        const dns = document.createElement('link');
        dns.rel = 'dns-prefetch';
        dns.href = h;
        document.head.appendChild(dns);
    });
})();
