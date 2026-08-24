const CACHE_NAME = 'happy-miles-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('googleapis.com')) {
    e.respondWith(fetch(e.request));
    return;
  }
  
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});