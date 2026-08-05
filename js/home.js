// =============================================================
// 首页推荐模块(LibreTV 重构版)
// 职责:"正在热映"横滑条 + "最新更新"网格、池化分页、视图切换底部导航。
//
// 数据方案(2026-08-04 起):
//   - 首页无分类 tab,仅展示推荐流:全部数据统一从「默认源」拉取,
//     不做 type_name 分类匹配过滤(直接展示源的最新/最火内容);
//   - 点击卡片直接进入播放页(默认源第一集),换源/选集在播放页完成;
//   - 首页不再使用豆瓣数据。
//
// 依赖:config.js(API_SITES/HOME_CONFIG)、search.js(mapLimit)、
//       ui.js(懒加载/图片回退/Toast)、app.js(selectedAPIs/aggregateItemMap/
//       fetchDetailData/normalizeTitle)
// =============================================================

// ---- 分类匹配规则(保留备用:当前首页不做 type_name 过滤,均展示源最新内容) ----
const HOME_TYPE_MATCH = {
    tv:      t => /剧/.test(t) && !/动漫|动画|漫剧|短剧/.test(t),
    anime:   t => /动漫|动画|漫剧/.test(t),
    variety: t => /综艺/.test(t),
    // 资源采集站分类:源隔离已保证只拉 adult 源,内容全部接受,不再按 type_name 过滤
    adult:   () => true,
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

const HOME_CACHE_PREFIX = 'homePoolCache_v1:';
// 持久缓存 TTL 30 分钟(配合 SWR:命中即秒开,后台静默刷新保持新鲜);
// 内存池 TTL(POOL_TTL)仍为 5 分钟,仅控制会话内新鲜度。
const HOME_CACHE_TTL = 30 * 60 * 1000;

// 按分类返回应使用的数据源：
// 资源采集站分类只取标记为 adult 的源；
// 其他分类统一只从「默认源」拉取（避免首页数据在多源不一致时搜索不到），
// 若默认源失效则降级到第一个可用默认源。
// 普通模式默认源只会是普通资源源；管理员模式默认源可为资源采集站源。
function getHomeSourceIds(catId) {
    const allSrcIds = Array.isArray(selectedAPIs) ? selectedAPIs : [];
    if (catId === 'adult') return allSrcIds.filter(id => isAdultSource(id));

    const defaultId = (typeof getEffectiveDefaultSourceId === 'function')
        ? getEffectiveDefaultSourceId()
        : null;
    if (defaultId && allSrcIds.includes(defaultId)) {
        // 管理员模式：默认源允许是资源采集站源；普通模式：getEffectiveDefaultSourceId 已保证为普通源
        return [defaultId];
    }
    // 默认源失效或缺失：降级到第一个普通资源源
    const fallback = allSrcIds.find(id => !isAdultSource(id));
    return fallback ? [fallback] : [];
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
        pool.merged = mergeAndFilter([{ list: pool.items }], catId === 'adult');
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
            signal: controller.signal,
            // 首页数据请求优先于图片等低优资源，首屏更快
            priority: 'high'
        });
        clearTimeout(timeoutId);

        if (!response.ok) return { items: [], pagecount: 1 };

        const data = await response.json();
        if (!data || !Array.isArray(data.list) || data.list.length === 0) {
            return { items: [], pagecount: 1 };
        }

        // 首页不做 type_name 分类匹配过滤，直接展示源的最新内容。
        // 普通源与资源站源均不过滤（用户要求"对应源最火内容即可"）。
        const items = data.list
            .filter(it => it && it.vod_name)
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

// 敏感内容过滤是否生效：
// 普通模式强制开启；管理员模式按用户设置（localStorage yellowFilterEnabled）。
function isYellowFilterActive() {
    const isAdmin = typeof window.isAdminMode === 'function' && window.isAdminMode();
    if (!isAdmin) return true;
    return localStorage.getItem('yellowFilterEnabled') === 'true';
}

