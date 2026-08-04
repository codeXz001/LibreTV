// 全局变量
// 默认选中源：短剧+4K优先组合
// zuidapi(最大资源-4K强)、wujin(无尽-短剧645)、piaoling(飘零-短剧614)、bfzy(暴风-短剧515)、ffzy(非凡-短剧500)
let selectedAPIs = JSON.parse(localStorage.getItem('selectedAPIs') || '["zuidapi","wujin","piaoling","bfzy","ffzy"]'); // 默认选中资源
let customAPIs = JSON.parse(localStorage.getItem('customAPIs') || '[]'); // 存储自定义API列表

// 添加当前播放的集数索引
let currentEpisodeIndex = 0;
// 添加当前视频的所有集数
let currentEpisodes = [];
// 添加当前视频的标题
let currentVideoTitle = '';
// 全局变量用于倒序状态
let episodesReversed = false;

// —— 详情请求内存缓存（TTL 5 分钟）——
// 同一视频在短时间内重复打开时，直接复用已获取的剧集数据，
// 避免每次都通过 /proxy/ 重新请求上游详情接口。
const DETAIL_CACHE_TTL = 5 * 60 * 1000;
const DETAIL_CACHE_MAX = 100; // 上限，防止长会话内存累积
const detailCacheMap = new Map();
function getCachedDetail(key) {
    const hit = detailCacheMap.get(key);
    if (hit && Date.now() - hit.ts < DETAIL_CACHE_TTL) return hit.data;
    return null;
}
function setCachedDetail(key, data) {
    detailCacheMap.set(key, { ts: Date.now(), data });
    // 超出上限时淘汰最旧一条（FIFO）
    if (detailCacheMap.size > DETAIL_CACHE_MAX) {
        detailCacheMap.delete(detailCacheMap.keys().next().value);
    }
}

// 页面初始化
document.addEventListener('DOMContentLoaded', function () {
    // 首次加载先建立默认配置，再渲染复选框，避免默认源状态不同步。
    if (!localStorage.getItem('hasInitializedDefaults')) {
        // 默认选中资源（只选真实可用且支持搜索的源）
        selectedAPIs = ["ffzy", "jszy", "lzzy", "wujin"];
        localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));

        // 敏感内容过滤固定开启，不提供关闭入口
        localStorage.setItem('yellowFilterEnabled', 'true');
        localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, 'true');

        // 默认启用豆瓣功能
        localStorage.setItem('doubanEnabled', 'true');
        localStorage.setItem('hasInitializedDefaults', 'true');
    }

    sanitizeSelectedAPIs();
    initAPICheckboxes();
    renderCustomAPIsList();
    updateSelectedApiCount();
    renderSearchHistory();

    const yellowFilterToggle = document.getElementById('yellowFilterToggle');
    if (yellowFilterToggle) yellowFilterToggle.checked = true;

    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        adFilterToggle.checked = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false';
    }

    setupEventListeners();
    applyAccessModeUI();
});

// 过滤掉历史配置、导入配置或旧版缓存中的受限数据源。
function sanitizeSelectedAPIs() {
    const before = JSON.stringify(selectedAPIs);
    selectedAPIs = (Array.isArray(selectedAPIs) ? selectedAPIs : []).filter(apiId => {
        if (typeof apiId !== 'string') return false;
        if (apiId.startsWith('custom_')) {
            const index = Number(apiId.slice('custom_'.length));
            return Number.isInteger(index) && customAPIs[index] && !customAPIs[index].isAdult;
        }
        return API_SITES[apiId] && !API_SITES[apiId].adult;
    });
    if (JSON.stringify(selectedAPIs) !== before) {
        localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
    }
}

// 普通模式与管理员模式都强制启用敏感内容过滤；不提供可关闭入口。
function applyAccessModeUI() {
    const toggle = document.getElementById('yellowFilterToggle');
    const toggleWrap = document.getElementById('sensitiveFilterToggleWrap');
    const adminTools = document.getElementById('adminSourceHealth');
    const modeStatus = document.getElementById('accessModeStatus');
    const admin = typeof window.isAdminMode === 'function' && window.isAdminMode();

    localStorage.setItem('yellowFilterEnabled', 'true');
    if (toggle) {
        toggle.checked = true;
        toggle.disabled = true;
        toggle.setAttribute('aria-disabled', 'true');
    }
    if (toggleWrap) toggleWrap.classList.add('hidden');
    if (adminTools) adminTools.classList.toggle('hidden', !admin);
    if (modeStatus) {
        modeStatus.textContent = admin ? '管理员模式' : '普通模式';
        modeStatus.className = admin
            ? 'ml-2 text-xs text-blue-300'
            : 'ml-2 text-xs text-gray-500';
    }
}

document.addEventListener('passwordVerified', applyAccessModeUI);

// 初始化API复选框
function initAPICheckboxes() {
    const container = document.getElementById('apiCheckboxes');
    container.innerHTML = '';

    // 添加普通API组标题
    const normaldiv = document.createElement('div');
    normaldiv.id = 'normaldiv';
    normaldiv.className = 'grid grid-cols-2 gap-2';
    const normalTitle = document.createElement('div');
    normalTitle.className = 'api-group-title';
    normalTitle.textContent = '普通资源';
    normaldiv.appendChild(normalTitle);

    // 创建普通API源的复选框
    Object.keys(API_SITES).forEach(apiKey => {
        const api = API_SITES[apiKey];
        if (api.adult) return; // 跳过成人内容API，稍后添加

        const checked = selectedAPIs.includes(apiKey);

        const checkbox = document.createElement('div');
        checkbox.className = 'flex items-center';
        checkbox.innerHTML = `
            <input type="checkbox" id="api_${apiKey}" 
                   class="form-checkbox h-3 w-3 text-blue-600 bg-[#222] border border-[#333]" 
                   ${checked ? 'checked' : ''} 
                   data-api="${apiKey}">
            <label for="api_${apiKey}" class="ml-1 text-xs text-gray-400 truncate">${api.name}</label>
        `;
        normaldiv.appendChild(checkbox);

        // 添加事件监听器
        checkbox.querySelector('input').addEventListener('change', function () {
            updateSelectedAPIs();
            checkAdultAPIsSelected();
        });
    });
    container.appendChild(normaldiv);

    // 受限内容源不在普通用户界面中展示。
    applyAccessModeUI();
}

// 兼容旧调用：受限内容源不加入配置界面。
function addAdultAPI() {
    const adultdiv = document.getElementById('adultdiv');
    if (adultdiv) adultdiv.remove();
}

// 兼容旧调用：敏感内容过滤始终开启且不可关闭。
function checkAdultAPIsSelected() {
    addAdultAPI();
    applyAccessModeUI();
}

// 渲染自定义API列表
function renderCustomAPIsList() {
    const container = document.getElementById('customApisList');
    if (!container) return;

    if (customAPIs.length === 0) {
        container.innerHTML = '<p class="text-xs text-gray-500 text-center my-2">未添加自定义API</p>';
        return;
    }

    container.innerHTML = '';
    customAPIs.forEach((api, index) => {
        const apiItem = document.createElement('div');
        apiItem.className = 'flex items-center justify-between p-1 mb-1 bg-[#222] rounded';
        const textColorClass = 'text-white';
        // 新增 detail 地址显示
        const detailLine = api.detail ? `<div class="text-xs text-gray-400 truncate">detail: ${api.detail}</div>` : '';
        apiItem.innerHTML = `
            <div class="flex items-center flex-1 min-w-0">
                <input type="checkbox" id="custom_api_${index}"
                       class="form-checkbox h-3 w-3 text-blue-600 mr-1"
                       ${selectedAPIs.includes('custom_' + index) ? 'checked' : ''}
                       data-custom-index="${index}">
                <div class="flex-1 min-w-0">
                    <div class="text-xs font-medium ${textColorClass} truncate">
                        ${api.name}
                    </div>
                    <div class="text-xs text-gray-500 truncate">${api.url}</div>
                    ${detailLine}
                </div>
            </div>
            <div class="flex items-center">
                <button class="text-blue-500 hover:text-blue-700 text-xs px-1" onclick="editCustomApi(${index})">✎</button>
                <button class="text-red-500 hover:text-red-700 text-xs px-1" onclick="removeCustomApi(${index})">✕</button>
            </div>
        `;
        container.appendChild(apiItem);
        apiItem.querySelector('input').addEventListener('change', function () {
            updateSelectedAPIs();
            checkAdultAPIsSelected();
        });
    });
}

