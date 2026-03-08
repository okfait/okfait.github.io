const CACHE_NAME = 'okmusic-v2.6.5';
const ASSETS = [
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
        .then(cache => cache.addAll(ASSETS))
        .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.map(key => {
                    if (key !== CACHE_NAME) return caches.delete(key);
                })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
        .then(response => {
            return response || fetch(event.request).catch(() => {
                // If network fails (offline) and not in cache, try index.html
                if (event.request.mode === 'navigate') {
                    return caches.match('./index.html');
                }
            });
        })
    );
});
