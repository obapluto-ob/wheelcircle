// App-shell cache. Only static same-origin GETs are cached; API, payment and
// dev routes always go to the network so money is never read from a stale copy.
const CACHE = 'wheel-shell-v6';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/auth.css',
  '/mech.css',
  '/engine.css',
  '/practice.css',
  '/v2.css',
  '/open-circle.css',
  '/legal.css',
  '/studio.css',
  '/assets/studio/machine-hall.jpg',
  '/assets/studio/pot-light.jpg',
  '/assets/studio/pot-chamber.jpg',
  '/boot.js',
  '/app.js',
  '/audio.js',
  '/engine.js',
  '/practice.js',
  '/practice-model.mjs',
  '/rules.mjs',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-1024.png',
  '/terms.html',
  '/privacy.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

const BYPASS = [/^\/functions\//, /^\/dev\//, /^\/api\//];

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS.some((pattern) => pattern.test(url.pathname))) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put('/index.html', fresh.clone()).catch(() => null);
        return fresh;
      } catch {
        return (await caches.match('/index.html')) || Response.error();
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone())).catch(() => null);
      return response;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