// 编辑自定义API
function editCustomApi(index) {
    if (index < 0 || index >= customAPIs.length) return;
    const api = customAPIs[index];
    document.getElementById('customApiName').value = api.name;
    document.getElementById('customApiUrl').value = api.url;
    document.getElementById('customApiDetail').value = api.detail || '';
    const isAdultInput = document.getElementById('customApiIsAdult');
    if (isAdultInput) isAdultInput.checked = api.isAdult || false;
    const form = document.getElementById('addCustomApiForm');
    if (form) {
        form.classList.remove('hidden');
        const buttonContainer = form.querySelector('div:last-child');
        buttonContainer.innerHTML = `
            <button onclick="updateCustomApi(${index})" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs">更新</button>
            <button onclick="cancelEditCustomApi()" class="bg-[#444] hover:bg-[#555] text-white px-3 py-1 rounded text-xs">取消</button>
        `;
    }
}

// 更新自定义API
function updateCustomApi(index) {
    if (index < 0 || index >= customAPIs.length) return;
    const nameInput = document.getElementById('customApiName');
    const urlInput = document.getElementById('customApiUrl');
    const detailInput = document.getElementById('customApiDetail');
    const isAdultInput = document.getElementById('customApiIsAdult');
    const name = nameInput.value.trim();
    let url = urlInput.value.trim();
    const detail = detailInput ? detailInput.value.trim() : '';
    const isAdult = false;
    if (!name || !url) {
        showToast('请输入API名称和链接', 'warning');
        return;
    }
    if (!/^https?:\/\/.+/.test(url)) {
        showToast('API链接格式不正确，需以http://或https://开头', 'warning');
        return;
    }
    if (url.endsWith('/')) url = url.slice(0, -1);
    // 保存 detail 字段
    customAPIs[index] = { name, url, detail, isAdult };
    localStorage.setItem('customAPIs', JSON.stringify(customAPIs));
    renderCustomAPIsList();
    checkAdultAPIsSelected();
    restoreAddCustomApiButtons();
    nameInput.value = '';
    urlInput.value = '';
    if (detailInput) detailInput.value = '';
    if (isAdultInput) isAdultInput.checked = false;
    document.getElementById('addCustomApiForm').classList.add('hidden');
    showToast('已更新自定义API: ' + name, 'success');
}

// 取消编辑自定义API
function cancelEditCustomApi() {
    // 清空表单
    document.getElementById('customApiName').value = '';
    document.getElementById('customApiUrl').value = '';
    document.getElementById('customApiDetail').value = '';
    const isAdultInput = document.getElementById('customApiIsAdult');
    if (isAdultInput) isAdultInput.checked = false;

    // 隐藏表单
    document.getElementById('addCustomApiForm').classList.add('hidden');

    // 恢复添加按钮
    restoreAddCustomApiButtons();
}

// 恢复自定义API添加按钮
function restoreAddCustomApiButtons() {
    const form = document.getElementById('addCustomApiForm');
    const buttonContainer = form.querySelector('div:last-child');
    buttonContainer.innerHTML = `
        <button onclick="addCustomApi()" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs">添加</button>
        <button onclick="cancelAddCustomApi()" class="bg-[#444] hover:bg-[#555] text-white px-3 py-1 rounded text-xs">取消</button>
    `;
}

// 更新选中的API列表
function updateSelectedAPIs() {
    // 获取所有内置API复选框
    const builtInApiCheckboxes = document.querySelectorAll('#apiCheckboxes input:checked');

    // 获取选中的内置API
    const builtInApis = Array.from(builtInApiCheckboxes).map(input => input.dataset.api);

    // 获取选中的自定义API
    const customApiCheckboxes = document.querySelectorAll('#customApisList input:checked');
    const customApiIndices = Array.from(customApiCheckboxes).map(input => 'custom_' + input.dataset.customIndex);

    // 合并内置和自定义API，并再次过滤旧配置中的受限源。
    selectedAPIs = [...builtInApis, ...customApiIndices];
    sanitizeSelectedAPIs();

    // 保存到localStorage
    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));

    // 更新显示选中的API数量
    updateSelectedApiCount();

    // 数据源变更后清空首页推荐缓存（下次进入强制重新拉取）
    if (typeof invalidateHomeCache === 'function') invalidateHomeCache();
}

// 更新选中的API数量显示
function updateSelectedApiCount() {
    const countEl = document.getElementById('selectedApiCount');
    if (countEl) {
        countEl.textContent = selectedAPIs.length;
    }
}

// 全选或取消全选API
function selectAllAPIs(selectAll = true, excludeAdult = false) {
    const checkboxes = document.querySelectorAll('#apiCheckboxes input[type="checkbox"]');

    checkboxes.forEach(checkbox => {
        if (excludeAdult && checkbox.classList.contains('api-adult')) {
            checkbox.checked = false;
        } else {
            checkbox.checked = selectAll;
        }
    });

    updateSelectedAPIs();
    checkAdultAPIsSelected();
}

// 显示添加自定义API表单
function showAddCustomApiForm() {
    const form = document.getElementById('addCustomApiForm');
    if (form) {
        form.classList.remove('hidden');
    }
}

// 取消添加自定义API - 修改函数来重用恢复按钮逻辑
function cancelAddCustomApi() {
    const form = document.getElementById('addCustomApiForm');
    if (form) {
        form.classList.add('hidden');
        document.getElementById('customApiName').value = '';
        document.getElementById('customApiUrl').value = '';
        document.getElementById('customApiDetail').value = '';
        const isAdultInput = document.getElementById('customApiIsAdult');
        if (isAdultInput) isAdultInput.checked = false;

        // 确保按钮是添加按钮
        restoreAddCustomApiButtons();
    }
}

// 添加自定义API
function addCustomApi() {
    const nameInput = document.getElementById('customApiName');
    const urlInput = document.getElementById('customApiUrl');
    const detailInput = document.getElementById('customApiDetail');
    const isAdultInput = document.getElementById('customApiIsAdult');
    const name = nameInput.value.trim();
    let url = urlInput.value.trim();
    const detail = detailInput ? detailInput.value.trim() : '';
    const isAdult = false;
    if (!name || !url) {
        showToast('请输入API名称和链接', 'warning');
        return;
    }
    if (!/^https?:\/\/.+/.test(url)) {
        showToast('API链接格式不正确，需以http://或https://开头', 'warning');
        return;
    }
    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }
    // 保存 detail 字段
    customAPIs.push({ name, url, detail, isAdult });
    localStorage.setItem('customAPIs', JSON.stringify(customAPIs));
    const newApiIndex = customAPIs.length - 1;
    selectedAPIs.push('custom_' + newApiIndex);
    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));

    // 重新渲染自定义API列表
    renderCustomAPIsList();
    updateSelectedApiCount();
    checkAdultAPIsSelected();
    nameInput.value = '';
    urlInput.value = '';
    if (detailInput) detailInput.value = '';
    if (isAdultInput) isAdultInput.checked = false;
    document.getElementById('addCustomApiForm').classList.add('hidden');
    showToast('已添加自定义API: ' + name, 'success');
}

// 移除自定义API
function removeCustomApi(index) {
    if (index < 0 || index >= customAPIs.length) return;

    const apiName = customAPIs[index].name;

    // 从列表中移除API
    customAPIs.splice(index, 1);
    localStorage.setItem('customAPIs', JSON.stringify(customAPIs));

    // 从选中列表中移除此API
    const customApiId = 'custom_' + index;
    selectedAPIs = selectedAPIs.filter(id => id !== customApiId);

    // 更新大于此索引的自定义API索引
    selectedAPIs = selectedAPIs.map(id => {
        if (id.startsWith('custom_')) {
            const currentIndex = parseInt(id.replace('custom_', ''));
            if (currentIndex > index) {
                return 'custom_' + (currentIndex - 1);
            }
        }
        return id;
    });

    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));

    // 重新渲染自定义API列表
    renderCustomAPIsList();

    // 更新选中的API数量
    updateSelectedApiCount();

    // 重新检查成人API选中状态
    checkAdultAPIsSelected();

    showToast('已移除自定义API: ' + apiName, 'info');
}

