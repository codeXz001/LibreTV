// =============================================================
// 首页分类推荐模块(LibreTV 重构版)
// 职责:分类 tab 渲染与切换、"正在热映"横滑条 + "最新更新"网格、
//       多源聚合、池化分页、视图切换底部导航。
//
// 数据方案(实测结论,2026-08-03):
//   - 采集站最新流(ac=videolist 无 t 参数)里几乎只有剧集/综艺/动漫,
//     电影占比极低(960 条仅 19 条),且 t= 分类参数各源行为不一致(名称/ID 均不可靠)
//   - 因此:tv/anime/variety 走"采集站最新流 + type_name 匹配过滤 + 池化分页"
//           movie 走豆瓣热门/最新接口(真实电影推荐)
//
// 依赖:config.js(API_SITES/HOME_CATEGORIES/HOME_CONFIG)、search.js(mapLimit)、
//       ui.js(懒加载/图片回退/Toast)、app.js(selectedAPIs/aggregateItemMap/
//       showAggregatedDetails/normalizeTitle)、douban.js(fetchDoubanData)
// =============================================================

// ---- 分类匹配规则:源站 type_name 均为二级分类(如"欧美剧/日韩动漫/大陆综艺") ----
const HOME_TYPE_MATCH = {
    tv:      t => /剧/.test(t) && !/动漫|动画|漫剧|短剧/.test(t),
    anime:   t => /动漫|动画|漫剧/.test(t),
    variety: t => /综艺/.test(t),
};

// 判断某源是否为资源采集站源(内置 adult:true 或自定义 isAdult)
function isAdultSource(srcId) {
    if (srcId.startsWith('custom_')) {
        const info = getCustomApiInfo(srcId.replace('custom_', ''));
        return !!(info && info.isAdult);
    }
    return !!(API_SITES[srcId] && API_SITES[srcId].adult);
}

// ---- 状态 ----
const homePools = {};          // catId -> 池(聚合条目 + 每源拉页游标)。仅 tv/anime/variety 用
const POOL_TTL = 5 * 60 * 1000; // 池 5 分钟 TTL(与搜索缓存一致)
const PER_SOURCE_PAGES = 1;    // 首屏每源只拉一页，后续滚动再补页
const LATEST_BATCH = 24;       // 网格每批展示条数

let homeCurrentCatId = 'movie';
let homeReqSeq = 0;            // 切分类竞态序号:过期响应丢弃
let homeLoadingMore = {};      // { [catId]: boolean } 分页防重入
let __sentinelObserver = null; // 滚动哨兵观察器(全局一个)

// movie 分类(豆瓣)分页状态
let homeMoviePage = 1;
let homeMovieHasMore = false;

// 带超时的请求包装:超时返回 fallback，不阻塞首屏（用于豆瓣等可能走备用链的慢请求）
function withTimeout(promise, ms, fallback) {
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const HOME_CACHE_PREFIX = 'homePoolCache_v1:';
const HOME_CACHE_TTL = 5 * 60 * 1000; // 与内存池 TTL 一致

function getHomeSourceIds() {
    const allSrcIds = Array.isArray(selectedAPIs) ? selectedAPIs : [];
    return allSrcIds.filter(id => !isAdultSource(id));
}

function getHomeSourceSignature(srcIds) {
    return [...srcIds].sort().join(',');
}

function getHomeCacheKey(catId, srcIds) {
    return HOME_CACHE_PREFIX + catId + ':' + getHomeSourceSignature(srcIds);
}

// 只持久化卡片与详情索引需要的字段，避免把 vod_content 等大字段写入 localStorage。
function compactHomeItem(item) {
    return {
        vod_id: item.vod_id,
        vod_name: item.vod_name,
        vod_pic: item.vod_pic,
        vod_remarks: item.vod_remarks,
        vod_time: item.vod_time,
        type_name: item.type_name,
        source_name: item.source_name,
        source_code: item.source_code,
        api_url: item.api_url,
    };
}

function persistHomePool(catId, pool, srcIds) {
    if (!pool || !pool.items.length || !srcIds.length) return;
    try {
        const payload = {
            ts: Date.now(),
            sourceSignature: getHomeSourceSignature(srcIds),
            items: pool.items.map(compactHomeItem),
            srcPages: pool.srcPages,
            srcPageCount: pool.srcPageCount,
            hasMore: pool.hasMore,
        };
        localStorage.setItem(getHomeCacheKey(catId, srcIds), JSON.stringify(payload));
    } catch (error) {
        // localStorage 配额不足不影响首页正常请求与渲染。
        console.warn('[首页] 持久缓存写入失败:', error.message);
    }
}

function restoreHomePool(catId, srcIds) {
    if (!srcIds.length) return null;
    const key = getHomeCacheKey(catId, srcIds);
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (!cached || !cached.ts || Date.now() - cached.ts >= HOME_CACHE_TTL ||
            cached.sourceSignature !== getHomeSourceSignature(srcIds) ||
            !Array.isArray(cached.items) || !cached.items.length) {
            localStorage.removeItem(key);
            return null;
        }

        const pool = {
            items: cached.items,
            merged: [],
            rendered: 0,
            srcPages: cached.srcPages || {},
            srcPageCount: cached.srcPageCount || {},
            hasMore: !!cached.hasMore,
            ts: cached.ts,
        };
        pool.merged = mergeAndFilter([{ list: pool.items }]);
        homePools[catId] = pool;
        return pool;
    } catch (error) {
        localStorage.removeItem(key);
        return null;
    }
}

