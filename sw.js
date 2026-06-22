// Service Worker - 基本缓存 + 离线支持
// v10: 移除 index.html 的安装时缓存（HTML 由 _worker.js 动态注入配置，缓存会导致配置丢失）
const CACHE_NAME = 'nav-cache-v10';
const ASSETS_TO_CACHE = [
    // 注意：index.html 不在此列表，因为它的内容由 Cloudflare _worker.js 动态注入配置
    // 缓存 HTML 会导致环境变量注入的配置丢失，从而出现"云端同步未配置"错误
    './styles.css',
    './app.js',
    './config-loader.js',
    './manifest.json',
    './favicon.svg'
];

// 安装时缓存核心资源（不含 HTML）
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(ASSETS_TO_CACHE))
            .then(() => self.skipWaiting())
    );
});

// 激活时清理旧缓存
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

// 请求处理：区分导航请求（HTML）和静态资源请求
self.addEventListener('fetch', (event) => {
    const url = event.request.url;

    // 排除 API 请求（Supabase 等），不缓存这些
    if (url.includes('supabase.co') || url.includes('/rest/v1/') || url.includes('/storage/v1/')) {
        return;
    }

    // 导航请求（HTML 页面）：纯网络优先，不缓存 HTML
    // 原因：HTML 由 Cloudflare _worker.js 动态注入环境变量配置，缓存会导致配置丢失
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).catch(() => {
                // 网络失败（离线）：尝试从缓存返回（仅作为最后手段）
                return caches.match(event.request);
            })
        );
        return;
    }

    // 静态资源（CSS/JS/图片）：缓存优先，回退网络
    event.respondWith(
        caches.match(event.request).then((cached) => {
            const fetchPromise = fetch(event.request).then((response) => {
                if (!response || response.status !== 200) {
                    return response;
                }
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseClone);
                });
                return response;
            });
            return cached || fetchPromise;
        })
    );
});
