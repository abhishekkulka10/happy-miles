const CACHE_NAME = 'happy-miles-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.png'
];

// Install Event - Pre-cache App Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate Event - Clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    )
  );
  self.clients.claim();
});

// Fetch Event - Dynamic handling
self.addEventListener('fetch', (event) => {
  // Direct fetch for Google Sheets API calls
  if (event.request.url.includes('googleapis.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first strategy for local site assets
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});