function clearPersistedHomePools() {
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(HOME_CACHE_PREFIX)) keys.push(key);
        }
        keys.forEach(key => localStorage.removeItem(key));
    } catch (error) {
        console.warn('[首页] 清理持久缓存失败:', error.message);
    }
}

// 池缓存读写
function getPool(catId) {
    const pool = homePools[catId];
    if (pool && (Date.now() - pool.ts) < POOL_TTL) return pool;
    if (pool) delete homePools[catId];
    return null;
}
function initPool(catId) {
    const pool = {
        items: [],        // 各源拉取的全部原始条目(未去重)
        merged: [],       // 聚合去重后的条目
        rendered: 0,      // 已展示 merged 条数
        srcPages: {},     // srcId -> 已拉到的页码
        srcPageCount: {}, // srcId -> 总页数(判断是否还有)
        hasMore: false,
        ts: Date.now()
    };
    homePools[catId] = pool;
    return pool;
}

// 渲染分类 tab 行
function renderCategoryTabs() {
    const row = document.getElementById('catTabs');
    if (!row) return;
    row.innerHTML = (HOME_CATEGORIES || []).map(cat => `
        <button class="cat-tab${cat.id === homeCurrentCatId ? ' active' : ''}" data-cat-id="${cat.id}" type="button">${cat.name}</button>
    `).join('');
}

// 切换分类:更新激活态并加载该分类内容
function switchCategory(catId) {
    if (!HOME_CATEGORIES.some(c => c.id === catId)) return;
    homeCurrentCatId = catId;
    document.querySelectorAll('#catTabs .cat-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.catId === catId);
    });
    loadCategory(catId);
}

// ---- 采集站请求(直连代理,与 searchByAPIAndKeyWord 同链路;密码检查在 loadCategory 入口) ----
// 拉单页并按分类规则过滤,返回 { items, pagecount }
async function fetchSourceCategoryPage(srcId, catId, page) {
    try {
        let apiBase, apiName;
        if (srcId.startsWith('custom_')) {
            const customApi = getCustomApiInfo(srcId.replace('custom_', ''));
            if (!customApi) return { items: [], pagecount: 1 };
            apiBase = customApi.url;
            apiName = customApi.name;
        } else {
            if (!API_SITES[srcId]) return { items: [], pagecount: 1 };
            apiBase = API_SITES[srcId].api;
            apiName = API_SITES[srcId].name;
        }

        const apiUrl = apiBase + '?ac=videolist' + (page > 1 ? '&pg=' + page : '');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HOME_CONFIG.sourceTimeout || 7000);

        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl
            ? await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl))
            : PROXY_URL + encodeURIComponent(apiUrl);

        const response = await fetch(proxiedUrl, {
            headers: API_CONFIG.search.headers,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) return { items: [], pagecount: 1 };

        const data = await response.json();
        if (!data || !Array.isArray(data.list) || data.list.length === 0) {
            return { items: [], pagecount: 1 };
        }

        const matcher = HOME_TYPE_MATCH[catId];
        const items = data.list
            .filter(it => it && it.vod_name && matcher && matcher(it.type_name || ''))
            .map(it => ({
                ...it,
                source_name: apiName,
                source_code: srcId,
                api_url: srcId.startsWith('custom_') ? apiBase : undefined
            }));

        return { items, pagecount: Number(data.pagecount) || 1 };
    } catch (error) {
        console.warn(`[首页] 源 ${srcId} 第${page}页请求失败:`, error);
        return { items: [], pagecount: 1 };
    }
}

