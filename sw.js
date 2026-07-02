/* Service worker: makes the app fully offline and handles notification taps. */
const CACHE = 'insomnia-2026-v5';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'vendor/xlsx.full.min.js',
  'data/program.json',
  'data/map.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch cross-origin (e.g. URL imports)

  // Network-first for the program data so "check for update" works online,
  // with cache fallback when offline.
  if (url.pathname.endsWith('data/program.json') || url.pathname.endsWith('data/map.json')) {
    // Явное «обновить» (?fresh=1) — только сеть: приложение должно честно
    // увидеть офлайн/ошибку, а не свежий на вид кэш с ложным успехом.
    // (cache:'reload' в запросе SW не видит — Chromium нормализует режим.)
    if (url.searchParams.has('fresh')) {
      event.respondWith(
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            // кэшируем под каноническим URL без параметра
            caches.open(CACHE).then((c) => c.put(url.pathname.replace(/^\//, ''), copy));
          }
          return res;
        })
      );
      return;
    }
    event.respondWith(
      fetch(req).then(async (res) => {
        if (!res.ok) {
          // сервер ответил ошибкой — не затираем кэш, отдаём офлайн-копию
          const cached = await caches.match(req);
          return cached || res;
        }
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for the app shell.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => cached))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
