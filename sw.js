const CACHE_NAME = 'happy-miles-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.png'
];

// Install: pre-cache static assets
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

// Activate: automatically clean up old caches on update
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Network-First for HTML/page requests, Cache-First for static assets
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('googleapis.com')) {
    e.respondWith(fetch(e.request));
    return;
  }
  
  // Always try fetching the latest HTML/page from network first
  if (e.request.mode === 'navigate' || e.request.url.endsWith('index.html')) {
    e.respondWith(
      fetch(e.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
        return response;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for images/icons
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