// 串行拉 from..to 页(单源避免并发击穿),到 pagecount 提前停
async function fetchSourceCategoryRange(srcId, catId, from, to) {
    const items = [];
    let pagecount = 1;
    for (let p = from; p <= to; p++) {
        const r = await fetchSourceCategoryPage(srcId, catId, p);
        items.push(...r.items);
        pagecount = Math.max(pagecount, r.pagecount);
        if (p >= pagecount) break; // 已到末页
    }
    return { items, pagecount, toPage: to };
}

// 合并过滤:敏感内容过滤 + 标题归一化去重 + 写入聚合详情 map
function mergeAndFilter(rawLists) {
    const banned = (typeof BANNED_TYPE_NAMES !== 'undefined') ? BANNED_TYPE_NAMES : [];
    const yellowFilter = true;

    const groups = new Map(); // normalizeKey -> { key, items[] }
    (rawLists || []).forEach(res => {
        if (!res || !Array.isArray(res.list)) return;
        res.list.forEach(item => {
            if (!item || !item.vod_name) return;
            if (yellowFilter && banned.some(kw => (item.type_name || '').includes(kw))) return;
            const key = normalizeTitle(item.vod_name);
            if (!key) return;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        });
    });

    const merged = [];
    groups.forEach((items, key) => {
        // 同源同片去重(源+id)
        const bySrc = new Map();
        items.forEach(it => {
            const srcKey = (it.source_code || '') + '::' + (it.vod_id || '');
            if (!bySrc.has(srcKey)) bySrc.set(srcKey, it);
        });
        const unique = Array.from(bySrc.values());
        // 封面优先排序(组首为卡片展示条目,全组供详情切换)
        unique.sort((a, b) => {
            const ac = a.vod_pic && a.vod_pic.startsWith('http') ? 0 : 1;
            const bc = b.vod_pic && b.vod_pic.startsWith('http') ? 0 : 1;
            return ac - bc;
        });
        merged.push(unique[0]);
        aggregateItemMap.set(key, unique);
    });

    // 结果按更新时间粗略排序(有 vod_time 的靠前,保持采集站返回序)
    merged.sort((a, b) => {
        const at = a.vod_time || '';
        const bt = b.vod_time || '';
        if (at && bt) return bt.localeCompare(at);
        return (at ? 1 : 0) - (bt ? 1 : 0);
    });
    return merged;
}

// ---- 豆瓣(电影分类)----
function doubanMovieUrl(tag, limit, start) {
    return `https://movie.douban.com/j/search_subjects?type=movie&tag=${tag}&sort=recommend&page_limit=${limit}&page_start=${start}`;
}
// 豆瓣条目映射为通用条目字段
function mapDoubanItem(d) {
    return {
        vod_name: d.title,
        vod_pic: d.cover,
        type_name: '电影',
        vod_remarks: d.rate ? '★ ' + d.rate : '',
        vod_time: '',
        source_name: '豆瓣',
        source_code: 'douban',
        vod_id: d.id,
        douban_url: d.url
    };
}

// ---- 渲染 ----