function toggleSettings(e) {
    const settingsPanel = document.getElementById('settingsPanel');
    if (!settingsPanel) return;

    if (settingsPanel.classList.contains('show')) {
        settingsPanel.classList.remove('show');
    } else {
        settingsPanel.classList.add('show');
    }

    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
}

// 设置事件监听器
function setupEventListeners() {
    // 回车搜索
    document.getElementById('searchInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            search();
        }
    });

    // 阶段 3.1：搜索结果卡片事件委托（替代 onclick 模板字符串）
    const resultsContainer = document.getElementById('results');
    if (resultsContainer) {
        resultsContainer.addEventListener('click', function (e) {
            const card = e.target.closest('.js-search-result');
            if (!card) return;
            // 聚合卡片：进入多源切换详情
            if (card.dataset.aggregateKey) {
                showAggregatedDetails(card.dataset.aggregateKey);
                return;
            }
            // 单源卡片（兼容旧路径）
            showDetails(
                card.dataset.id || '',
                card.dataset.name || '',
                card.dataset.source || ''
            );
        });
    }

    // F3：详情弹窗点遮罩关闭（移动端无 × 按钮也可取消；一次绑定）
    const detailModal = document.getElementById('modal');
    if (detailModal && !detailModal.dataset.overlayCloseBound) {
        detailModal.dataset.overlayCloseBound = '1';
        detailModal.addEventListener('click', function (e) {
            if (e.target === detailModal) closeModal();
        });
    }

    // 阶段 3.1：剧集按钮事件委托（替代 onclick 模板字符串）
    // episodesGrid 在 showDetails 里动态创建，绑定到 modalContent 上
    document.addEventListener('click', function (e) {
        const epBtn = e.target.closest('.js-episode-btn');
        if (epBtn) {
            const url = epBtn.dataset.url || '';
            const name = epBtn.dataset.name || '';
            const source = epBtn.dataset.source || '';
            const idx = parseInt(epBtn.dataset.index || '0', 10);
            const vodId = epBtn.dataset.vodId || '';
            playVideo(url, name, source, idx, vodId);
            return;
        }
        const toggleBtn = e.target.closest('.js-toggle-order');
        if (toggleBtn) {
            const source = toggleBtn.dataset.source || '';
            const vodId = toggleBtn.dataset.vodId || '';
            toggleEpisodeOrder(source, vodId);
            return;
        }
        // 聚合详情：资源源切换标签
        const srcTab = e.target.closest('.source-tab');
        if (srcTab) {
            const idx = parseInt(srcTab.dataset.sourceIndex || '0', 10);
            loadAggregateSource(idx);
        }
    });

    // 点击外部关闭设置面板和历史记录面板
    document.addEventListener('click', function (e) {
        // 关闭设置面板
        const settingsPanel = document.querySelector('#settingsPanel.show');
        const settingsButton = document.querySelector('#settingsPanel .close-btn');

        if (settingsPanel && settingsButton &&
            !settingsPanel.contains(e.target) &&
            !settingsButton.contains(e.target)) {
            settingsPanel.classList.remove('show');
        }

        // 关闭历史记录面板
        const historyPanel = document.querySelector('#historyPanel.show');
        const historyButton = document.querySelector('#historyPanel .close-btn');

        if (historyPanel && historyButton &&
            !historyPanel.contains(e.target) &&
            !historyButton.contains(e.target)) {
            historyPanel.classList.remove('show');
        }
    });

    // 敏感内容过滤固定开启，不允许通过界面关闭
    const yellowFilterToggle = document.getElementById('yellowFilterToggle');
    if (yellowFilterToggle) {
        yellowFilterToggle.addEventListener('change', function (e) {
            e.target.checked = true;
            localStorage.setItem('yellowFilterEnabled', 'true');
            applyAccessModeUI();
        });
    }

    // 广告过滤开关事件绑定
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        adFilterToggle.addEventListener('change', function (e) {
            localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, e.target.checked);
        });
    }
}

// 重置搜索区域
function resetSearchArea() {
    // 清理搜索结果
    document.getElementById('results').innerHTML = '';
    document.getElementById('searchInput').value = '';
    // 清空分批渲染状态，避免旧结果残留
    searchAllResults = [];
    searchRenderedCount = 0;

    // 恢复搜索区域的样式
    document.getElementById('searchArea').classList.add('flex-1');
    document.getElementById('searchArea').classList.remove('mb-8');
    document.getElementById('resultsArea').classList.add('hidden');
    // 退出搜索态：恢复 Hero 完整高度
    document.body.classList.remove('is-searching');
    // 返回"影视"视图（结果区在该视图内）
    if (typeof switchView === 'function') switchView('view-home');

    // 确保页脚正确显示，移除相对定位
    const footer = document.querySelector('.footer');
    if (footer) {
        footer.style.position = '';
    }

    // 如果有豆瓣功能，检查是否需要显示豆瓣推荐区域
    if (typeof updateDoubanVisibility === 'function') {
        updateDoubanVisibility();
    }

    // 重置URL为主页
    try {
        window.history.pushState(
            {},
            `LibreTV - 免费在线视频搜索与观看平台`,
            `/`
        );
        // 更新页面标题
        document.title = `LibreTV - 免费在线视频搜索与观看平台`;
    } catch (e) {
        console.error('更新浏览器历史失败:', e);
    }
}

// 获取自定义API信息
function getCustomApiInfo(customApiIndex) {
    const index = parseInt(customApiIndex);
    if (isNaN(index) || index < 0 || index >= customAPIs.length) {
        return null;
    }
    return customAPIs[index];
}

