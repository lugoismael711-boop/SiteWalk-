/* ============================================================
   service-worker.js — offline cache for SiteWalk
   ------------------------------------------------------------
   App shell + the Three.js module are cached so the app opens
   and runs with no network. User photos live in IndexedDB, not
   here. Bump CACHE_VERSION to force clients to update.
   ============================================================ */

const CACHE_VERSION = 'sitewalk-v1';
const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/image.js',
  './js/viewer.js',
  './js/map.js',
  './js/ui.js',
  './js/vendor/three.module.min.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Best-effort: don't fail install if one asset (e.g. CDN) is unreachable.
      Promise.allSettled(APP_SHELL.map((u) => cache.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Stale-while-revalidate for same-origin app shell.
  if (new URL(req.url).origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const network = fetch(req).then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || network;
      })
    );
  }
});