// 海报卡片(热映条与最新网格共用;豆瓣条目带 searchKey,点击触发源站搜索)
function escapeHomeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// data-* 属性取回时的反转义（与 escapeHomeHtml 对称）
function decodeHomeHtml(value) {
    return String(value || '')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function buildPosterCardHtml(item, opts) {
    const rawName = (item.vod_name || '').toString();
    const safeName = escapeHomeHtml(rawName);
    const safeRemarks = escapeHomeHtml(item.vod_remarks || '');
    const hasCover = item.vod_pic && item.vod_pic.startsWith('http');
    const searchKey = (opts && opts.searchKey) ? rawName : '';
    const safeTitle = escapeHomeHtml(rawName);
    const safeKey = escapeHomeHtml(normalizeTitle(rawName));
    const cardData = searchKey
        ? `data-search-key="${safeTitle}" data-title="${safeTitle}"`
        : `data-key="${safeKey}" data-title="${safeTitle}"`;

    const priority = opts && opts.priority;
    const imageSrc = priority ? item.vod_pic : IMG_TRANSPARENT;
    const lazyAttrs = priority ? '' : `data-src="${item.vod_pic}"`;
    const imageAttrs = priority
        ? 'loading="eager" fetchpriority="high"'
        : 'loading="lazy"';

    return `
        <div class="poster-card" ${cardData}
             role="button" tabindex="0" aria-label="${safeName}">
            <div class="poster-img-wrap lazy-img-wrap">
                ${hasCover ? `
                <img src="${imageSrc}" ${lazyAttrs} data-orig="${item.vod_pic}" alt="${safeName}"
                     onerror="handleImageError(this)" ${imageAttrs} decoding="async">` : ''}
                ${safeRemarks ? `<span class="poster-remark">${safeRemarks}</span>` : ''}
            </div>
            <p class="poster-title">${safeName}</p>
        </div>
    `;
}

// 热映横滑条(琥珀"热"角标)
function renderHotStrip(container, items, withSearchKey = false) {
    if (!container) return;
    const list = items.slice(0, HOME_CONFIG.hotStripLimit);
    if (!list.length) { container.innerHTML = ''; return; }
    container.innerHTML = list.map((item, index) => buildPosterCardHtml(item, {
        ...(withSearchKey ? { searchKey: true } : {}),
        priority: index < 2,
    })).join('');
    if (window.hintImageHosts) {
        const covers = list.map(item => item.vod_pic).filter(Boolean);
        if (covers.length) window.hintImageHosts(covers);
    }
    // 给横滑条卡片统一追加"热"角标
    container.querySelectorAll('.poster-card').forEach(card => {
        const wrap = card.querySelector('.poster-img-wrap');
        if (wrap) wrap.insertAdjacentHTML('beforeend', '<span class="hot-badge">热</span>');
    });
}

// 最新更新网格
function renderLatestGrid(container, items, withSearchKey) {
    if (!container) return;
    const list = items || [];
    container.innerHTML = list.map((item, index) => buildPosterCardHtml(item, {
        ...(withSearchKey ? { searchKey: true } : {}),
        priority: index < 2,
    })).join('');
    if (window.hintImageHosts) {
        const covers = list.map(item => item.vod_pic).filter(Boolean);
        if (covers.length) window.hintImageHosts(covers);
    }
}

// 空态提示
function renderEmpty(container, msg) {
    if (!container) return;
    container.innerHTML = `
        <div class="home-empty">
            <svg class="mx-auto h-10 w-10 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"/>
            </svg>
            <p>${msg}</p>
        </div>`;
}

// 骨架屏(海报占位)
function skeletonHtml(count) {
    const n = count || 12;
    let html = '';
    for (let i = 0; i < n; i++) {
        html += `
            <div class="poster-card">
                <div class="poster-img-wrap skeleton-img shimmer"></div>
                <div class="skeleton-line shimmer" style="width:80%;margin-top:.4rem"></div>
            </div>`;
    }
    return html;
}

// 外部资源导航区块：仅展示入口，新窗口打开，不执行第三方页面脚本
function buildResourceNavHtml() {
    const items = (typeof HOME_RESOURCE_NAV !== 'undefined') ? HOME_RESOURCE_NAV : [];
    if (!items.length) return '';
    const cards = items.map(nav => {
        const safeName = escapeHomeHtml(nav.name);
        const safeDesc = escapeHomeHtml(nav.description);
        const safeBadge = escapeHomeHtml(nav.badge);
        const safeUrl = nav.url.replace(/"/g, '&quot;');
        return `
            <div class="resource-nav-item resource-nav-link" role="button" tabindex="0"
                 data-nav-url="${safeUrl}" data-nav-name="${safeName}" aria-label="${safeName}">
                <div class="resource-nav-info">
                    <div class="resource-nav-name">${safeName}</div>
                    <div class="resource-nav-desc">${safeDesc}</div>
                </div>
                ${safeBadge ? `<span class="resource-nav-badge">${safeBadge}</span>` : ''}
                <svg class="resource-nav-arrow" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path>
                </svg>
            </div>`;
    }).join('');
    return `
        <div class="resource-nav" aria-label="外部资源导航">
            ${cards}
        </div>`;
}

// 外部导航点击事件委托：新标签页打开（noopener noreferrer）
function handleResourceNavClick(e) {
    const el = e.target.closest('.resource-nav-link');
    if (!el) return;
    const url = el.dataset.navUrl;
    if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
    }
}

// 构建某分类的区块骨架(资源导航 + 热映区 + 最新区 + 分页哨兵)
function buildCatSectionHtml(catId) {
    return `
        <div class="cat-section">
            ${buildResourceNavHtml()}
            <div class="hot-section">
                <div class="section-head">
                    <h2 class="section-title hot-title">正在热映</h2>
                </div>
                <div class="hot-strip" id="hotstrip-${catId}"></div>
            </div>
            <div class="section-head">
                <h2 class="section-title">最新更新</h2>
            </div>
            <div class="latest-grid" id="latest-${catId}"></div>
            <div class="loadmore-sentinel" id="sentinel-${catId}"></div>
        </div>
    `;
}

// 滚动哨兵:进入视口触发分页;不支持 IntersectionObserver 时退化为"加载更多"按钮
function getSentinelObserver() {
    if (__sentinelObserver) return __sentinelObserver;
    if (!('IntersectionObserver' in window)) return null;
    __sentinelObserver = new IntersectionObserver(entries => {
        entries.forEach(en => {
            if (en.isIntersecting) {
                const catId = en.target && en.target.dataset.catId;
                if (catId) loadMoreLatest(catId);
            }
        });
    }, { rootMargin: '600px 0px' });
    return __sentinelObserver;
}
function observeSentinel(sentinel, catId) {
    if (!sentinel) return;
    sentinel.dataset.catId = catId;
    const obs = getSentinelObserver();
    if (obs) {
        obs.observe(sentinel);
    } else {
        sentinel.innerHTML = `<button class="load-more-btn" onclick="loadMoreLatest('${catId}')">加载更多</button>`;
    }
}

// ---- 加载逻辑 ----

// 主入口:加载分类(缓存命中秒渲染,未命中骨架屏;竞态序号丢弃过期响应)
async function loadCategory(catId) {
    // 密码保护校验(与 search() 一致;直连代理绕过拦截器,故入口显式校验)
    try {
        if (window.ensurePasswordProtection) {
            window.ensurePasswordProtection();
        } else if (window.isPasswordProtected && window.isPasswordVerified) {
            if (window.isPasswordProtected() && !window.isPasswordVerified()) {
                showPasswordModal && showPasswordModal();
                return;
            }
        }
    } catch (error) {
        console.warn('密码保护校验失败:', error.message);
        return;
    }

    const seq = ++homeReqSeq;
    const feed = document.getElementById('homeFeed');
    if (!feed) return;

    feed.innerHTML = buildCatSectionHtml(catId);
    const hotContainer = document.getElementById('hotstrip-' + catId);
    const latestContainer = document.getElementById('latest-' + catId);
    const sentinel = document.getElementById('sentinel-' + catId);
    const hotSection = hotContainer ? hotContainer.closest('.hot-section') : null;

    // 热映区先隐藏,拿到数据再显示;最新区先铺骨架
    if (hotSection) hotSection.classList.add('hidden');
    latestContainer.innerHTML = skeletonHtml(12);

    // 未选择任何数据源:直接空态,不发请求
    if (!selectedAPIs || selectedAPIs.length === 0) {
        if (seq !== homeReqSeq) return;
        renderEmpty(latestContainer, '请先在「源配置」中选择数据源');
        if (sentinel) sentinel.remove();
        return;
    }

    if (catId === 'movie') {
        await loadMovieCategory(seq, hotSection, hotContainer, latestContainer, sentinel);
    } else {
        await loadPoolCategory(seq, catId, hotSection, hotContainer, latestContainer, sentinel);
    }
}

// 电影分类:豆瓣热门(热映条)+ 豆瓣最新(网格)
async function loadMovieCategory(seq, hotSection, hotContainer, latestContainer, sentinel) {
    // 两个豆瓣请求各自加短超时：任一源慢/失败不拖住整个首屏（主请求+备用链最长可达 20s）
    const HOT_TIMEOUT = 6000;
    // 两个请求同时发出；热门先到先渲染热映条，最新网格随后到位，首屏内容更快出现
    const hotPromise = withTimeout(fetchDoubanData(doubanMovieUrl('热门', HOME_CONFIG.hotStripLimit, 0)), HOT_TIMEOUT, null);
    const latestPromise = withTimeout(fetchDoubanData(doubanMovieUrl('最新', LATEST_BATCH, 0)), HOT_TIMEOUT, null);

    const hotRes = await hotPromise;
    if (seq !== homeReqSeq) return;

    const hotItems = (hotRes && hotRes.subjects) ? hotRes.subjects.map(mapDoubanItem) : [];
    if (hotItems.length) {
        renderHotStrip(hotContainer, hotItems, true);
        if (hotSection) hotSection.classList.remove('hidden');
    } else if (hotSection) {
        hotSection.remove();
    }

    const latestRes = await latestPromise;
    if (seq !== homeReqSeq) return;
    const latestItems = (latestRes && latestRes.subjects) ? latestRes.subjects.map(mapDoubanItem) : [];

    latestContainer.innerHTML = '';
    if (latestItems.length) {
        renderLatestGrid(latestContainer, latestItems, true);
        homeMoviePage = 1;
        homeMovieHasMore = latestItems.length >= LATEST_BATCH;
        if (homeMovieHasMore && sentinel) observeSentinel(sentinel, 'movie');
        else if (sentinel) sentinel.outerHTML = '<div class="loadmore-end">已加载全部</div>';
    } else {
        renderEmpty(latestContainer, '暂无内容，请稍后刷新重试');
        if (sentinel) sentinel.remove();
    }
    observeLazyImages(latestContainer);
    observeLazyImages(hotContainer);
}

// 采集站分类:池化加载(tv/anime/variety)
async function loadPoolCategory(seq, catId, hotSection, hotContainer, latestContainer, sentinel) {
    const srcIds = getHomeSourceIds();
    let pool = getPool(catId);
    if (!pool) {
        // 刷新页面后优先使用 5 分钟内的轻量持久缓存，避免首屏等待资源站网络。
        pool = restoreHomePool(catId, srcIds);
    }
    if (!pool) {
        pool = initPool(catId);
        await refillPool(catId); // 各源并行拉第一批
    }
    if (seq !== homeReqSeq) return;

    renderPool(catId, hotSection, hotContainer, latestContainer, sentinel);
}

// 各源并行拉下一批页(每源 PER_SOURCE_PAGES 页)追加进池
async function refillPool(catId) {
    const pool = homePools[catId];
    if (!pool) return;

    const srcIds = getHomeSourceIds();
    if (!srcIds.length) return;

    const from = Math.max(0, ...Object.values(pool.srcPages)) + 1;
    const to = from + PER_SOURCE_PAGES - 1;

    const rounds = await mapLimit(srcIds, HOME_CONFIG.concurrency,
        src => fetchSourceCategoryRange(src, catId, from, to));

    rounds.forEach((r, i) => {
        if (!r) return;
        const srcId = srcIds[i];
        pool.items.push(...r.items);
        pool.srcPages[srcId] = Math.max(pool.srcPages[srcId] || 0, r.toPage);
        pool.srcPageCount[srcId] = r.pagecount;
    });

    pool.merged = mergeAndFilter([{ list: pool.items }]);
    pool.hasMore = srcIds.some(s => (pool.srcPages[s] || 0) < (pool.srcPageCount[s] || 1));
    // 持久化轻量卡片数据，后续刷新可直接恢复首屏。
    persistHomePool(catId, pool, srcIds);
}

// 渲染池内容(热映取前 N,网格取一批)
function renderPool(catId, hotSection, hotContainer, latestContainer, sentinel) {
    const pool = homePools[catId];
    if (!pool) return;

    const merged = pool.merged;

    // 热映区:池中最新的前 N 条(源返回按更新时间序)
    const hotItems = merged.slice(0, HOME_CONFIG.hotStripLimit);
    if (hotItems.length) {
        renderHotStrip(hotContainer, hotItems);
        if (hotSection) hotSection.classList.remove('hidden');
    } else if (hotSection) {
        hotSection.remove();
    }

    // 最新网格:从热映截断之后开始(同批数据不重复展示,首屏信息密度更高)
    latestContainer.innerHTML = '';
    if (merged.length) {
        const gridItems = merged.slice(HOME_CONFIG.hotStripLimit, HOME_CONFIG.hotStripLimit + LATEST_BATCH);
        if (gridItems.length) {
            renderLatestGrid(latestContainer, gridItems);
            pool.rendered = HOME_CONFIG.hotStripLimit + gridItems.length;
        } else {
            // 数据过少(全部进了热映条):网格直接收尾
            pool.rendered = merged.length;
            renderEmpty(latestContainer, '更多内容加载中，请稍后刷新');
            if (sentinel) sentinel.outerHTML = '<div class="loadmore-end">已加载全部</div>';
            observeLazyImages(hotContainer);
            return;
        }
        const hasMore = pool.hasMore || merged.length > pool.rendered;
        if (hasMore && sentinel) observeSentinel(sentinel, catId);
        else if (sentinel) sentinel.outerHTML = '<div class="loadmore-end">已加载全部</div>';
    } else {
        renderEmpty(latestContainer, '暂无内容，请稍后刷新重试');
        if (sentinel) sentinel.remove();
    }

    observeLazyImages(latestContainer);
    observeLazyImages(hotContainer);
}

// 分页追加"最新更新"
async function loadMoreLatest(catId) {
    if (homeLoadingMore[catId]) return;
    homeLoadingMore[catId] = true;
    try {
        const container = document.getElementById('latest-' + catId);
        const sentinel = document.getElementById('sentinel-' + catId);
        if (!container || !sentinel || !container.isConnected) return; // 已切走分类:丢弃

        if (catId === 'movie') {
            await loadMoreMovie(container, sentinel);
            return;
        }

        const pool = homePools[catId];
        if (!pool) return;

        // 池内剩余不足一批且源还有更多 → 先补一批
        if ((pool.merged.length - pool.rendered) < LATEST_BATCH && pool.hasMore) {
            await refillPool(catId);
            // 补完仍不足(池耗尽),结束
            if ((pool.merged.length - pool.rendered) < LATEST_BATCH && !pool.hasMore) {
                finishPool(catId, sentinel, pool);
                return;
            }
        }

        const more = pool.merged.slice(pool.rendered, pool.rendered + LATEST_BATCH);
        if (more.length) {
            container.insertAdjacentHTML('beforeend',
                more.map(item => buildPosterCardHtml(item)).join(''));
            observeLazyImages(container);
            pool.rendered += more.length;
        }

        const hasMore = pool.hasMore || pool.merged.length > pool.rendered;
        if (hasMore) observeSentinel(sentinel, catId);
        else finishPool(catId, sentinel, pool);
    } finally {
        homeLoadingMore[catId] = false;
    }
}

// 分页收尾:显示"已加载全部"并重置 hasMore
function finishPool(catId, sentinel, pool) {
    if (sentinel) sentinel.outerHTML = '<div class="loadmore-end">已加载全部</div>';
    if (pool) pool.hasMore = false;
}

// 豆瓣电影分页(page_start 递增)
async function loadMoreMovie(container, sentinel) {
    const nextPage = homeMoviePage + 1;
    const data = await fetchDoubanData(doubanMovieUrl('最新', LATEST_BATCH, nextPage * LATEST_BATCH));
    const items = (data && data.subjects) ? data.subjects.map(mapDoubanItem) : [];
    if (items.length) {
        container.insertAdjacentHTML('beforeend',
            items.map(item => buildPosterCardHtml(item, { searchKey: true })).join(''));
        observeLazyImages(container);
        homeMoviePage = nextPage;
        homeMovieHasMore = items.length >= LATEST_BATCH;
    } else {
        homeMovieHasMore = false;
    }
    if (homeMovieHasMore) observeSentinel(sentinel, 'movie');
    else finishPool('movie', sentinel, null);
}

// 源配置变更时清空首页缓存(下次进入强制重新拉取)
function invalidateHomeCache() {
    Object.keys(homePools).forEach(k => delete homePools[k]);
    clearPersistedHomePools();
    homeMoviePage = 1;
    homeMovieHasMore = false;
    homeReqSeq++; // 使在途请求结果作废
}

// ---- 三视图底部导航 ----
function switchView(viewId) {
    document.querySelectorAll('.app-view').forEach(v => {
        v.classList.toggle('active', v.id === viewId);
    });
    document.querySelectorAll('#tabbar .tabbar-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === viewId);
    });
    document.body.dataset.view = viewId;

    // 关闭历史抽屉
    const hp = document.getElementById('historyPanel');
    if (hp && hp.classList.contains('show') && typeof toggleHistory === 'function') {
        toggleHistory();
    }

    // 回到影视页且首页为空(如首屏加载被中断)时补一次加载
    if (viewId === 'view-home') {
        const feed = document.getElementById('homeFeed');
        if (feed && !feed.children.length) switchCategory(homeCurrentCatId);
    }
    window.scrollTo({ top: 0 });
}

