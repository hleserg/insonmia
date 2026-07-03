'use strict';
/* Фаза 3 аудита: офлайн-паранойя. Реальный офлайн = убийство http-сервера
   (setOffline не действует на fetch из service worker'а). */
const { chromium, launchOpts, REPO, tmpProfile } = require('./_env');
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');

const PORT = 8100;
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE = tmpProfile('offline');
const GEO = { latitude: 54.681149, longitude: 35.091007 }; // Экран полевой
// фестиваль: чт 9 — пн 13 июля 2026, МСК = UTC+3
const DAY1_EVENING_UTC = Date.UTC(2026, 6, 9, 15, 0); // 18:00 МСК 9 июля

let server = null;
function serverOn() {
  if (server) return;
  server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  return new Promise(r => setTimeout(r, 700));
}
function serverOff() {
  if (server) { server.kill('SIGKILL'); server = null; }
  return new Promise(r => setTimeout(r, 300));
}

const errors = [];
function watch(page, tag) {
  page.on('pageerror', e => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(`[${tag}] console.error: ${m.text()}`);
  });
}

async function launch({ time = DAY1_EVENING_UTC, fresh = false } = {}) {
  if (fresh) fs.rmSync(PROFILE, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ...launchOpts,
    timezoneId: 'UTC', // докажем таймзонную независимость заодно
    viewport: { width: 360, height: 740 },
    deviceScaleFactor: 2,
    geolocation: GEO,
    permissions: ['geolocation'],
    serviceWorkers: 'allow',
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.clock.install({ time });
  return { ctx, page };
}

async function contentText(page) {
  return page.evaluate(() => {
    const c = document.querySelector('#content');
    const m = document.querySelector('#mapWrap');
    const mapVisible = m && !m.classList.contains('hidden');
    return { text: c ? c.innerText.trim() : '', mapVisible, html: c ? c.innerHTML.length : 0 };
  });
}

async function tap(page, view) {
  await page.click(`.tab[data-view="${view}"]`);
  await page.waitForTimeout(350);
}

async function assertAlive(page, tag) {
  const { text, mapVisible } = await contentText(page);
  assert.ok(text.length > 0 || mapVisible, `${tag}: белый экран (пусто и карта скрыта)`);
}

(async () => {
  // добить хромиумы упавших прогонов, держащие профиль
  try { require('child_process').execSync("pkill -f 'pw-profile' || true"); } catch {}
  await new Promise(r => setTimeout(r, 500));
  console.log('=== Сценарий A: свежая установка онлайн → офлайн НАВСЕГДА → 4 дня ===');
  await serverOn();
  let { ctx, page } = await launch({ fresh: true });
  watch(page, 'A:install');
  await page.goto(BASE + '/', { waitUntil: 'load' });
  // ждём полной установки SW (все ассеты в кэше); поллинг со стороны node —
  // waitForFunction с async-предикатом резолвился до наполнения кэша
  {
    let ok = false;
    for (let i = 0; i < 40; i++) {
      ok = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg || !reg.active) return false;
        const keys = await caches.keys();
        const name = keys.find(k => k.includes('insomnia'));
        if (!name) return false;
        return (await (await caches.open(name)).keys()).length >= 15; // весь прекэш
      });
      if (ok) break;
      await page.waitForTimeout(500);
    }
    assert.ok(ok, 'SW не установился за 20с (прекэш не наполнился)');
  }
  const cacheName = await page.evaluate(async () => (await caches.keys()).join(','));
  console.log('SW установлен, кэши:', cacheName);
  assert.ok(/insomnia-2026-v\d+/.test(cacheName), 'нет именованного кэша insomnia-2026-v*');
  assert.ok(cacheName.split(',').length === 1, 'старые кэши не вычищены: ' + cacheName);

  console.log('-- сервер убит: офлайн навсегда --');
  await serverOff();
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await assertAlive(page, 'A:reload-offline');

  // 4 фестивальных дня
  const days = [
    Date.UTC(2026, 6, 9, 15, 0),   // чт вечер
    Date.UTC(2026, 6, 10, 22, 30), // ночь пт→сб 01:30 МСК: ночная анимация
    Date.UTC(2026, 6, 11, 9, 0),   // сб день 12:00 МСК
    Date.UTC(2026, 6, 12, 20, 0),  // вс ночь 23:00 МСК
  ];
  let starredId = null;
  for (const [i, t] of days.entries()) {
    await page.clock.setSystemTime(t);
    for (const view of ['schedule', 'now', 'favorites', 'map', 'nearby']) {
      await tap(page, view);
      await assertAlive(page, `A:день${i + 1}:${view}`);
    }
    // вкладки дней + фильтры типов
    await tap(page, 'schedule');
    const nDays = await page.evaluate(() => document.querySelectorAll('#dayStrip button').length);
    if (i === 0) console.log('вкладок дней:', nDays);
    for (let d = 0; d < nDays; d++) {
      await page.click(`#dayStrip button >> nth=${d}`);
      await page.waitForTimeout(120);
      await assertAlive(page, `A:день${i + 1}:день-таб${d}`);
    }
    for (const type of ['program', 'animation', 'all']) {
      await page.click(`#typeChips [data-type="${type}"]`);
      await page.waitForTimeout(120);
      await assertAlive(page, `A:день${i + 1}:тип-${type}`);
    }
    // избранное: добавить в день 1, снять другое в день 3
    if (i === 0) {
      const star = await page.$('.fav-btn');
      assert.ok(star, 'A: не нашёл кнопку ★ в сетке');
      await star.click();
      await page.waitForTimeout(200);
      starredId = await page.evaluate(() => JSON.parse(localStorage.getItem('insomnia.favs') || '[]'));
      assert.ok(starredId.length === 1, 'A: избранное не сохранилось (standalone?) ' + JSON.stringify(starredId));
      console.log('★ добавлено, favs =', starredId);
    }
    if (i === 2) {
      await tap(page, 'favorites');
      const badge = await page.textContent('#favBadge');
      assert.equal(badge.trim(), '1', 'A: бейдж избранного != 1: ' + badge);
    }
  }
  // карта: маркеры реально отрисованы (Leaflet)
  await tap(page, 'map');
  await page.waitForTimeout(800);
  const markers = await page.evaluate(() => document.querySelectorAll('#leafletMap .geo-pin, #leafletMap .leaflet-marker-icon').length);
  console.log('маркеров на карте офлайн:', markers);
  assert.ok(markers > 50, 'A: карта офлайн почти пуста: ' + markers + ' маркеров');
  // «рядом» с реальным GPS-провайдером
  await tap(page, 'nearby');
  await page.waitForTimeout(1200);
  const nearbyTxt = (await contentText(page)).text;
  assert.ok(/м\b|метр|Экран|рядом/i.test(nearbyTxt), 'A: «рядом» не показал точек: ' + nearbyTxt.slice(0, 120));
  await ctx.close();
  console.log('A: OK\n');

  console.log('=== Сценарий B: перезапуск PWA офлайн ×5 (включая «перезагрузку телефона») ===');
  for (let k = 1; k <= 5; k++) {
    const r = await launch({ time: days[Math.min(k - 1, 3)] });
    watch(r.page, `B:${k}`);
    await r.page.goto(BASE + '/', { waitUntil: 'load' }).catch(() => {});
    await r.page.waitForTimeout(800);
    await assertAlive(r.page, `B: запуск ${k}`);
    const favs = await r.page.evaluate(() => JSON.parse(localStorage.getItem('insomnia.favs') || '[]'));
    assert.equal(favs.length, 1, `B:${k}: избранное потерялось: ` + JSON.stringify(favs));
    await r.ctx.close();
  }
  console.log('B: OK (избранное живо после 5 перезапусков)\n');

  console.log('=== Сценарий C: localStorage очищен системой, офлайн ===');
  {
    const r = await launch({ time: days[1] });
    watch(r.page, 'C');
    await r.page.goto(BASE + '/', { waitUntil: 'load' }).catch(() => {});
    await r.page.evaluate(() => localStorage.clear());
    await r.page.reload({ waitUntil: 'load' }).catch(() => {});
    await r.page.waitForTimeout(1000);
    await assertAlive(r.page, 'C: старт с чистым storage');
    await tap(r.page, 'schedule');
    const n = await r.page.evaluate(() => document.querySelectorAll('#content .fav-btn').length);
    assert.ok(n > 20, 'C: сетка дня почти пуста после чистки storage: ' + n + ' карточек');
    const ver = await r.page.evaluate(() => localStorage.getItem('insomnia.seenVersion'));
    assert.ok(ver, 'C: программа не поднялась из SW-кэша (seenVersion пуст)');
    const badge = await r.page.textContent('#favBadge');
    assert.equal(badge.trim(), '0', 'C: бейдж не сброшен: ' + badge);
    console.log('C: OK — стартует с дефолтами,', n, 'карточек, версия', ver, '\n');
    await r.ctx.close();
  }

  console.log('=== Сценарий D: недокачанная подложка → изящная деградация карты ===');
  {
    const r = await launch({ time: days[1] });
    watch(r.page, 'D');
    await r.page.goto(BASE + '/', { waitUntil: 'load' }).catch(() => {});
    // выбиваем подложку из кэша, как будто прекэш не докачался
    const del = await r.page.evaluate(async () => {
      const keys = await caches.keys();
      const c = await caches.open(keys[0]);
      const reqs = (await c.keys()).filter(q => q.url.includes('basemap.json'));
      for (const q of reqs) await c.delete(q);
      return reqs.length;
    });
    console.log('удалено из кэша basemap-записей:', del);
    await r.page.reload({ waitUntil: 'load' }).catch(() => {});
    await tap(r.page, 'map');
    await r.page.waitForTimeout(1200);
    const mk = await r.page.evaluate(() => document.querySelectorAll('#leafletMap .geo-pin, #leafletMap .leaflet-marker-icon').length);
    await assertAlive(r.page, 'D: карта без подложки');
    assert.ok(mk > 50, 'D: метки пропали вместе с подложкой: ' + mk);
    console.log('D: OK — карта живёт без подложки,', mk, 'маркеров\n');
    await r.ctx.close();
  }

  await serverOff();
  const real = errors.filter(e => !/favicon/i.test(e))
    // иконки манифеста Chromium качает МИМО service worker'а (ограничение
    // платформы) — офлайн это даёт ошибку загрузки, к приложению не относится
    .filter(e => !/icon from the Manifest/.test(e))
    // сценарий D сам выбивает basemap.json из кэша: сетевой отказ на
    // отсутствующий ресурс неизбежен, проверяем именно изящную деградацию
    .filter(e => !(/^\[D\]/.test(e) && /ERR_FAILED/.test(e)));
  console.log('=== Ошибки консоли/страницы за все сценарии:', real.length, '===');
  real.forEach(e => console.log('  ', e));
  assert.equal(real.length, 0, 'обнаружены ошибки в консоли (см. выше)');
  console.log('\nФАЗА 3: ВСЁ ЗЕЛЁНОЕ');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); serverOff(); process.exit(1); });