// 搜索功能 - 修改为支持多选API和多页结果
async function search() {
    // 强化的密码保护校验 - 防止绕过
    try {
        if (window.ensurePasswordProtection) {
            window.ensurePasswordProtection();
        } else {
            // 兼容性检查
            if (window.isPasswordProtected && window.isPasswordVerified) {
                if (window.isPasswordProtected() && !window.isPasswordVerified()) {
                    showPasswordModal && showPasswordModal();
                    return;
                }
            }
        }
    } catch (error) {
        console.warn('Password protection check failed:', error.message);
        return;
    }

    sanitizeSelectedAPIs();

    // 搜索结果区位于"影视"视图内：从"源配置/我的"页发起搜索时自动切回
    if (typeof switchView === 'function') switchView('view-home');

    const query = document.getElementById('searchInput').value.trim();

    if (!query) {
        showToast('请输入搜索内容', 'info');
        return;
    }

    if (selectedAPIs.length === 0) {
        showToast('请至少选择一个API源', 'warning');
        return;
    }

    // 搜索时用区域骨架屏替代全屏遮罩，减少打断感（结果区原地占位）
    renderSearchSkeletons();
    // 兜底超时保护：防止个别上游源长时间无响应拖住整个搜索
    const searchTimeoutGuard = setTimeout(() => {
        showToast('搜索耗时较长，已自动停止', 'warning');
        hideLoading();
    }, 45000);

    try {
        // 保存搜索历史
        saveSearchHistory(query);

        // 从所有选中的API源搜索
        let allResults = [];
        const searchPromises = selectedAPIs.map(apiId => 
            searchByAPIAndKeyWord(apiId, query)
        );

        // 等待所有搜索请求完成
        const resultsArray = await Promise.all(searchPromises);

        // 合并所有结果
        resultsArray.forEach(results => {
            if (Array.isArray(results) && results.length > 0) {
                allResults = allResults.concat(results);
            }
        });

        // 对搜索结果进行排序：按名称优先，名称相同时按接口源排序
        allResults.sort((a, b) => {
            // 首先按照视频名称排序
            const nameCompare = (a.vod_name || '').localeCompare(b.vod_name || '');
            if (nameCompare !== 0) return nameCompare;
            
            // 如果名称相同，则按照来源排序
            return (a.source_name || '').localeCompare(b.source_name || '');
        });

        // 更新搜索结果计数
        const searchResultsCount = document.getElementById('searchResultsCount');
        if (searchResultsCount) {
            searchResultsCount.textContent = allResults.length;
        }

        // 显示结果区域，调整搜索区域
        document.getElementById('searchArea').classList.remove('flex-1');
        document.getElementById('searchArea').classList.add('mb-8');
        document.getElementById('resultsArea').classList.remove('hidden');
        // 进入搜索态：收缩 Hero，让结果区上移到首屏
        document.body.classList.add('is-searching');

        // 隐藏豆瓣推荐区域（如果存在）
        const doubanArea = document.getElementById('doubanArea');
        if (doubanArea) {
            doubanArea.classList.add('hidden');
        }

        const resultsDiv = document.getElementById('results');

        // 如果没有结果
        if (!allResults || allResults.length === 0) {
            resultsDiv.innerHTML = `
                <div class="col-span-full text-center py-16">
                    <svg class="mx-auto h-12 w-12 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                              d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <h3 class="mt-2 text-lg font-medium text-gray-400">没有找到匹配的结果</h3>
                    <p class="mt-1 text-sm text-gray-500">请尝试其他关键词或更换数据源</p>
                </div>
            `;
            hideLoading();
            return;
        }

        // 有搜索结果时，才更新URL
        try {
            // 使用URI编码确保特殊字符能够正确显示
            const encodedQuery = encodeURIComponent(query);
            // 使用HTML5 History API更新URL，不刷新页面
            window.history.pushState(
                { search: query },
                `搜索: ${query} - LibreTV`,
                `/s=${encodedQuery}`
            );
            // 更新页面标题
            document.title = `搜索: ${query} - LibreTV`;
        } catch (e) {
            console.error('更新浏览器历史失败:', e);
            // 如果更新URL失败，继续执行搜索
        }

        // 处理搜索结果过滤：如果启用了黄色内容过滤，则过滤掉分类含有敏感内容的项目
        const yellowFilterEnabled = localStorage.getItem('yellowFilterEnabled') === 'true';
        if (yellowFilterEnabled) {
            // BANNED_TYPE_NAMES 定义于 config.js（搜索与首页推荐共用，单一事实源）
            const banned = (typeof BANNED_TYPE_NAMES !== 'undefined') ? BANNED_TYPE_NAMES : [];
            allResults = allResults.filter(item => {
                const typeName = item.type_name || '';
                return !banned.some(keyword => typeName.includes(keyword));
            });
        }

        // 聚合搜索结果：不同资源站返回的同一影片（按标题归一化）合并为一张卡片，
        // 点击后可在各源之间切换查看/播放
        allResults = aggregateSearchResults(allResults);
        // 更新计数为聚合后的组数
        if (searchResultsCount) {
            searchResultsCount.textContent = allResults.length;
        }

        // 分批渲染搜索结果（避免一次性渲染数千条 DOM 导致卡顿）
        resultsDiv.innerHTML = '';
        searchAllResults = allResults;
        searchRenderedCount = 0;
        renderSearchResults(resultsDiv);
    } catch (error) {
        console.error('搜索错误:', error);
        const failMsg = error.name === 'AbortError'
            ? '搜索请求超时，请检查网络连接'
            : '搜索请求失败，请稍后重试';
        showToast(failMsg, 'error');
        // 搜索失败时清掉骨架，给出空态提示，避免骨架残留
        const resultsDiv = document.getElementById('results');
        if (resultsDiv) {
            resultsDiv.innerHTML = `
                <div class="col-span-full text-center py-16">
                    <svg class="mx-auto h-12 w-12 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <h3 class="mt-2 text-lg font-medium text-gray-400">搜索失败</h3>
                    <p class="mt-1 text-sm text-gray-500">${failMsg}</p>
                </div>`;
        }
    } finally {
        clearTimeout(searchTimeoutGuard);
        hideLoading();
    }
}

// 渲染搜索结果区骨架屏（搜索进行中原地占位，结果返回后整体替换）
function renderSearchSkeletons() {
    const resultsDiv = document.getElementById('results');
    const resultsArea = document.getElementById('resultsArea');
    const countEl = document.getElementById('searchResultsCount');
    if (resultsArea) resultsArea.classList.remove('hidden');
    document.body.classList.add('is-searching');
    if (countEl) countEl.textContent = '…';
    if (resultsDiv) {
        resultsDiv.innerHTML = Array.from({ length: 12 }, () => `
            <div class="skeleton-card bg-[#141414] rounded-lg overflow-hidden">
                <div class="skeleton-img shimmer"></div>
                <div class="p-3 space-y-2">
                    <div class="skeleton-line shimmer" style="width:70%"></div>
                    <div class="skeleton-line shimmer" style="width:45%"></div>
                </div>
            </div>`).join('');
    }
}

// ================= 搜索结果分批渲染 =================
// 搜索可能返回数千条结果，一次性渲染会卡顿主线程。
// 改为每批 SEARCH_BATCH_SIZE 条 + 「加载更多」按钮，滚动/点击分批展示。
let searchAllResults = [];
let searchRenderedCount = 0;
const SEARCH_BATCH_SIZE = 60;

// 追加渲染下一批结果；全部渲染完后移除「加载更多」按钮
function renderSearchResults(resultsDiv) {
    if (!resultsDiv) return;
    if (searchRenderedCount >= searchAllResults.length) return;

    const batch = searchAllResults.slice(searchRenderedCount, searchRenderedCount + SEARCH_BATCH_SIZE);
    const html = batch.map(group => buildAggregatedCardHtml(group)).join('');

    // 移除旧的「加载更多」按钮
    const oldBtn = document.getElementById('loadMoreBtn');
    if (oldBtn) oldBtn.remove();

    resultsDiv.insertAdjacentHTML('beforeend', html);
    searchRenderedCount += batch.length;

    // 对本批海报图床域名补 dns-prefetch（图床与 API 域名不同源，无法静态枚举，运行时提示）
    if (window.hintImageHosts) {
        const picUrls = [];
        for (const g of batch) {
            if (!g || !g.items) continue;
            for (const it of g.items) {
                if (it && it.vod_pic) picUrls.push(it.vod_pic);
            }
        }
        if (picUrls.length) window.hintImageHosts(picUrls);
    }

    const remaining = searchAllResults.length - searchRenderedCount;
    if (remaining > 0) {
        resultsDiv.insertAdjacentHTML('beforeend', `
            <div class="col-span-full text-center py-5">
                <button id="loadMoreBtn" class="load-more-btn" onclick="loadMoreResults()">加载更多（${remaining}）</button>
            </div>`);
    }

    // 对新插入的图片注册懒加载（重复 observe 同一元素无副作用）
    observeLazyImages(resultsDiv);
}

// 「加载更多」按钮回调
function loadMoreResults() {
    const resultsDiv = document.getElementById('results');
    if (resultsDiv) renderSearchResults(resultsDiv);
}

// 切换清空按钮的显示状态
function toggleClearButton() {
    const searchInput = document.getElementById('searchInput');
    const clearButton = document.getElementById('clearSearchInput');
    if (searchInput.value !== '') {
        clearButton.classList.remove('hidden');
    } else {
        clearButton.classList.add('hidden');
    }
}

// 清空搜索框内容
function clearSearchInput() {
    const searchInput = document.getElementById('searchInput');
    searchInput.value = '';
    const clearButton = document.getElementById('clearSearchInput');
    clearButton.classList.add('hidden');
}

