/* Service worker: makes the app fully offline and handles notification taps. */
const CACHE = 'insomnia-2026-v18';
const ASSETS = [
  './',
  'index.html',
  'mesh.html',
  'styles.css',
  'app.js',
  'core.js',
  'vendor/xlsx.full.min.js',
  'data/program.json',
  'data/geo.json',
  'data/basemap.json',
  'map.js',
  'vendor/leaflet.js',
  'vendor/leaflet.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.svg',
  'icons/favicon.ico',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  // без skipWaiting: активация новой версии — по кнопке «обновить» в приложении
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
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
  if (url.pathname.endsWith('data/program.json') || url.pathname.endsWith('data/geo.json') || url.pathname.endsWith('data/basemap.json')) {
    // Явное «обновить» (?fresh=1) — только сеть: приложение должно честно
    // увидеть офлайн/ошибку, а не свежий на вид кэш с ложным успехом.
    // (cache:'reload' в запросе SW не видит — Chromium нормализует режим.)
    if (url.searchParams.has('fresh')) {
      event.respondWith(
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            // кэшируем под каноническим АБСОЛЮТНЫМ URL без параметра
            // (относительный путь в подпапке GitHub Pages удваивал префикс);
            // отказ записи (квота) не должен ронять ответ
            caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy)).catch(() => {});
          }
          return res;
        })
      );
      return;
    }
    // network-first с таймаутом ~3.5с: офлайн/медленная сеть — штатный режим,
    // молча отдаём кэш без ошибок
    event.respondWith((async () => {
      try {
        const res = await Promise.race([
          fetch(req),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3500)),
        ]);
        if (!res.ok) {
          const cached = await caches.match(req);
          return cached || res;
        }
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        return Response.error();
      }
    })());
    return;
  }

  // Cache-first for the app shell. ignoreSearch — чтобы /?now=… находил
  // кэшированный шелл; навигация офлайн всегда падает на index.html.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(async () => {
      if (req.mode === 'navigate') {
        // короткая ссылка без .html (/mesh) — сперва пробуем страницу,
        // и только потом откатываемся на шелл приложения
        const seg = url.pathname.split('/').pop();
        if (seg && !seg.includes('.')) {
          const page = await caches.match(seg + '.html');
          if (page) return page;
        }
        const shell = await caches.match('index.html');
        if (shell) return shell;
      }
      return Response.error();
    }))
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
