'use strict';
/* Кнопки «поделиться» (метка на карте + строка GPS-координат) зовут navigator.share
   СИНХРОННО из обработчика клика — без await до него, иначе теряется пользовательский
   жест (transient activation) и iOS/Android бросают NotAllowedError.

   Детектор синхронности НАДЁЖНЫЙ: внутри одного page.evaluate переопределяем
   navigator.share, диспатчим element.click() (синхронно) и СРАЗУ после возврата
   click() ставим during=false. Синхронный share зовётся ДО возврата click()
   (during ещё true); вызов после любого await — уже false. (userActivation.isActive
   и микротаск-сентинелы тут не годятся: активация живёт ~5с, а микротаски бегут
   между листенерами события.) Мутационно проверено: await перед share роняет тест.

   Ещё проверяем: #pin=-диплинк в share.url; share упал не по «отмене» → фолбэк в
   буфер (ничего не глотаем); share отменён (AbortError) → буфер НЕ трогаем. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8271;
const BASE = `http://127.0.0.1:${PORT}`;
const PT = { latitude: 54.68025, longitude: 35.08971 };

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);
  const browser = await chromium.launch(launchOpts);
  let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log('  ✓ ' + m); };

  // контекст c живым GPS-фиксом (accuracy 0 → точный)
  const open = async () => {
    const ctx = await browser.newContext({
      viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
      geolocation: PT, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
    });
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.click('.tab[data-view="map"]');
    await page.waitForTimeout(1200); // живой watch ловит фикс → #myCoordShare активна
    return { ctx, page };
  };

  // синхронно ли зовётся navigator.share из клика по кнопке sel? → {sync, data}
  const shareSyncOnClick = (page, sel) => page.evaluate((s) => new Promise((resolve) => {
    let during = true;
    const rec = [];
    navigator.share = (data) => { rec.push({ data, sync: during }); return Promise.resolve(); };
    document.querySelector(s).click(); // синхронный диспатч клика
    during = false;                    // ставим ПОСЛЕ возврата click() (ещё синхронно)
    setTimeout(() => resolve(rec[0] || null), 40); // дать отработать возможному await-пути
  }), sel);

  // === 1. КООРДИНАТЫ «я здесь»: share зовётся СИНХРОННО (жест не потерян)
  {
    const { ctx, page } = await open();
    check(!(await page.evaluate(() => document.querySelector('#myCoordShare').disabled)), '1. 🔗 координат активна при фиксе');
    const r = await shareSyncOnClick(page, '#myCoordShare');
    check(r !== null, '1. navigator.share вызван при клике');
    check(r.sync === true, '1. share вызван СИНХРОННО в жесте (до возврата click())');
    check(/#pin=54\.680\d+/.test(r.data.url || ''), '1. в share.url — рабочий #pin=-диплинк: ' + r.data.url);
    check(/Я здесь/.test(r.data.text || ''), '1. в share.text — «Я здесь»');
    await ctx.close();
  }

  // === 2. МЕТКА НА КАРТЕ: та же общая функция, share синхронно
  {
    const { ctx, page } = await open();
    await page.evaluate(() => openPinCard({ lat: 54.68120, lng: 35.09110, name: 'Наш лагерь', emoji: '⛺' }));
    await page.waitForTimeout(200);
    const r = await shareSyncOnClick(page, '#pinCardShare');
    check(r !== null, '2. share метки вызван при клике');
    check(r.sync === true, '2. share метки вызван СИНХРОННО в жесте (жест НЕ потерян)');
    check(/#pin=54\.68120,35\.09110,/.test(r.data.url || ''), '2. в share.url — диплинк метки: ' + r.data.url);
    check(decodeURIComponent(r.data.url || '').includes('Наш лагерь'), '2. имя метки в диплинке');
    await ctx.close();
  }

  // === 3. share упал НЕ по «отмене» (NotAllowedError) → фолбэк в буфер (не глотаем)
  {
    const { ctx, page } = await open();
    await page.evaluate(() => { navigator.share = () => { const e = new Error('no target'); e.name = 'NotAllowedError'; return Promise.reject(e); }; });
    await page.click('#myCoordShare');
    await page.waitForTimeout(250);
    const c = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    check(/#pin=54\.680/.test(c) && /Я здесь/.test(c), '3. при провале share (не Abort) — фолбэк в буфер (url+текст): ' + c.slice(0, 60));
    await ctx.close();
  }

  // === 4. share отменён (AbortError) → в буфер НЕ пишем (уважаем отмену)
  {
    const { ctx, page } = await open();
    await page.evaluate(() => { navigator.share = () => { const e = new Error('cancel'); e.name = 'AbortError'; return Promise.reject(e); }; });
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
    await page.click('#myCoordShare');
    await page.waitForTimeout(250);
    const c = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    check(c === 'SENTINEL', '4. AbortError → буфер не тронут (нет навязчивого фолбэка): ' + c);
    await ctx.close();
  }

  await browser.close();
  killSrv();
  console.log(`\n=== ШАРИНГ: ЖЕСТ СОХРАНЁН, ФОЛБЭКИ ЧЕСТНЫЕ (${ok} проверок) ===`);
  process.exit(0);
})().catch(e => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
