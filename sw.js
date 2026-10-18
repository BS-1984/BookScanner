// Service Worker: hält die App-Dateien offline verfügbar.
// Bei Änderungen an den App-Dateien VERSION erhöhen.
const VERSION = 'v1';
const CACHE = `bookscanner-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/isbn.js',
  './js/lookup.js',
  './js/scanner.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('bookscanner-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Nur eigene Dateien cachen; Buch-APIs und Cover gehen direkt ins Netz.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Netzwerk zuerst (damit Updates ankommen), bei Offline aus dem Cache.
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
