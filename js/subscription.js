// =============================================================
// TVBox 订阅导入(LibreTV)
// 职责:用户粘贴 TVBox 订阅地址 → 提取 type=1 苹果CMS站点 → 实测过滤 → 导入自定义API。
// 安全边界:
//   - 只解析静态 JSON/宽松 JSON/图片尾部 base64 配置,【绝不执行】第三方 JS/spider/jar/ext 脚本
//   - type=3(type=3 爬虫)/type=4(自定义) 站点一律跳过,只取 type=1 / 明确 cms 标记的接口
//   - 实测仅请求 `ac=videolist&pg=1`(不带 wd 避免 WAF),且必须返回 JSON 非空列表
// 依赖:config.js(PROXY_URL/API_CONFIG/API_SITES)、app.js(customAPIs/selectedAPIs/
//       renderCustomAPIsList/sanitizeSelectedAPIs/invalidateHomeCache)、search.js(mapLimit)
// =============================================================

const SUBSCRIPTION_CONFIG = {
    fetchTimeout: 15000,   // 订阅下载超时
    testTimeout: 8000,     // 单站点实测超时
    testConcurrency: 6,    // 实测并发上限
    maxImport: 100,         // 单次导入上限(与 CUSTOM_API_CONFIG.maxSources 一致)
    autoSelectLimit: 6     // 导入后自动勾选最快的前 N 个,避免搜索请求量暴增
};

// ---- 宽松 JSON 修复:剥注释 + 字符串内裸控制字符转义 + JSON5 尾随逗号 ----
function subscriptionFixLooseJson(src) {
    let out = '', inStr = false, esc = false, i = 0;
    while (i < src.length) {
        const c = src[i], nx = src[i + 1];
        if (inStr) {
            if (esc) { out += c; esc = false; i++; }
            else if (c === '\\') { out += c; esc = true; i++; }
            else if (c === '"') { out += c; inStr = false; i++; }
            else if (c === '\n') { out += '\\n'; i++; }
            else if (c === '\r') { out += '\\r'; i++; }
            else if (c === '\t') { out += '\\t'; i++; }
            else if (c.charCodeAt(0) < 0x20) { out += '\\u00' + c.charCodeAt(0).toString(16).padStart(2, '0'); i++; }
            else { out += c; i++; }
        } else if (c === '"') { inStr = true; out += c; i++; }
        else if (c === '/' && nx === '/') { while (i < src.length && src[i] !== '\n') i++; }
        else if (c === '/' && nx === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; }
        else if (c === ',') { // 尾随逗号(JSON5风格):逗号后紧跟 ] 或 } 则丢弃
            let j = i + 1;
            while (j < src.length && /\s/.test(src[j])) j++;
            if (src[j] === ']' || src[j] === '}') i++;
            else { out += c; i++; }
        }
        else { out += c; i++; }
    }
    return out;
}

// 已知源字面量修复:某些订阅存在确认过的缺起始引号,仅做确定字面量替换(安全)
function subscriptionRepairKnownTypos(src) {
    return src
        .replace(/,日韩剧",/g, ',"日韩剧",')
        .replace(/,其他片",/g, ',"其他片",');
}

// Base64 配置按 UTF-8 解码，兼容中文站点名称和分类
function subscriptionDecodeBase64(value) {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
    return binary;
}

// 增强解析:直接 JSON → 宽松修复 → 已知源修复 → 图片尾部 base64。返回 {json, via} 或 null
function subscriptionTryParse(body) {
    try { return { json: JSON.parse(body), via: 'plain' }; } catch (e) { /* 继续下一级 */ }
    try { return { json: JSON.parse(subscriptionFixLooseJson(body)), via: 'loose' }; } catch (e) { /* 继续 */ }
    try {
        const repaired = subscriptionRepairKnownTypos(body);
        return { json: JSON.parse(subscriptionFixLooseJson(repaired)), via: 'loose+known-fixes' };
    } catch (e) { /* 继续 */ }
    const b64s = body.match(/[A-Za-z0-9+/=]{100,}/g) || [];
    for (const s of b64s) {
        try {
            const j = JSON.parse(subscriptionDecodeBase64(s));
            if (j && (j.sites || j.lives)) return { json: j, via: 'base64-tail' };
        } catch (e) { /* 继续 */ }
    }
    return null;
}

// 配置类型判定
function subscriptionClassify(j) {
    if (j && (j.sites || j.lives || j.spider !== undefined || j.rules || j.video || j.drv)) return 'tvbox';
    if (j && (j.list || j.code !== undefined) && Array.isArray(j.list) && j.list.length && j.list[0].vod_name !== undefined) return 'cms';
    if (j && Array.isArray(j.list)) return 'cms-list?';
    return 'json-other';
}

// 只提取 type=1(苹果CMS) / 明确 cms 标记的站点;type=3/4(爬虫)一律跳过
function subscriptionExtractCMSSites(j) {
    const sites = Array.isArray(j.sites) ? j.sites : (Array.isArray(j) ? j : []);
    const out = [];
    for (const s of sites) {
        if (!s || !s.api) continue;
        const t = s.type;
        if (t === 1 || t === '1' || t === 'cms' || /cms/i.test(String(s.type || ''))) {
            out.push({
                key: s.key || s.name,
                name: s.name || s.key,
                api: String(s.api).trim(),
                type: s.type,
                searchable: s.searchable
            });
        }
    }
    return out;
}

// 接口规范化:先去 query,再去尾部斜杠,用于去重比较
function subscriptionNormalizeApi(a) {
    return String(a || '').split('?')[0].replace(/\/+$/, '');
}

// URL 安全化:浏览器 URL 类会自动把中文域名转 punycode;无效地址返回空
function subscriptionSafeUrl(u) {
    try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return parsed.href;
    } catch (e) {
        return '';
    }
}

// 订阅站点名称只保留为普通文本,避免污染现有自定义源 HTML 渲染
function subscriptionCleanName(value) {
    return String(value || '订阅源').replace(/<[^>]*>/g, '').trim().slice(0, 80) || '订阅源';
}

// 经内部代理请求(与搜索同链路,规避 CORS)
async function subscriptionProxiedFetch(url, ms, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms || SUBSCRIPTION_CONFIG.fetchTimeout);
    try {
        const proxiedUrl = window.ProxyAuth && window.ProxyAuth.addAuthToProxyUrl
            ? await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(url))
            : PROXY_URL + encodeURIComponent(url);
        const resp = await fetch(proxiedUrl, {
            headers: headers || API_CONFIG.search.headers,
            signal: controller.signal
        });
        const text = await resp.text();
        clearTimeout(timer);
        return { ok: resp.ok, status: resp.status, text };
    } catch (e) {
        clearTimeout(timer);
        return { ok: false, status: 0, text: '', err: e.name === 'AbortError' ? 'timeout' : (e.message || 'network') };
    }
}