// 劫持搜索框的value属性以检测外部修改
function hookInput() {
    const input = document.getElementById('searchInput');
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

    // 重写 value 属性的 getter 和 setter
    Object.defineProperty(input, 'value', {
        get: function () {
            // 确保读取时返回字符串（即使原始值为 undefined/null）
            const originalValue = descriptor.get.call(this);
            return originalValue != null ? String(originalValue) : '';
        },
        set: function (value) {
            // 显式将值转换为字符串后写入
            const strValue = String(value);
            descriptor.set.call(this, strValue);
            this.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    // 初始化输入框值为空字符串（避免初始值为 undefined）
    input.value = '';
}
document.addEventListener('DOMContentLoaded', hookInput);

// 详情数据请求（带 5 分钟内存缓存），供单源详情与聚合详情复用
async function fetchDetailData(id, sourceCode) {
    if (!id) return null;
    // 构建API参数
    let apiParams = '';
    if (sourceCode.startsWith('custom_')) {
        const customIndex = sourceCode.replace('custom_', '');
        const customApi = getCustomApiInfo(customIndex);
        if (!customApi) return null;
        apiParams = customApi.detail
            ? '&customApi=' + encodeURIComponent(customApi.url) + '&customDetail=' + encodeURIComponent(customApi.detail) + '&source=custom'
            : '&customApi=' + encodeURIComponent(customApi.url) + '&source=custom';
    } else {
        apiParams = '&source=' + sourceCode;
    }

    // 详情缓存：命中则跳过上游请求（剧集数据 5 分钟内有效）
    const detailCacheKey = `${sourceCode}:${id}`;
    let data = getCachedDetail(detailCacheKey);
    if (!data) {
        const timestamp = new Date().getTime();
        const cacheBuster = `&_t=${timestamp}`;
        const response = await fetch(`/api/detail?id=${encodeURIComponent(id)}${apiParams}${cacheBuster}`);
        data = await response.json();
        setCachedDetail(detailCacheKey, data);
    }
    return data;
}

// 渲染详情主体 HTML（封面 + 信息 + 排序按钮 + 剧集网格），供单源与聚合详情复用
function renderDetailBody(data, vod_name, sourceCode, id) {
    // 构建详情信息HTML
    let detailInfoHtml = '';
    if (data.videoInfo) {
        // Prepare description text, strip HTML and trim whitespace
        const descriptionText = data.videoInfo.desc ? data.videoInfo.desc.replace(/<[^>]+>/g, '').trim() : '';

        // Check if there's any actual grid content
        const hasGridContent = data.videoInfo.type || data.videoInfo.year || data.videoInfo.area || data.videoInfo.director || data.videoInfo.actor || data.videoInfo.remarks;

        if (hasGridContent || descriptionText) { // Only build if there's something to show
            detailInfoHtml = `
        <div class="modal-detail-info">
            ${hasGridContent ? `
            <div class="detail-grid">
                ${data.videoInfo.type ? `<div class="detail-item"><span class="detail-label">类型:</span> <span class="detail-value">${data.videoInfo.type}</span></div>` : ''}
                ${data.videoInfo.year ? `<div class="detail-item"><span class="detail-label">年份:</span> <span class="detail-value">${data.videoInfo.year}</span></div>` : ''}
                ${data.videoInfo.area ? `<div class="detail-item"><span class="detail-label">地区:</span> <span class="detail-value">${data.videoInfo.area}</span></div>` : ''}
                ${data.videoInfo.director ? `<div class="detail-item"><span class="detail-label">导演:</span> <span class="detail-value">${data.videoInfo.director}</span></div>` : ''}
                ${data.videoInfo.actor ? `<div class="detail-item"><span class="detail-label">主演:</span> <span class="detail-value">${data.videoInfo.actor}</span></div>` : ''}
                ${data.videoInfo.remarks ? `<div class="detail-item"><span class="detail-label">备注:</span> <span class="detail-value">${data.videoInfo.remarks}</span></div>` : ''}
            </div>` : ''}
            ${descriptionText ? `
            <div class="detail-desc">
                <p class="detail-label">简介:</p>
                <p class="detail-desc-content">${descriptionText}</p>
            </div>` : ''}
        </div>
        `;
        }
    }

    // 封面图（懒加载 + 失败回退，无封面时跳过）
    const coverUrl = data.videoInfo && data.videoInfo.cover;
    const safeTitleAttr = (vod_name || '未知视频').toString().replace(/"/g, '&quot;');
    const coverHtml = coverUrl && /^https?:\/\//i.test(coverUrl) ? `
        <div class="lazy-img-wrap relative w-full max-w-[160px] aspect-[2/3] rounded-lg overflow-hidden mb-4 mx-auto sm:mx-0 flex-shrink-0">
            <img src="${IMG_TRANSPARENT}" data-src="${coverUrl.replace(/"/g, '&quot;')}" alt="${safeTitleAttr}"
                 class="w-full h-full object-cover"
                 onerror="handleImageError(this)"
                 decoding="async">
        </div>` : '';

    const safeSourceCode = sourceCode.replace(/"/g, '&quot;');
    const safeVodId = (id || '').toString().replace(/"/g, '&quot;');

    return `
        <div class="sm:flex sm:gap-5">
            ${coverHtml}
            <div class="flex-1 min-w-0">
                ${detailInfoHtml}
            </div>
        </div>
        <div class="flex flex-wrap items-center justify-between mb-4 gap-2">
            <div class="flex items-center gap-2">
                <button class="js-toggle-order px-3 py-1.5 bg-[#333] hover:bg-[#444] border border-[#444] rounded text-sm transition-colors flex items-center gap-1"
                        data-source="${safeSourceCode}"
                        data-vod-id="${safeVodId}">
                    <svg class="w-4 h-4 transform ${episodesReversed ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>
                    </svg>
                    <span>${episodesReversed ? '正序排列' : '倒序排列'}</span>
                </button>
                <span class="text-gray-400 text-sm">共 ${data.episodes.length} 集</span>
            </div>
            <button onclick="copyLinks()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm transition-colors">
                复制链接
            </button>
        </div>
        <div id="episodesGrid" class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
            ${renderEpisodes(vod_name, sourceCode, id)}
        </div>
    `;
}

// 显示详情 - 修改为支持自定义API
async function showDetails(id, vod_name, sourceCode) {
    // 密码保护校验
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }
    if (!id) {
        showToast('视频ID无效', 'error');
        return;
    }

    showLoading();
    try {
        const data = await fetchDetailData(id, sourceCode);
        if (!data) {
            showToast('自定义API配置无效', 'error');
            return;
        }

        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modalTitle');
        const modalContent = document.getElementById('modalContent');

        // 显示来源信息
        const sourceName = data.videoInfo && data.videoInfo.source_name ?
            ` <span class="text-sm font-normal text-gray-400">(${data.videoInfo.source_name})</span>` : '';

        // 不对标题进行截断处理，允许完整显示
        modalTitle.innerHTML = `<span class="break-words">${vod_name || '未知视频'}</span>${sourceName}`;
        currentVideoTitle = vod_name || '未知视频';

        if (data.episodes && data.episodes.length > 0) {
            currentEpisodes = data.episodes;
            currentEpisodeIndex = 0;
            modalContent.innerHTML = renderDetailBody(data, vod_name, sourceCode, id);
            // 注册弹窗内懒加载（封面图等）
            observeLazyImages(modalContent);
        } else {
            modalContent.innerHTML = `
                <div class="text-center py-8">
                    <div class="text-red-400 mb-2">❌ 未找到播放资源</div>
                    <div class="text-gray-500 text-sm">该视频可能暂时无法播放，请尝试其他视频</div>
                </div>
            `;
        }

        modal.classList.remove('hidden');
    } catch (error) {
        console.error('获取详情错误:', error);
        showToast('获取详情失败，请稍后重试', 'error');
    } finally {
        hideLoading();
    }
}

// ============ 搜索结果聚合：多源同片合并 + 详情内切换 ============
let currentAggregatedItems = [];
let currentAggregateSourceIndex = 0;
const aggregateItemMap = new Map(); // 归一化标题 -> items[]

// 标题归一化：同一影片在不同源命名有差异（如《战狼》vs《战狼 (2015)》），
// 去空白/括号/连接符/尾部年份后作为聚合键
function normalizeTitle(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[\s\u3000]+/g, '')        // 去空白
        .replace(/[《》\[\]【】]/g, '')      // 去书名号/方括号
        .replace(/[()（）]/g, '')            // 去括号（保留内部文字）
        .replace(/[·:：\-—_~,，.。!！?？]/g, '') // 去连接符/标点
        .replace(/(19|20)\d{2}$/, '')        // 去尾部年份
        .trim();
}

// 将搜索结果按归一化标题聚合；填充 aggregateItemMap 供详情切换使用
function aggregateSearchResults(results) {
    aggregateItemMap.clear();
    const map = new Map();
    results.forEach(item => {
        const key = normalizeTitle(item.vod_name);
        if (!key) return;
        if (!map.has(key)) map.set(key, { key, name: item.vod_name, items: [] });
        map.get(key).items.push(item);
    });
    const groups = Array.from(map.values());
    groups.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    groups.forEach(g => aggregateItemMap.set(g.key, g.items));
    return groups;
}

// 构建聚合卡片（多源徽章 + 归一化 key）
function buildAggregatedCardHtml(group) {
    const items = group.items;
    const first = items[0] || {};
    // 优先取有封面的条目作为卡片封面
    const coverItem = items.find(i => i.vod_pic && i.vod_pic.startsWith('http')) || first;
    const hasCover = !!(coverItem && coverItem.vod_pic && coverItem.vod_pic.startsWith('http'));

    const safeName = (first.vod_name || '').toString()
        .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const safeKey = group.key.replace(/"/g, '&quot;');
    const sourceCount = items.length;

    // 源徽章：最多展示 4 个，超出显示 +N
    const badges = items.slice(0, 4).map(i =>
        `<span class="bg-[#222] text-xs px-1.5 py-0.5 rounded-full border border-[#333]">${(i.source_name || '未知').toString().replace(/"/g, '&quot;')}</span>`
    ).join('');
    const moreBadge = sourceCount > 4
        ? `<span class="text-xs text-gray-500">+${sourceCount - 4}</span>` : '';

    const typeName = (first.type_name || '').toString().replace(/</g, '&lt;');
    const year = first.vod_year || '';
    const remarks = (first.vod_remarks || '暂无介绍').toString().replace(/</g, '&lt;');

    return `
        <div class="card-hover bg-[#111] rounded-lg overflow-hidden cursor-pointer transition-all hover:scale-[1.02] h-full shadow-sm hover:shadow-md js-search-result"
             data-aggregate-key="${safeKey}">
            <div class="flex h-full">
                ${hasCover ? `
                <div class="lazy-img-wrap relative flex-shrink-0 search-card-img-container">
                    <img src="${IMG_TRANSPARENT}" data-src="${coverItem.vod_pic}" data-orig="${coverItem.vod_pic}" alt="${safeName}"
                         class="h-full w-full object-cover transition-transform hover:scale-110"
                         onerror="handleImageError(this)"
                         loading="lazy" decoding="async">
                    <div class="absolute inset-0 bg-gradient-to-r from-black/30 to-transparent"></div>
                </div>` : ''}

                <div class="p-2 flex flex-col flex-grow">
                    <div class="flex-grow">
                        <h3 class="font-semibold mb-2 break-words line-clamp-2 ${hasCover ? '' : 'text-center'}" title="${safeName}">${safeName}</h3>

                        <div class="flex flex-wrap ${hasCover ? '' : 'justify-center'} gap-1 mb-2">
                            ${typeName ? `<span class="text-xs py-0.5 px-1.5 rounded bg-opacity-20 bg-blue-500 text-blue-300">${typeName}</span>` : ''}
                            ${year ? `<span class="text-xs py-0.5 px-1.5 rounded bg-opacity-20 bg-purple-500 text-purple-300">${year}</span>` : ''}
                        </div>
                        <p class="text-gray-400 line-clamp-2 overflow-hidden ${hasCover ? '' : 'text-center'} mb-2">
                            ${remarks}
                        </p>
                    </div>

                    <div class="flex flex-wrap items-center justify-between mt-1 pt-1 border-t border-gray-800 gap-1">
                        <div class="flex flex-wrap items-center gap-1">
                            ${badges}
                            ${moreBadge}
                        </div>
                        <span class="text-xs text-gray-500 flex-shrink-0">${sourceCount} 个源</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// 渲染资源源切换标签
function renderSourceTabsHtml(items, activeIndex) {
    const tabs = items.map((item, i) => {
        const safeSourceName = (item.source_name || '未知源').toString().replace(/"/g, '&quot;');
        return `<button class="source-tab${i === activeIndex ? ' active' : ''}" data-source-index="${i}" title="切换到${safeSourceName}">${safeSourceName}</button>`;
    }).join('');
    return `<div class="source-tabs">${tabs}</div>`;
}

// 打开聚合详情：标题 + 源切换条 + 默认加载第一个源
async function showAggregatedDetails(key) {
    // 密码保护校验
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }
    const items = aggregateItemMap.get(key) || [];
    if (!items.length) {
        showToast('该视频暂无可用资源', 'warning');
        return;
    }

    currentAggregatedItems = items;
    currentAggregateSourceIndex = 0;

    const modal = document.getElementById('modal');
    const modalTitle = document.getElementById('modalTitle');
    const modalContent = document.getElementById('modalContent');
    const first = items[0];
    const safeTitle = (first.vod_name || '未知视频').toString()
        .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    modalTitle.innerHTML = `<span class="break-words">${safeTitle}</span>`;
    currentVideoTitle = first.vod_name || '未知视频';

    // 立即显示弹窗（先用原顺序渲染 tabs），后台测速完成后重排
    modalContent.innerHTML = renderSourceTabsHtml(items, 0) + `<div id="aggregateDetailBody"></div>`;
    modal.classList.remove('hidden');
    const body = document.getElementById('aggregateDetailBody');
    if (body) body.innerHTML = `<div class="text-center py-10 text-gray-400">正在检测各源响应速度...</div>`;

    // ===== 多源按响应速度排序：速度快的源优先、默认选中 =====
    // 并行发起各源详情请求测速：命中缓存立即完成；未命中 3s 超时兜底（排后）。
    // 测速同时预热详情缓存，用户切换源时秒开。
    const sortedItems = await measureAndSortSources(items);
    currentAggregatedItems = sortedItems;
    currentAggregateSourceIndex = 0;

    // F1：写入聚合组（已按速度排序），供播放页换源联动复用
    try {
        localStorage.setItem('aggregatedSources', JSON.stringify(sortedItems.map(i => ({
            source_code: i.source_code,
            source_name: i.source_name,
            vod_id: i.vod_id,
            vod_name: i.vod_name,
            vod_pic: i.vod_pic || ''
        }))));
    } catch (e) {
        // 存储失败不影响主流程
    }

    // 按速度顺序重排源切换标签
    const tabsEl = modalContent.querySelector('.source-tabs');
    if (tabsEl) tabsEl.outerHTML = renderSourceTabsHtml(sortedItems, 0);

    await loadAggregateSource(0);
}

// 并行测速各源详情请求，按耗时升序返回（速度快的在前）
async function measureAndSortSources(items) {
    const SOURCE_SPEED_TIMEOUT = 3000;
    const timed = [];
    await Promise.all(items.map(async (it) => {
        const t0 = performance.now();
        try {
            await Promise.race([
                fetchDetailData(it.vod_id, it.source_code),
                new Promise(r => setTimeout(r, SOURCE_SPEED_TIMEOUT))
            ]);
        } catch (e) {
            // 测速失败按最慢处理
        }
        timed.push({ item: it, elapsed: performance.now() - t0 });
    }));
    timed.sort((a, b) => a.elapsed - b.elapsed);
    return timed.map(t => t.item);
}

// Q2：检测全部内置数据源可用性（并发 4，wd=test 轻量请求，8s 超时）
async function checkAllSources() {
    if (typeof window.isAdminMode === 'function' && !window.isAdminMode()) {
        showToast('仅管理员模式可检测数据源', 'warning');
        return;
    }
    const btn = document.getElementById('checkSourcesBtn');
    const list = document.getElementById('sourceHealthList');
    if (!list) return;
    if (btn) btn.disabled = true;
    list.classList.remove('hidden');
    list.innerHTML = '<div class="text-xs text-gray-500 text-center py-1">正在检测...</div>';

    const keys = Object.keys(API_SITES || {}).filter(key => !API_SITES[key].adult);
    const results = [];
    await mapLimit(keys, 4, async (key) => {
        const site = API_SITES[key];
        const t0 = performance.now();
        let ok = false;
        try {
            const apiUrl = site.api + API_CONFIG.search.path + encodeURIComponent('测试');
            const proxiedUrl = window.ProxyAuth?.addAuthToProxyUrl
                ? await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl))
                : PROXY_URL + encodeURIComponent(apiUrl);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const resp = await fetch(proxiedUrl, {
                headers: API_CONFIG.search.headers,
                signal: controller.signal
            });
            clearTimeout(timer);
            if (resp.ok) {
                const data = await resp.json().catch(() => null);
                ok = !!(data && (data.code === 1 || Array.isArray(data.list)));
            }
        } catch (e) {
            ok = false;
        }
        results.push({ key, name: site.name, ok, elapsed: Math.round(performance.now() - t0) });
    });

    // 渲染：可用在前，按耗时升序
    results.sort((a, b) => (a.ok === b.ok ? a.elapsed - b.elapsed : a.ok ? -1 : 1));
    list.innerHTML = results.map(r => {
        const safeName = (r.name || r.key).toString().replace(/"/g, '&quot;').replace(/</g, '&lt;');
        return `
            <div class="flex justify-between items-center text-xs px-2 py-1 rounded ${r.ok ? 'bg-green-900/30' : 'bg-red-900/30'}">
                <span class="text-gray-200 truncate">${safeName}</span>
                <span class="flex-shrink-0 ${r.ok ? 'text-green-400' : 'text-red-400'}">${r.ok ? `可用 ${r.elapsed}ms` : '不可用'}</span>
            </div>`;
    }).join('');

    if (btn) btn.disabled = false;
}

// 加载指定索引的资源源详情到聚合详情区
async function loadAggregateSource(index) {
    const item = currentAggregatedItems[index];
    if (!item) return;
    currentAggregateSourceIndex = index;

    const body = document.getElementById('aggregateDetailBody');
    if (!body) return;

    // 更新标签高亮
    document.querySelectorAll('#modalContent .source-tab').forEach((btn, i) => {
        btn.classList.toggle('active', i === index);
    });

    const safeSourceName = (item.source_name || '未知源').toString().replace(/"/g, '&quot;');
    body.innerHTML = `<div class="text-center py-10 text-gray-400">正在加载「${safeSourceName}」资源...</div>`;

    try {
        const data = await fetchDetailData(item.vod_id, item.source_code);
        if (!data) {
            body.innerHTML = `<div class="text-center py-8 text-gray-400">该源暂不可用，请切换其他资源</div>`;
            return;
        }
        currentEpisodes = data.episodes || [];
        currentEpisodeIndex = 0;
        currentVideoTitle = item.vod_name || currentVideoTitle;

        if (data.episodes && data.episodes.length > 0) {
            body.innerHTML = renderDetailBody(data, item.vod_name, item.source_code, item.vod_id);
            observeLazyImages(body);
        } else {
            body.innerHTML = `
                <div class="text-center py-8">
                    <div class="text-red-400 mb-2">❌ 未找到播放资源</div>
                    <div class="text-gray-500 text-sm">该源暂无可用资源，可切换到其他源</div>
                </div>`;
        }
    } catch (e) {
        console.error('加载聚合源详情失败:', e);
        body.innerHTML = `
            <div class="text-center py-8">
                <div class="text-red-400 mb-2">❌ 加载失败</div>
                <div class="text-gray-500 text-sm">请切换到其他资源源</div>
            </div>`;
    }
}

// 更新播放视频函数，修改为使用/watch路径而不是直接打开player.html
function playVideo(url, vod_name, sourceCode, episodeIndex = 0, vodId = '') {
    // 密码保护校验
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }

    // 获取当前路径作为返回页面
    let currentPath = window.location.href;

    // 构建播放页面URL，使用watch.html作为中间跳转页
    let watchUrl = `watch.html?id=${vodId || ''}&source=${sourceCode || ''}&url=${encodeURIComponent(url)}&index=${episodeIndex}&title=${encodeURIComponent(vod_name || '')}`;

    // 添加返回URL参数
    if (currentPath.includes('index.html') || currentPath.endsWith('/')) {
        watchUrl += `&back=${encodeURIComponent(currentPath)}`;
    }

    // 保存当前状态到localStorage
    try {
        localStorage.setItem('currentVideoTitle', vod_name || '未知视频');
        localStorage.setItem('currentEpisodes', JSON.stringify(currentEpisodes));
        localStorage.setItem('currentEpisodeIndex', episodeIndex);
        localStorage.setItem('currentSourceCode', sourceCode || '');
        localStorage.setItem('lastPlayTime', Date.now());
        localStorage.setItem('lastSearchPage', currentPath);
        localStorage.setItem('lastPageUrl', currentPath);  // 确保保存返回页面URL
    } catch (e) {
        console.error('保存播放状态失败:', e);
    }

    // 在当前标签页中打开播放页面
    window.location.href = watchUrl;
}

// 弹出播放器页面
function showVideoPlayer(url) {
    // 在打开播放器前，隐藏详情弹窗
    const detailModal = document.getElementById('modal');
    if (detailModal) {
        detailModal.classList.add('hidden');
    }
    // 临时隐藏搜索结果和豆瓣区域，防止高度超出播放器而出现滚动条
    document.getElementById('resultsArea').classList.add('hidden');
    const doubanArea = document.getElementById('doubanArea');
    if (doubanArea) doubanArea.classList.add('hidden');
    // 在框架中打开播放页面
    videoPlayerFrame = document.createElement('iframe');
    videoPlayerFrame.id = 'VideoPlayerFrame';
    videoPlayerFrame.className = 'fixed w-full h-screen z-40';
    videoPlayerFrame.src = url;
    document.body.appendChild(videoPlayerFrame);
    // 将焦点移入iframe
    videoPlayerFrame.focus();
}

// 关闭播放器页面
function closeVideoPlayer(home = false) {
    videoPlayerFrame = document.getElementById('VideoPlayerFrame');
    if (videoPlayerFrame) {
        videoPlayerFrame.remove();
        // 恢复搜索结果显示
        document.getElementById('resultsArea').classList.remove('hidden');
        // 关闭播放器时也隐藏详情弹窗
        const detailModal = document.getElementById('modal');
        if (detailModal) {
            detailModal.classList.add('hidden');
        }
        // 如果启用豆瓣区域则显示豆瓣区域
        if (localStorage.getItem('doubanEnabled') === 'true') {
            const doubanArea = document.getElementById('doubanArea');
            if (doubanArea) doubanArea.classList.remove('hidden');
        }
    }
    if (home) {
        // 刷新主页
        window.location.href = '/'
    }
}

// 播放上一集
function playPreviousEpisode(sourceCode) {
    if (currentEpisodeIndex > 0) {
        const prevIndex = currentEpisodeIndex - 1;
        const prevUrl = currentEpisodes[prevIndex];
        playVideo(prevUrl, currentVideoTitle, sourceCode, prevIndex);
    }
}

// 播放下一集
function playNextEpisode(sourceCode) {
    if (currentEpisodeIndex < currentEpisodes.length - 1) {
        const nextIndex = currentEpisodeIndex + 1;
        const nextUrl = currentEpisodes[nextIndex];
        playVideo(nextUrl, currentVideoTitle, sourceCode, nextIndex);
    }
}

// 处理播放器加载错误
function handlePlayerError() {
    hideLoading();
    showToast('视频播放加载失败，请尝试其他视频源', 'error');
}

// 辅助函数用于渲染剧集按钮（使用当前的排序状态）
function renderEpisodes(vodName, sourceCode, vodId) {
    const episodes = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    // 阶段 3.1：用 data-* 属性 + 容器事件委托替代 onclick 模板字符串
    // 之前 `onclick="playVideo('${episode}','...','${sourceCode}',${realIndex},'${vodId}')"`
    // 里的 episode（m3u8 URL）和 sourceCode 来自外部接口，未充分转义。
    const safeVodName = vodName.replace(/"/g, '&quot;');
    return episodes.map((episode, index) => {
        // 根据倒序状态计算真实的剧集索引
        const realIndex = episodesReversed ? currentEpisodes.length - 1 - index : index;
        return `
            <button id="episode-${realIndex}"
                    class="px-4 py-2 bg-[#222] hover:bg-[#333] border border-[#333] rounded-lg transition-colors text-center episode-btn js-episode-btn"
                    data-url="${episode.replace(/"/g, '&quot;')}"
                    data-name="${safeVodName}"
                    data-source="${sourceCode}"
                    data-index="${realIndex}"
                    data-vod-id="${vodId}">
                ${realIndex + 1}
            </button>
        `;
    }).join('');
}

// 复制视频链接到剪贴板
function copyLinks() {
    const episodes = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    const linkList = episodes.join('\r\n');
    navigator.clipboard.writeText(linkList).then(() => {
        showToast('播放链接已复制', 'success');
    }).catch(err => {
        showToast('复制失败，请检查浏览器权限', 'error');
    });
}

// 切换排序状态的函数
function toggleEpisodeOrder(sourceCode, vodId) {
    episodesReversed = !episodesReversed;
    // 重新渲染剧集区域，使用 currentVideoTitle 作为视频标题
    const episodesGrid = document.getElementById('episodesGrid');
    if (episodesGrid) {
        episodesGrid.innerHTML = renderEpisodes(currentVideoTitle, sourceCode, vodId);
    }

    // 阶段 3.1：改用 data-* 属性定位按钮，不再依赖 onclick 属性字符串
    const toggleBtn = document.querySelector(
        `.js-toggle-order[data-source="${CSS.escape(sourceCode)}"][data-vod-id="${CSS.escape(vodId)}"]`
    );
    if (toggleBtn) {
        toggleBtn.querySelector('span').textContent = episodesReversed ? '正序排列' : '倒序排列';
        const arrowIcon = toggleBtn.querySelector('svg');
        if (arrowIcon) {
            arrowIcon.style.transform = episodesReversed ? 'rotate(180deg)' : 'rotate(0deg)';
        }
    }
}

// 从URL导入配置
async function importConfigFromUrl() {
    // 创建模态框元素
    let modal = document.getElementById('importUrlModal');
    if (modal) {
        document.body.removeChild(modal);
    }

    modal = document.createElement('div');
    modal.id = 'importUrlModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-40';

    modal.innerHTML = `
        <div class="bg-[#191919] rounded-lg p-6 max-w-md w-full max-h-[90vh] overflow-y-auto relative">
            <button id="closeUrlModal" class="absolute top-4 right-4 text-gray-400 hover:text-white text-xl">&times;</button>
            
            <h3 class="text-xl font-bold mb-4">从URL导入配置</h3>
            
            <div class="mb-4">
                <input type="text" id="configUrl" placeholder="输入配置文件URL" 
                       class="w-full px-3 py-2 bg-[#222] border border-[#333] rounded-lg text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
            </div>
            
            <div class="flex justify-end space-x-2">
                <button id="confirmUrlImport" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">导入</button>
                <button id="cancelUrlImport" class="bg-[#444] hover:bg-[#555] text-white px-4 py-2 rounded">取消</button>
            </div>
        </div>`;

    document.body.appendChild(modal);

    // 关闭按钮事件
    document.getElementById('closeUrlModal').addEventListener('click', () => {
        document.body.removeChild(modal);
    });

    // 取消按钮事件
    document.getElementById('cancelUrlImport').addEventListener('click', () => {
        document.body.removeChild(modal);
    });

    // 确认导入按钮事件
    document.getElementById('confirmUrlImport').addEventListener('click', async () => {
        const url = document.getElementById('configUrl').value.trim();
        if (!url) {
            showToast('请输入配置文件URL', 'warning');
            return;
        }

        // 验证URL格式
        try {
            const urlObj = new URL(url);
            if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
                showToast('URL必须以http://或https://开头', 'warning');
                return;
            }
        } catch (e) {
            showToast('URL格式不正确', 'warning');
            return;
        }

        showLoading('正在从URL导入配置...');

        try {
            // 获取配置文件 - 直接请求URL
            const response = await fetch(url, {
                mode: 'cors',
                headers: {
                    'Accept': 'application/json'
                }
            });
            if (!response.ok) throw '获取配置文件失败';

            // 验证响应内容类型
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                throw '响应不是有效的JSON格式';
            }

            const config = await response.json();
            if (config.name !== 'LibreTV-Settings') throw '配置文件格式不正确';

            // 验证哈希
            const dataHash = await sha256(JSON.stringify(config.data));
            if (dataHash !== config.hash) throw '配置文件哈希值不匹配';

            // 导入配置
            for (let item in config.data) {
                localStorage.setItem(item, config.data[item]);
            }

            showToast('配置文件导入成功，3 秒后自动刷新本页面。', 'success');
            setTimeout(() => {
                window.location.reload();
            }, 3000);
        } catch (error) {
            const message = typeof error === 'string' ? error : '导入配置失败';
            showToast(`从URL导入配置出错 (${message})`, 'error');
        } finally {
            hideLoading();
            document.body.removeChild(modal);
        }
    });

    // 点击模态框外部关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
}

// 配置文件导入功能
async function importConfig() {
    showImportBox(async (file) => {
        try {
            // 检查文件类型
            if (!(file.type === 'application/json' || file.name.endsWith('.json'))) throw '文件类型不正确';

            // 检查文件大小
            if (file.size > 1024 * 1024 * 10) throw new Error('文件大小超过 10MB');

            // 读取文件内容
            const content = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject('文件读取失败');
                reader.readAsText(file);
            });

            // 解析并验证配置
            const config = JSON.parse(content);
            if (config.name !== 'LibreTV-Settings') throw '配置文件格式不正确';

            // 验证哈希
            const dataHash = await sha256(JSON.stringify(config.data));
            if (dataHash !== config.hash) throw '配置文件哈希值不匹配';

            // 导入配置
            for (let item in config.data) {
                localStorage.setItem(item, config.data[item]);
            }

            showToast('配置文件导入成功，3 秒后自动刷新本页面。', 'success');
            setTimeout(() => {
                window.location.reload();
            }, 3000);
        } catch (error) {
            const message = typeof error === 'string' ? error : '配置文件格式错误';
            showToast(`配置文件读取出错 (${message})`, 'error');
        }
    });
}

// 配置文件导出功能
async function exportConfig() {
    // 存储配置数据
    const config = {};
    const items = {};

    const settingsToExport = [
        'selectedAPIs',
        'customAPIs',
        'yellowFilterEnabled',
        'adFilteringEnabled',
        'doubanEnabled',
        'hasInitializedDefaults'
    ];

    // 导出设置项
    settingsToExport.forEach(key => {
        const value = localStorage.getItem(key);
        if (value !== null) {
            items[key] = value;
        }
    });

    // 导出历史记录
    const viewingHistory = localStorage.getItem('viewingHistory');
    if (viewingHistory) {
        items['viewingHistory'] = viewingHistory;
    }

    const searchHistory = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (searchHistory) {
        items[SEARCH_HISTORY_KEY] = searchHistory;
    }

    const times = Date.now().toString();
    config['name'] = 'LibreTV-Settings';  // 配置文件名，用于校验
    config['time'] = times;               // 配置文件生成时间
    config['cfgVer'] = '1.0.0';           // 配置文件版本
    config['data'] = items;               // 配置文件数据
    config['hash'] = await sha256(JSON.stringify(config['data']));  // 计算数据的哈希值，用于校验

    // 将配置数据保存为 JSON 文件
    saveStringAsFile(JSON.stringify(config), 'LibreTV-Settings_' + times + '.json');
}

// 将字符串保存为文件
function saveStringAsFile(content, fileName) {
    // 创建Blob对象并指定类型
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    // 生成临时URL
    const url = window.URL.createObjectURL(blob);
    // 创建<a>标签并触发下载
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    // 清理临时对象
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

// 移除Node.js的require语句，因为这是在浏览器环境中运行的
