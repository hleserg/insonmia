'use strict';
/* Регресс: «запуск в авиарежиме повисает на загрузке».
   На ПРОДЕ CI инжектит <script src="config.js"> (пинг «установили»). config.js
   НЕ прекэшируется SW (свежий токен) → офлайн его сетевой запрос может ЗАВИСНУТЬ
   (wifi без интернета в поле). Если он подключён `defer`, браузер исполняет
   defer-скрипты ПО ПОРЯДКУ → зависший config.js навсегда блокирует app.js →
   boot() не стартует → «вечная загрузка». Фикс: config.js подключается `async`
   (не держит app.js) + загрузки program/geo/basemap в boot стартуют параллельно
   (офлайн один таймаут SW ~3.5с вместо 3×). offline.js это не ловил — там нет
   config.js (он только на проде).

   Тут: свой node-сервер инжектит config.js РОВНО так, как pages.yml (парсим форму
   из sed — если кто-то вернёт defer, тест поймает), «сеть» зависает (сокет висит,
   как на реальном телефоне), холодный запуск офлайн → приложение обязано
   подняться из SW-кэша за разумное время, не зависнуть. */
const { chromium, launchOpts, REPO, tmpProfile } = require('./_env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8135;
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE = tmpProfile('config-offline');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

// Достаём РЕАЛЬНУЮ форму подключения config.js из pages.yml (async|defer),
// чтобы тест ловил регресс (возврат к defer снова повесит офлайн-запуск).
function configScriptTag() {
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'pages.yml'), 'utf8');
  const m = yml.match(/<script src=\\?"config\.js\\?"\s+(async|defer)>/);
  assert.ok(m, 'не нашли инжект config.js в pages.yml');
  return { attr: m[1], tag: `<script src="config.js" ${m[1]}></script>` };
}

const server = { online: true, proc: null };
function makeServer(tag) {
  return http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (!server.online) return; // «авиарежим»: сокет висит, ответа нет (как в поле)
    if (p === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
      res.end('window.APP_CONFIG={tg:{token:"x",chat:"y"}};'); return;
    }
    const f = p === '/' ? '/index.html' : p;
    const file = path.join(REPO, f);
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    let body = fs.readFileSync(file);
    if (f === '/index.html') { // инжектим config.js как это делает CI
      body = Buffer.from(body.toString('utf8').replace('<script src="app.js" defer></script>', tag + '\n  <script src="app.js" defer></script>'));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  });
}

(async () => {
  try { require('child_process').execSync("pkill -f 'pw-profile' || true"); } catch {}
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const { attr, tag } = configScriptTag();
  console.log(`config.js подключается как: ${attr} (${tag})`);
  assert.equal(attr, 'async', 'config.js ДОЛЖЕН быть async, иначе офлайн-запуск виснет на зависшем config.js');

  server.proc = makeServer(tag);
  await new Promise(r => server.proc.listen(PORT, r));
  const ctx = await chromium.launchPersistentContext(PROFILE, { ...launchOpts, viewport: { width: 360, height: 740 }, serviceWorkers: 'allow' });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = ctx.pages()[0] || await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));

  // 1) онлайн: ставим SW (полный прекэш), config.js грузится, APP_CONFIG есть
  await page.goto(BASE + '/', { waitUntil: 'load' });
  let installed = false;
  for (let i = 0; i < 40; i++) {
    installed = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || !reg.active) return false;
      const keys = await caches.keys(); const n = keys.find(k => k.includes('insomnia'));
      return n ? (await (await caches.open(n)).keys()).length >= 15 : false;
    });
    if (installed) break; await page.waitForTimeout(500);
  }
  assert.ok(installed, 'SW не установился онлайн');
  const cfg = await page.evaluate(() => typeof window.APP_CONFIG);
  assert.equal(cfg, 'object', 'онлайн: config.js загрузился, APP_CONFIG есть');
  console.log('✓ онлайн: SW установлен, config.js загружен (APP_CONFIG есть)');

  // 2) «сеть пропала и ЗАВИСАЕТ»: холодный запуск офлайн НЕ должен виснуть
  server.online = false;
  await page.goto(BASE + '/', { waitUntil: 'commit' }).catch(() => {});
  let loadedAt = null;
  for (let i = 0; i < 24; i++) { // до 12с
    await page.waitForTimeout(500);
    const events = await page.evaluate(() => document.querySelectorAll('#content .event, #content .fav-btn').length);
    if (events > 0) { loadedAt = (i + 1) * 500; break; }
  }
  assert.ok(loadedAt, 'ОФЛАЙН ХОЛОДНЫЙ ЗАПУСК ЗАВИС на «загрузке» (config.js/данные заблокировали boot)');
  assert.ok(loadedAt <= 8000, 'офлайн-запуск слишком долгий (' + loadedAt + 'мс) — загрузки не параллелятся?');
  console.log(`✓ офлайн холодный запуск при зависшей сети: поднялось из кэша за ${loadedAt}мс (не виснет)`);

  // приложение живо и на вкладке «программа»
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(400);
  const cards = await page.evaluate(() => document.querySelectorAll('#content .fav-btn').length);
  assert.ok(cards > 20, 'офлайн: сетка дня пуста: ' + cards);
  console.log(`✓ офлайн: программа показывает ${cards} карточек`);

  assert.equal(errs.filter(e => !/APP_CONFIG|config\.js/i.test(e)).length, 0, 'pageerror: ' + errs.join('; '));
  await ctx.close();
  server.proc.close();
  console.log('\n=== АВИАРЕЖИМ: ХОЛОДНЫЙ ЗАПУСК НЕ ВИСНЕТ ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e && e.message); try { server.proc && server.proc.close(); } catch {} process.exit(1); });