// 合并过滤:敏感内容过滤 + 标题归一化去重 + 写入聚合详情 map
// skipYellow=true 时跳过过滤(资源采集站分类专用)
function mergeAndFilter(rawLists, skipYellow) {
    const banned = (typeof BANNED_TYPE_NAMES !== 'undefined') ? BANNED_TYPE_NAMES : [];
    const yellowFilter = !skipYellow && isYellowFilterActive();

    const groups = new Map(); // normalizeKey -> { key, items[] }
    (rawLists || []).forEach(res => {
        if (!res || !Array.isArray(res.list)) return;
        res.list.forEach(item => {
            if (!item || !item.vod_name) return;
            // 资源站源的内容不受敏感过滤影响（普通模式下 selectedAPIs 已排除资源站源，
            // 只有管理员模式才会出现，故不会破坏普通模式的内容安全）。
            const fromAdultSource = isAdultSource(item.source_code);
            if (yellowFilter && !fromAdultSource && banned.some(kw => (item.type_name || '').includes(kw))) return;
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

// 构建首页区块骨架(热映区 + 最新区 + 分页哨兵)
function buildCatSectionHtml(catId) {
    return `
        <div class="cat-section">
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

    // 资源采集站分类:未勾选任何成人源时给出针对性提示
    if (catId === 'adult' && !selectedAPIs.some(id => isAdultSource(id))) {
        if (seq !== homeReqSeq) return;
        renderEmpty(latestContainer, '请先在「源配置」中勾选资源采集站源');
        if (sentinel) sentinel.remove();
        return;
    }

    // 所有分类(含电影)统一从默认源拉取最新内容,不再使用豆瓣。
    await loadPoolCategory(seq, catId, hotSection, hotContainer, latestContainer, sentinel);
}

// 采集站分类:池化加载(tv/anime/variety/adult)
async function loadPoolCategory(seq, catId, hotSection, hotContainer, latestContainer, sentinel) {
    const srcIds = getHomeSourceIds(catId);
    let pool = getPool(catId);
    // 命中持久缓存:先渲染秒开,后台静默刷新数据(SWR 模式)
    let restored = false;
    if (!pool) {
        pool = restoreHomePool(catId, srcIds);
        restored = !!pool;
    }
    if (!pool) {
        pool = initPool(catId);
        await refillPool(catId); // 各源并行拉第一批
    }
    if (seq !== homeReqSeq) return;

    renderPool(catId, hotSection, hotContainer, latestContainer, sentinel);

    // 缓存恢复后后台静默刷新:不阻塞首屏,数据保持新鲜;
    // 刷新完成后若用户仍停留该分类,更新渲染与持久缓存。
    if (restored) {
        refillPool(catId)
            .then(() => {
                if (seq !== homeReqSeq) return; // 已切走分类,丢弃
                const cur = homePools[catId];
                if (cur && cur.merged && cur.merged.length) {
                    const feed = document.getElementById('homeFeed');
                    // 只更新仍在展示的分类内容
                    const hotC = document.getElementById('hotstrip-' + catId);
                    const latestC = document.getElementById('latest-' + catId);
                    const sent = document.getElementById('sentinel-' + catId);
                    const hotSec = hotC ? hotC.closest('.hot-section') : null;
                    if (hotC && latestC) {
                        renderPool(catId, hotSec, hotC, latestC, sent);
                    }
                }
            })
            .catch(() => { /* 刷新失败保留缓存内容 */ });
    }
}

// 各源并行拉下一批页(每源 PER_SOURCE_PAGES 页)追加进池
async function refillPool(catId) {
    const pool = homePools[catId];
    if (!pool) return;

    // 资源采集站分类只拉标记为成人的源;其他分类排除成人源
    const srcIds = getHomeSourceIds(catId);
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

    pool.merged = mergeAndFilter([{ list: pool.items }], catId === 'adult');
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

        // 所有分类(含电影)统一走池化分页,不再走豆瓣分页。
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

// 空闲预热其余分类的数据池:用户停留在当前分类时,后台预取其他分类,
// 切换时 getPool 直接命中,秒开(不抢占首屏渲染)。
function prewarmHomeCategories() {
    const cats = (Array.isArray(HOME_CATEGORIES) ? HOME_CATEGORIES : []).map(c => c.id);
    const rest = cats.filter(id => id !== homeCurrentCatId);
    if (!rest.length) return;
    // 普通模式不预热资源采集站分类
    const isAdmin = typeof window.isAdminMode === 'function' && window.isAdminMode();
    const targets = rest.filter(id => isAdmin || id !== 'adult');
    if (!targets.length) return;

    const schedule = (fn) => {
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(fn, { timeout: 4000 });
        } else {
            setTimeout(fn, 2000); // 无 idle API 时延迟执行,避开首屏
        }
    };
    schedule(async () => {
        for (const catId of targets) {
            // 已加载或持久缓存可恢复的分类直接跳过
            const srcIds = getHomeSourceIds(catId);
            if (getPool(catId) || restoreHomePool(catId, srcIds)) continue;
            const pool = initPool(catId);
            await refillPool(catId); // 失败由内部 try/catch 兜底,不影响后续
        }
    });
}

// 源配置变更时清空首页缓存(下次进入强制重新拉取)
function invalidateHomeCache() {
    Object.keys(homePools).forEach(k => delete homePools[k]);
    clearPersistedHomePools();
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
        if (feed && !feed.children.length) loadCategory(homeCurrentCatId);
    }
    window.scrollTo({ top: 0 });
}

// 重新打开免责声明弹窗(我的页入口)
function showDisclaimer() {
    const modal = document.getElementById('disclaimerModal');
    if (modal) modal.style.display = 'flex';
}

// 卡片点击(事件委托)：
//   点击首页卡片直接进入播放页（默认源第一集），不再打开详情弹窗
function handleHomeCardClick(e) {
    const card = e.target.closest('.poster-card');
    if (!card) return;
    const title = decodeHomeHtml(card.dataset.title);
    const key = card.dataset.key || '';
    if (key) {
        playHomeItem(key, title);
    } else if (title && typeof fillAndSearchWithDouban === 'function') {
        // 无聚合 key 的条目（理论上首页不会出现）：回退标题搜索，保证点击必有响应
        fillAndSearchWithDouban(title);
    }
}

// 点击首页卡片直接播放：取该影片聚合条目的第一个源（首页数据来自默认源），
// 加载详情后跳转播放页第一集；换源/选集在播放页内完成
async function playHomeItem(key, title) {
    // 密码保护校验（与 loadCategory 一致）
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

    const items = (typeof aggregateItemMap !== 'undefined') ? (aggregateItemMap.get(key) || []) : [];
    if (!items.length) {
        if (typeof showToast === 'function') showToast('该视频暂无可用资源', 'warning');
        return;
    }

    const item = items[0];
    if (typeof showLoading === 'function') showLoading();
    try {
        const data = await fetchDetailData(item.vod_id, item.source_code);
        if (!data || !data.episodes || !data.episodes.length) {
            if (typeof showToast === 'function') showToast('未找到播放资源，请稍后重试', 'error');
            return;
        }
        const targetUrl = data.episodes[0];
        const watchUrl = `player.html?id=${encodeURIComponent(item.vod_id)}&source=${encodeURIComponent(item.source_code)}&url=${encodeURIComponent(targetUrl)}&index=0&title=${encodeURIComponent(item.vod_name || title || '')}`;

        // 保存播放状态与聚合组（供播放页换源联动复用）
        try {
            localStorage.setItem('currentVideoTitle', item.vod_name || title || '未知视频');
            localStorage.setItem('currentEpisodes', JSON.stringify(data.episodes));
            localStorage.setItem('currentEpisodeIndex', 0);
            localStorage.setItem('currentSourceCode', item.source_code);
            localStorage.setItem('lastPlayTime', Date.now());
            localStorage.setItem('aggregatedSources', JSON.stringify(items.map(i => ({
                source_code: i.source_code,
                source_name: i.source_name,
                vod_id: i.vod_id,
                vod_name: i.vod_name,
                vod_pic: i.vod_pic || ''
            }))));
        } catch (err) {
            // 存储失败不影响跳转
        }

        window.location.href = watchUrl;
    } catch (error) {
        console.error('首页直接播放失败:', error);
        if (typeof showToast === 'function') showToast('播放失败，请稍后重试', 'error');
    } finally {
        if (typeof hideLoading === 'function') hideLoading();
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
    // 底部 tabbar 事件委托
    const tabbar = document.getElementById('tabbar');
    if (tabbar) {
        tabbar.addEventListener('click', e => {
            const btn = e.target.closest('.tabbar-btn');
            if (btn && btn.dataset.view) switchView(btn.dataset.view);
        });
    }

    // 首页内容点击/键盘（卡片点击直接播放）
    const feed = document.getElementById('homeFeed');
    if (feed) {
        feed.addEventListener('click', handleHomeCardClick);
        feed.addEventListener('keydown', handleHomeCardKeydown);
    }

    // 初始加载推荐内容（默认源的最新 + 最热）
    loadCategory(homeCurrentCatId);
    // 空闲预取其余分类数据池,切换秒开
    prewarmHomeCategories();
}

// 密码验证通过后重新加载首页：
// 初始 DOMContentLoaded 时 loadCategory 会因密码未验证被中断(只渲染了骨架屏)，
// 验证成功必须重载；管理员模式下若当前是普通分类,切到资源采集站分类。
document.addEventListener('passwordVerified', function () {
    const isAdmin = typeof window.isAdminMode === 'function' && window.isAdminMode();
    if (homeCurrentCatId === 'adult' && !isAdmin) {
        loadCategory('movie');
        return;
    }
    loadCategory(homeCurrentCatId);
    prewarmHomeCategories();
});

document.addEventListener('DOMContentLoaded', initHomePage);