// 重新打开免责声明弹窗(我的页入口)
function showDisclaimer() {
    const modal = document.getElementById('disclaimerModal');
    if (modal) modal.style.display = 'flex';
}

// 卡片点击(事件委托):
//   - 豆瓣/任何带标题的条目(data-title)→ 优先标题搜索；data-search-key 为豆瓣显式标记
//   - 采集站聚合条目(data-key)→ 打开聚合详情(多源测速排序 + 源切换)；聚合数据缺失时回退标题搜索
function handleHomeCardClick(e) {
    const card = e.target.closest('.poster-card');
    if (!card) return;
    const searchKey = decodeHomeHtml(card.dataset.searchKey);
    const title = decodeHomeHtml(card.dataset.title);
    const key = card.dataset.key || '';
    // 豆瓣条目或任何带原始标题的条目：用标题搜索源站
    if (searchKey || (title && !key)) {
        if (typeof fillAndSearchWithDouban === 'function') {
            fillAndSearchWithDouban(searchKey || title);
        }
        return;
    }
    // 采集站聚合条目：打开聚合详情；聚合数据缺失时回退标题搜索
    if (key) {
        const hasAggregateData = (typeof aggregateItemMap !== 'undefined') && aggregateItemMap.has(key);
        if (hasAggregateData && typeof showAggregatedDetails === 'function') {
            showAggregatedDetails(key);
        } else if (title && typeof fillAndSearchWithDouban === 'function') {
            // 聚合详情数据缺失（如旧缓存/未聚合条目）：回退标题搜索，保证点击必有响应
            fillAndSearchWithDouban(title);
        }
    } else if (title && typeof fillAndSearchWithDouban === 'function') {
        fillAndSearchWithDouban(title);
    }
}

