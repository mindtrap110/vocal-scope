const CACHE = 'vocal-scope-v3-20260919-reference-tone1';
const ASSETS = ['./','./index.html','./styles.css','./history.css','./app.js','./history.js','./vocal-scope-patch.js','./reference-tone.js','./pitch-core.js','./pitch-worker.js','./manifest.webmanifest','./icon-180.png','./icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put('./index.html', copy));
        return response;
      } catch (_) {
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    try {
      const fresh = await fetch(event.request);
      if (fresh && fresh.ok) {
        const copy = fresh.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
      }
      return fresh;
    } catch (_) {
      return cached || Response.error();
    }
  })());
});