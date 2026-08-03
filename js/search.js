// ===== 搜索性能优化：并发限流 + 结果缓存 =====
const __searchCache = new Map(); // key -> { ts, data }
const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const SEARCH_PAGE_CONCURRENCY = 6; // 单源分页并发上限（避免一次性发起 ~49 个请求）

function __searchCacheGet(key) {
  const hit = __searchCache.get(key);
  if (hit && (Date.now() - hit.ts) < SEARCH_CACHE_TTL) return hit.data;
  if (hit) __searchCache.delete(key);
  return null;
}
function __searchCacheSet(key, data) {
  __searchCache.set(key, { ts: Date.now(), data });
  // 简单的上限，避免内存无限制增长
  if (__searchCache.size > 200) {
    __searchCache.delete(__searchCache.keys().next().value);
  }
}

// 通用并发限流：对 items 并发执行 fn(item, index)，最多 limit 个同时进行
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

async function searchByAPIAndKeyWord(apiId, query) {
    // 结果缓存：相同 (源 + 关键词) 在 TTL 内直接返回，避免重复拉取
    const cacheKey = apiId + '::' + query;
    const cached = __searchCacheGet(cacheKey);
    if (cached) return cached;

    try {
        let apiUrl, apiName, apiBaseUrl;
        
        // 处理自定义API
        if (apiId.startsWith('custom_')) {
            const customIndex = apiId.replace('custom_', '');
            const customApi = getCustomApiInfo(customIndex);
            if (!customApi) return [];
            
            apiBaseUrl = customApi.url;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = customApi.name;
        } else {
            // 内置API
            if (!API_SITES[apiId]) return [];
            apiBaseUrl = API_SITES[apiId].api;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = API_SITES[apiId].name;
        }
        
        // 添加超时处理（10s：过长的源直接跳过，避免拖慢整体搜索）
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        // 添加鉴权参数到代理URL
        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl)) :
            PROXY_URL + encodeURIComponent(apiUrl);
        
        const response = await fetch(proxiedUrl, {
            headers: API_CONFIG.search.headers,
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            return [];
        }
        
        const data = await response.json();
        
        if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
            return [];
        }
        
        // 处理第一页结果
        const results = data.list.map(item => ({
            ...item,
            source_name: apiName,
            source_code: apiId,
            api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
        }));
        
        // 获取总页数
        const pageCount = data.pagecount || 1;
        // 确定需要获取的额外页数 (最多获取maxPages页)
        const pagesToFetch = Math.min(pageCount - 1, API_CONFIG.search.maxPages - 1);
        
        // 如果有额外页数，获取更多页的结果（并发限流，避免一次性 ~49 个请求）
        if (pagesToFetch > 0) {
            const pages = [];
            for (let page = 2; page <= pagesToFetch + 1; page++) pages.push(page);

            const additionalResults = await mapLimit(pages, SEARCH_PAGE_CONCURRENCY, async (page) => {
                try {
                    const pageController = new AbortController();
                    const pageTimeoutId = setTimeout(() => pageController.abort(), 10000);

                    const pageUrl = apiBaseUrl + API_CONFIG.search.pagePath
                        .replace('{query}', encodeURIComponent(query))
                        .replace('{page}', page);

                    // 添加鉴权参数到代理URL
                    const proxiedPageUrl = await window.ProxyAuth?.addAuthToProxyUrl ?
                        await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(pageUrl)) :
                        PROXY_URL + encodeURIComponent(pageUrl);

                    const pageResponse = await fetch(proxiedPageUrl, {
                        headers: API_CONFIG.search.headers,
                        signal: pageController.signal
                    });

                    clearTimeout(pageTimeoutId);

                    if (!pageResponse.ok) return [];

                    const pageData = await pageResponse.json();

                    if (!pageData || !pageData.list || !Array.isArray(pageData.list)) return [];

                    // 处理当前页结果
                    return pageData.list.map(item => ({
                        ...item,
                        source_name: apiName,
                        source_code: apiId,
                        api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
                    }));
                } catch (error) {
                    console.warn(`API ${apiId} 第${page}页搜索失败:`, error);
                    return [];
                }
            });

            // 合并所有页的结果
            additionalResults.forEach(pageResults => {
                if (pageResults.length > 0) {
                    results.push(...pageResults);
                }
            });
        }

        // 写入缓存（相同查询在 TTL 内复用）
        __searchCacheSet(cacheKey, results);
        return results;
    } catch (error) {
        console.warn(`API ${apiId} 搜索失败:`, error);
        return [];
    }
}