const CACHE = 'vocal-scope-v2-20260916-short-bg1';
const ASSETS = ['./','./index.html','./styles.css','./history.css','./app.js','./history.js','./vocal-scope-patch.js','./pitch-core.js','./pitch-worker.js','./manifest.webmanifest','./icon-180.png','./icon-512.png'];
const PATCH_TAG = '<script src="./vocal-scope-patch.js" defer></script>';

async function withRuntimePatch(response) {
  if (!response) return response;
  const html = await response.text();
  const patched = html.includes('vocal-scope-patch.js') ? html : html.replace('</body>', `${PATCH_TAG}\n</body>`);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(patched, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const network = await fetch(e.request);
        const patched = await withRuntimePatch(network);
        const copy = patched.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy));
        return patched;
      } catch (_) {
        const cached = await caches.match('./index.html');
        return withRuntimePatch(cached);
      }
    })());
    return;
  }
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
    const copy = resp.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return resp;
  })));
});