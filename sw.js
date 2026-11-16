const CACHE_NAME = 'okmusic-v2.19.1';
const ASSETS = [
    './index.html',
    './manifest.json',
    './favicon.png',
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

// The page itself: always try the internet first (so updates show up on the FIRST refresh,
// before this served an old saved copy until a second refresh), saved copy only when offline.
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
            .then(res => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then(c => c.put('./index.html', copy)).catch(() => {});
                return res;
            })
            .catch(() => caches.match('./index.html'))
        );
        return;
    }
    event.respondWith(
        caches.match(req).then(response => response || fetch(req))
    );
});
