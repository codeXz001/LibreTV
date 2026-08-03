// LibreTV Service Worker —— 运行时缓存
//
// 缓存策略（按请求类型分治）：
// 1. 页面导航（HTML）       → network-first：优先最新页面，离线时回退缓存
// 2. 静态资源（/js /css /libs /image /manifest.json）
//                           → stale-while-revalidate：命中立即返回，后台刷新缓存
// 3. /proxy/ 图片           → stale-while-revalidate：豆瓣封面/海报二次访问秒开
// 4. 其余（m3u8 流、API 文本等）→ network-only：不做缓存，保证流媒体与数据新鲜
//
// 版本号变更即整体换新缓存；旧缓存自动清理。

const CACHE_VERSION = 'libretv-v3';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGE_CACHE = `${CACHE_VERSION}-pages`;
const IMG_CACHE = `${CACHE_VERSION}-images`;

const STATIC_PREFIXES = ['/js/', '/css/', '/libs/', '/image/'];
const STATIC_EXACT = ['/manifest.json', '/favicon.ico'];

function isStaticAsset(url) {
  const p = url.pathname;
  if (STATIC_EXACT.includes(p)) return true;
  return STATIC_PREFIXES.some(prefix => p.startsWith(prefix));
}

function isImageProxy(url) {
  // 仅对带图片扩展名的 /proxy/ 请求做缓存；m3u8 / JSON 等一律不缓存
  if (!url.pathname.startsWith('/proxy/')) return false;
  return /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico)$/i.test(url.pathname);
}

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 只处理同源请求，跨域（如 allorigins 兜底）不做缓存
  if (url.origin !== self.location.origin) return;

  // 页面导航：network-first
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }

  // 静态资源：stale-while-revalidate
  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    return;
  }

  // 代理图片：stale-while-revalidate
  if (isImageProxy(url)) {
    event.respondWith(staleWhileRevalidate(req, IMG_CACHE));
  }
  // 其余请求走默认网络行为
});

// network-first：导航请求先走网络，失败再回退缓存
async function networkFirst(req) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(req, { ignoreSearch: false });
    if (cached) return cached;
    throw err;
  }
}

// stale-while-revalidate：命中缓存立即返回，同时后台拉新并更新缓存
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);

  // 命中缓存：立即返回，后台刷新（不阻塞响应）
  if (cached) {
    fetch(req)
      .then(resp => {
        if (resp && resp.ok) cache.put(req, resp.clone());
      })
      .catch(() => {});
    return cached;
  }

  // 未命中：等待网络
  const resp = await fetch(req)
    .then(resp => {
      if (resp && resp.ok) cache.put(req, resp.clone());
      return resp;
    })
    .catch(() => null);
  if (resp) return resp;

  // 网络失败：兜底查一次缓存（竞态窗口内可能刚写入）
  const late = await cache.match(req);
  if (late) return late;

  // 完全无可用响应：返回 504，避免 respondWith(undefined) 抛错
  return new Response('Offline', { status: 504, statusText: 'Offline' });
}
