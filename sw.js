// Service Worker - 基本缓存 + 离线支持
const CACHE_NAME = 'nav-cache-v8';
const ASSETS_TO_CACHE = [
    './index.html',
    './styles.css',
    './app.js',
    './manifest.json',
    './favicon.svg'
];

// 安装时缓存核心资源
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

    // 导航请求（HTML 页面）：网络优先，失败回退缓存 → 支持离线访问
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    // 网络成功：更新缓存
                    if (response && response.status === 200) {
                        const responseClone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseClone);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // 网络失败：从缓存返回已保存的页面
                    return caches.match('./index.html').then((cached) => {
                        return cached || caches.match(event.request);
                    });
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
