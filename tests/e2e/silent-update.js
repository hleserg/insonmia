'use strict';
/* Тихое авто-обновление кода: новый SW → перезагрузка в простое, с защитами.
   Работает на КОПИИ приложения во временной папке (меняем sw.js, не трогая
   репозиторий). Реальный SW, реальный http-сервер. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PORT = 8149;
const BASE = `http://127.0.0.1:${PORT}`;
const T = Date.UTC(2026, 6, 10, 18, 0);

const STANDALONE = () => {
  Object.defineProperty(navigator, 'standalone', { get: () => true });
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => (q.includes('standalone') ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } : mm(q));
};

// собрать копию рантайма во временную папку
function makeAppCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-upd-'));
  // ВСЕ файлы из ASSETS в sw.js — иначе cache.addAll упадёт 404 и SW не активируется
  for (const f of ['index.html', 'mesh.html', 'app.js', 'core.js', 'styles.css', 'map.js', 'sw.js', 'manifest.webmanifest']) {
    fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  }
  for (const d of ['data', 'vendor', 'icons']) {
    execSync(`cp -a ${JSON.stringify(path.join(REPO, d))} ${JSON.stringify(dir)}`);
  }
  return dir;
}
function bumpSW(dir) {
  const p = path.join(dir, 'sw.js');
  let s = fs.readFileSync(p, 'utf8');
  s = s.replace(/insomnia-2026-v\d+/, m => m + '-upd' + Date.now());
  fs.writeFileSync(p, s);
}

(async () => {
  const dir = makeAppCopy();
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: dir, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });
  const browser = await chromium.launch(launchOpts);

  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC' });
  await ctx.addInitScript(STANDALONE);
  const page = await ctx.newPage();
  let navs = 0;
  page.on('framenavigated', f => { if (f === page.mainFrame()) navs++; });
  // без page.clock.install: тихий reload на РЕАЛЬНОМ setTimeout(debounce),
  // замороженные часы его бы не запустили
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready; });
  await page.waitForTimeout(1500);

  // 6. Первая установка SW (контроллера ещё не было) → перезагрузки НЕТ
  const navsAfterInstall = navs;
  await page.waitForTimeout(1500);
  assert.equal(navs, navsAfterInstall, 'первая установка SW не должна вызывать reload (навигаций не прибавилось)');
  console.log('✓ первая установка SW — без лишней перезагрузки');

  // теперь есть контроллер; ставим маркер, который переживёт только БЕЗ reload
  await page.evaluate(() => { window.__mark = 'v1'; localStorage.setItem('insomnia.favs', JSON.stringify(['probe-fav'])); });

  // 2. Обновление кода ПРИ ОТКРЫТОЙ модалке → reload НЕ происходит
  await page.click('#btnSettings');
  await page.waitForTimeout(300);
  assert.ok(await page.isVisible('#settings'), 'модалка настроек открыта');
  bumpSW(dir);
  const navsBeforeUpd = navs;
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); if (r) await r.update(); });
  await page.waitForTimeout(4000); // > debounce; но модалка открыта
  assert.equal(navs, navsBeforeUpd, 'при открытой модалке тихий reload НЕ должен сработать');
  const markStill = await page.evaluate(() => window.__mark);
  assert.equal(markStill, 'v1', 'страница не перезагрузилась (маркер жив)');
  console.log('✓ обновление при открытой модалке — reload отложен');

  // закрываем модалку → в простое происходит тихий reload
  await page.click('#settings .icon-btn[data-close]');
  await page.waitForTimeout(300);
  // не трогаем экран ~3с → debounce досчитает и перезагрузит
  await page.waitForTimeout(3500);
  assert.ok(navs > navsBeforeUpd, 'после закрытия модалки и паузы — тихий reload произошёл');
  const markAfter = await page.evaluate(() => window.__mark);
  assert.notEqual(markAfter, 'v1', 'страница перезагрузилась (маркер сброшен)');
  console.log('✓ после закрытия модалки в простое — тихая перезагрузка');

  // 4. Состояние в localStorage пережило reload
  const favProbe = await page.evaluate(() => JSON.parse(localStorage.getItem('insomnia.favs') || '[]'));
  assert.ok(favProbe.includes('probe-fav'), 'избранное пережило авто-перезагрузку');
  console.log('✓ избранное/localStorage переживает авто-reload');

  // 5. guard: повторный controllerchange не должен вызывать второй reload-цикл
  //    (проверяем, что после reload флаг перезагрузки не зациклил навигации)
  const navsSettled = navs;
  await page.waitForTimeout(2500);
  assert.equal(navs, navsSettled, 'нет повторных перезагрузок (guard от двойного reload)');
  console.log('✓ guard: одна перезагрузка, без зацикливания');

  await ctx.close(); await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log('\n=== ТИХОЕ АВТООБНОВЛЕНИЕ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