// 单站点实测:ac=videolist&pg=1 不带 wd,要求返回 JSON 且 list 非空
async function subscriptionTestCms(api) {
    const started = Date.now();
    const url = api + (api.includes('?') ? '&' : '?') + 'ac=videolist&pg=1';
    const r = await subscriptionProxiedFetch(url, SUBSCRIPTION_CONFIG.testTimeout);
    if (!r.ok) return { ok: false, reason: r.err || ('HTTP ' + r.status), elapsed: Date.now() - started };
    try {
        const j = JSON.parse(subscriptionFixLooseJson(r.text));
        const list = Array.isArray(j.list) ? j.list : [];
        if (j.code !== undefined && j.code !== 1 && !list.length) {
            return { ok: false, reason: '业务错误code=' + j.code, elapsed: Date.now() - started };
        }
        if (!list.length) return { ok: false, reason: '列表为空', elapsed: Date.now() - started };
        return { ok: true, sample: (list[0] && list[0].vod_name) || '', elapsed: Date.now() - started };
    } catch (e) {
        return { ok: false, reason: '非JSON列表', elapsed: Date.now() - started };
    }
}

// HTML 状态文本转义:订阅名称/错误信息来自第三方,不得直接拼进 innerHTML
function subscriptionEscapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 主入口:解析订阅 → 提取 type=1 → 实测 → 导入自定义API
async function importSubscription() {
    const input = document.getElementById('subscriptionUrl');
    const status = document.getElementById('subscriptionStatus');
    const btn = document.getElementById('subscriptionImportBtn');
    if (!input || !status) return;

    const url = input.value.trim();
    if (!/^https?:\/\//i.test(url)) {
        status.innerHTML = '<div class="text-xs text-red-400">请输入以 http:// 或 https:// 开头的订阅地址</div>';
        return;
    }
    const sourceUrl = subscriptionSafeUrl(url);
    if (!sourceUrl) {
        status.innerHTML = '<div class="text-xs text-red-400">订阅地址无效,请检查协议、域名和路径</div>';
        return;
    }

    const setStatus = (html) => { status.innerHTML = html; };
    setStatus('<div class="text-xs text-gray-400">正在下载订阅…</div>');
    if (btn) btn.disabled = true;
    try {
        // 1. 下载订阅
        const r = await subscriptionProxiedFetch(sourceUrl, SUBSCRIPTION_CONFIG.fetchTimeout);
        if (!r.ok) {
            setStatus(`<div class="text-xs text-red-400">订阅下载失败:${subscriptionEscapeHtml(url)}${r.err ? ('(' + subscriptionEscapeHtml(r.err) + ')') : ''}</div>`);
            return;
        }

        // 2. 解析配置
        const parsed = subscriptionTryParse(r.text);
        if (!parsed) {
            setStatus('<div class="text-xs text-red-400">无法解析该地址(可能是加密或伪装页面)</div>');
            return;
        }
        if (parsed.json.errcode !== undefined || parsed.json.errmsg !== undefined) {
            setStatus(`<div class="text-xs text-red-400">订阅返回错误:${subscriptionEscapeHtml(parsed.json.errmsg || parsed.json.errcode)}</div>`);
            return;
        }

        // 3. 提取候选(直接苹果CMS 也当作单个站点导入)
        let sites = [];
        const cls = subscriptionClassify(parsed.json);
        if (cls === 'tvbox') {
            sites = subscriptionExtractCMSSites(parsed.json);
        } else if (cls === 'cms') {
            sites = [{ key: '订阅源', name: sourceUrl.replace(/^https?:\/\//, '').split('/')[0] || '订阅源', api: sourceUrl }];
        } else {
            setStatus('<div class="text-xs text-red-400">该地址不是 TVBox 配置,无需导入</div>');
            return;
        }

        if (!sites.length) {
            setStatus('<div class="text-xs text-amber-400">该订阅不含可直接使用的苹果CMS站点(多为 TVBox 爬虫源,当前版本不支持执行其脚本)</div>');
            return;
        }
        if (sites.length > 200) sites = sites.slice(0, 200); // 解析上限保护

        // 4. 去重:与内置 API_SITES、已有 customAPIs 的接口/地址比对
        const builtinApis = new Set(Object.keys(API_SITES || {}).map(k => subscriptionNormalizeApi(API_SITES[k].api)));
        const existingUrls = new Set((customAPIs || []).map(a => subscriptionNormalizeApi(a.url)).filter(Boolean));
        const fresh = [];
        for (const s of sites) {
            const safeApi = subscriptionSafeUrl(s.api);
            if (!safeApi) continue;
            const n = subscriptionNormalizeApi(safeApi);
            if (builtinApis.has(n) || existingUrls.has(n)) continue;
            existingUrls.add(n);
            fresh.push({ ...s, api: safeApi, name: subscriptionCleanName(s.name || s.key) });
        }

        // 5. 并发实测
        setStatus(`<div class="text-xs text-gray-400">解析到 ${sites.length} 个站点,其中可用的苹果CMS ${fresh.length} 个,开始实测(并发${SUBSCRIPTION_CONFIG.testConcurrency})…</div>`);
        const results = await mapLimit(fresh, SUBSCRIPTION_CONFIG.testConcurrency, s => subscriptionTestCms(s.api));
        const passed = [];
        const failed = [];
        fresh.forEach((s, i) => {
            if (results[i] && results[i].ok) passed.push({ ...s, test: results[i] });
            else failed.push({ site: s, reason: (results[i] && results[i].reason) || 'unknown' });
        });
        // 通过源按实测耗时排序:导入全部,但后面只自动勾选最快的一小部分
        passed.sort((a, b) => (a.test.elapsed || Infinity) - (b.test.elapsed || Infinity));

        // 6. 上限控制后写入 customAPIs
        const quota = Math.max(0, SUBSCRIPTION_CONFIG.maxImport - (customAPIs || []).length);
        const toImport = passed.slice(0, quota);
        const skippedByQuota = passed.length - toImport.length;
        if (!toImport.length) {
            setStatus(`<div class="text-xs text-amber-400">没有可导入的新站点(实测通过 ${passed.length} 个,已达自定义源上限或全部重复)</div>`);
            return;
        }

        const newIndexes = [];
        toImport.forEach(s => {
            customAPIs.push({ name: s.name || s.key || '订阅源', url: s.api, detail: '', isAdult: false });
            newIndexes.push('custom_' + (customAPIs.length - 1));
        });
        localStorage.setItem('customAPIs', JSON.stringify(customAPIs));
        const autoSelectedIndexes = newIndexes.slice(0, SUBSCRIPTION_CONFIG.autoSelectLimit);
        selectedAPIs = selectedAPIs.concat(autoSelectedIndexes);
        sanitizeSelectedAPIs();
        localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
        if (typeof renderCustomAPIsList === 'function') renderCustomAPIsList();
        if (typeof updateSelectedApiCount === 'function') updateSelectedApiCount();
        if (typeof invalidateHomeCache === 'function') invalidateHomeCache();

        // 7. 汇总
        const failedList = failed.slice(0, 5).map(f => `${subscriptionEscapeHtml(f.site.name || f.site.key)}(<span class="text-red-400">${subscriptionEscapeHtml(f.reason)}</span>)`).join('、');
        setStatus(`
            <div class="text-xs text-green-400">✅ 已导入 ${toImport.length} 个苹果CMS站点</div>
            <div class="text-xs text-gray-400">跳过:重复 ${sites.length - fresh.length} 个,实测失败 ${failed.length} 个${skippedByQuota ? (',超上限截断 ' + skippedByQuota + ' 个') : ''}</div>
            ${failedList ? `<div class="text-xs text-gray-500">失败示例:${failedList}</div>` : ''}
            <div class="text-xs text-gray-500 mt-1">已自动勾选最快的 ${autoSelectedIndexes.length} 个,其余可在「自定义API」列表手动勾选;搜索速度更稳定</div>
        `);
    } catch (e) {
        console.error('订阅导入失败:', e);
        setStatus('<div class="text-xs text-red-400">订阅导入失败,请检查地址或稍后重试</div>');
    } finally {
        if (btn) btn.disabled = false;
    }
}