// 卡片键盘可达(Enter 打开)
function handleHomeCardKeydown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.poster-card');
    if (!card) return;
    e.preventDefault();
    handleHomeCardClick({ target: card });
}

// ---- 初始化 ----
function initHomePage() {
    renderCategoryTabs();

    // 分类 tab 事件委托
    const catTabs = document.getElementById('catTabs');
    if (catTabs) {
        catTabs.addEventListener('click', e => {
            const btn = e.target.closest('.cat-tab');
            if (btn && btn.dataset.catId) switchCategory(btn.dataset.catId);
        });
    }

    // 底部 tabbar 事件委托
    const tabbar = document.getElementById('tabbar');
    if (tabbar) {
        tabbar.addEventListener('click', e => {
            const btn = e.target.closest('.tabbar-btn');
            if (btn && btn.dataset.view) switchView(btn.dataset.view);
        });
    }

    // 首页内容点击/键盘
    const feed = document.getElementById('homeFeed');
    if (feed) {
        feed.addEventListener('click', handleHomeCardClick);
        feed.addEventListener('keydown', handleHomeCardKeydown);
        // 外部资源导航（影视仓/饭太硬）点击委托
        feed.addEventListener('click', handleResourceNavClick);
    }

    // 初始加载第一个分类
    switchCategory(homeCurrentCatId);
}

document.addEventListener('DOMContentLoaded', initHomePage);
