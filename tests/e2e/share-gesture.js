'use strict';
/* Кнопки «поделиться» (метка на карте + строка GPS-координат) зовут navigator.share
   СИНХРОННО из обработчика клика — без await до него, иначе теряется пользовательский
   жест (transient activation) и iOS/Android бросают NotAllowedError. Проверяем:
   - при клике navigator.share ВЫЗВАН и в этот момент userActivation.isActive === true
     (жест не потерян) — для обеих кнопок;
   - данные share содержат #pin=-диплинк (ссылка работает);
   - share упал не по «отмене» → фолбэк в буфер (ничего не проглатывается);
   - share отменён (AbortError) → в буфер НЕ пишем (уважаем отмену). */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8271;
const BASE = `http://127.0.0.1:${PORT}`;
const PT = { latitude: 54.68025, longitude: 35.08971 };

// мок navigator.share: mode 'ok' | 'reject' | 'abort'; пишет вызовы в window.__share
const shareInit = (mode) => {
  window.__share = [];
  navigator.share = (data) => {
    window.__share.push({ data, active: !!(navigator.userActivation && navigator.userActivation.isActive) });
    if (mode === 'abort') { const e = new Error('cancel'); e.name = 'AbortError'; return Promise.reject(e); }
    if (mode === 'reject') { const e = new Error('no target'); e.name = 'NotAllowedError'; return Promise.reject(e); }
    return Promise.resolve();
  };
};

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);
  const browser = await chromium.launch(launchOpts);
  let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log('  ✓ ' + m); };

  // контекст c живым GPS-фиксом (accuracy 0 → точный) и заданным моком share
  const open = async (mode) => {
    const ctx = await browser.newContext({
      viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
      geolocation: PT, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
    });
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    await ctx.addInitScript(shareInit, mode);
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.click('.tab[data-view="map"]');
    await page.waitForTimeout(1200); // живой watch ловит фикс → #myCoordShare активна
    return { ctx, page };
  };
  const shareCalls = (page) => page.evaluate(() => window.__share);
  const clip = (page) => page.evaluate(() => navigator.clipboard.readText().catch(() => ''));

  // === 1. КООРДИНАТЫ: share присутствует и резолвит → вызван с сохранённым жестом
  {
    const { ctx, page } = await open('ok');
    check(!(await page.evaluate(() => document.querySelector('#myCoordShare').disabled)), '1. 🔗 координат активна при фиксе');
    await page.click('#myCoordShare');
    await page.waitForTimeout(150);
    const calls = await shareCalls(page);
    check(calls.length === 1, '1. navigator.share вызван один раз при клике');
    check(calls[0].active === true, '1. userActivation активен в момент share (жест НЕ потерян)');
    check(/#pin=54\.680\d+/.test(calls[0].data.url || ''), '1. в share.url — рабочий #pin=-диплинк: ' + calls[0].data.url);
    check(/Я здесь/.test(calls[0].data.text || ''), '1. в share.text — «Я здесь»');
    await ctx.close();
  }

  // === 2. МЕТКА НА КАРТЕ: та же общая функция, жест сохранён
  {
    const { ctx, page } = await open('ok');
    await page.evaluate(() => openPinCard({ lat: 54.68120, lng: 35.09110, name: 'Наш лагерь', emoji: '⛺' }));
    await page.waitForTimeout(200);
    await page.click('#pinCardShare');
    await page.waitForTimeout(150);
    const calls = await shareCalls(page);
    check(calls.length === 1, '2. share метки вызван один раз');
    check(calls[0].active === true, '2. userActivation активен в момент share метки (жест НЕ потерян)');
    check(/#pin=54\.68120,35\.09110,/.test(calls[0].data.url || ''), '2. в share.url — диплинк метки: ' + calls[0].data.url);
    check(decodeURIComponent(calls[0].data.url || '').includes('Наш лагерь'), '2. имя метки в диплинке');
    await ctx.close();
  }

  // === 3. share упал НЕ по «отмене» (NotAllowedError) → фолбэк в буфер (не глотаем)
  {
    const { ctx, page } = await open('reject');
    await page.click('#myCoordShare');
    await page.waitForTimeout(250);
    const c = await clip(page);
    check((await shareCalls(page)).length === 1, '3. share был вызван (и упал не Abort)');
    check(/#pin=54\.680/.test(c) && /Я здесь/.test(c), '3. при провале share — фолбэк в буфер (url+текст): ' + c.slice(0, 60));
    await ctx.close();
  }

  // === 4. share отменён (AbortError) → в буфер НЕ пишем (уважаем отмену)
  {
    const { ctx, page } = await open('abort');
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
    await page.click('#myCoordShare');
    await page.waitForTimeout(250);
    const c = await clip(page);
    check(c === 'SENTINEL', '4. AbortError → буфер не тронут (нет навязчивого фолбэка): ' + c);
    await ctx.close();
  }

  await browser.close();
  killSrv();
  console.log(`\n=== ШАРИНГ: ЖЕСТ СОХРАНЁН, ФОЛБЭКИ ЧЕСТНЫЕ (${ok} проверок) ===`);
  process.exit(0);
})().catch(e => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
