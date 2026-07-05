'use strict';
/* Вкладка «Карта» всегда открывается СВЕРХУ: фильтры-чипсы и строка «мои
   координаты» (для потеряшек — всегда под рукой) не должны прятаться под верхней
   кромкой из-за window-скролла от прошлого длинного списка. Скролл к верху — только
   при СВЕЖЕМ открытии карты, а не на ре-рендер по поиску/фильтру (иначе страница
   дёргалась бы вверх посреди ввода). Проверяем: открытие из прокрученной программы,
   повторное открытие («всегда»), событие→карта, сохранение позиции при фильтре, офлайн. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8182;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const { spawn } = require('child_process');
  let srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
    geolocation: { latitude: 54.68025, longitude: 35.08971 }, permissions: ['geolocation'],
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });

  const scrollY = () => page.evaluate(() => window.scrollY);
  // элемент целиком в видимой области (top>=0 и не ниже нижней кромки)
  const onScreen = (sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el || el.classList.contains('hidden')) return false;
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight && r.bottom > 0;
  }, sel);
  const openMap = async () => { await page.click('.tab[data-view="map"]'); await page.waitForTimeout(900); };

  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(700);

  // --- 1. открыл карту из ПРОКРУЧЕННОЙ вниз программы → карта сверху, чипсы+координаты видны
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, 1200)); await page.waitForTimeout(200);
  assert.ok(await scrollY() > 400, 'программа реально прокручена вниз');
  await openMap();
  assert.equal(await scrollY(), 0, '1: карта открылась СВЕРХУ (scrollY=0), не унаследовала скролл списка');
  assert.ok(await onScreen('#mapChips'), '1: фильтры-чипсы карты видны');
  assert.ok(await onScreen('#myCoordRow'), '1: строка «мои координаты» видна (для потеряшек)');
  console.log('✓ 1. карта из прокрученной программы открывается сверху (чипсы + координаты видны)');

  // --- 2. «ВСЕГДА»: ушёл на программу (прокрутил) → вернулся на карту → снова сверху
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 900)); await page.waitForTimeout(150);
  await openMap();
  assert.equal(await scrollY(), 0, '2: повторное открытие карты — снова сверху («всегда»)');
  assert.ok(await onScreen('#myCoordRow'), '2: координаты снова видны');
  console.log('✓ 2. карта ВСЕГДА открывается сверху (повторный заход)');

  // --- 3. ре-рендер по фильтру НЕ дёргает страницу вверх (свежий скролл сохранён)
  await page.evaluate(() => window.scrollTo(0, 60)); await page.waitForTimeout(150);
  const yBeforeChip = await scrollY();
  assert.ok(yBeforeChip > 0, '3: удалось прокрутить карту на чуть вниз');
  const chipClicked = await page.evaluate(() => { const c = document.querySelector('#mapChips .chip'); if (c) { c.click(); return true; } return false; });
  assert.ok(chipClicked, '3: тап по фильтр-чипу');
  await page.waitForTimeout(400);
  assert.equal(await scrollY(), yBeforeChip, '3: фильтр/поиск НЕ сбросил скролл вверх (скролл только при СВЕЖЕМ открытии)');
  console.log('✓ 3. ре-рендер карты по фильтру не дёргает страницу вверх (позиция сохранена)');

  // --- 4. событие → «на карте» тоже открывает карту сверху (координаты под рукой)
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 1000)); await page.waitForTimeout(150);
  // найти событие с кнопкой «на карте»
  const n = await page.evaluate(() => document.querySelectorAll('.event .event-main').length);
  let opened = false;
  for (let i = 0; i < n; i++) {
    await page.evaluate(idx => document.querySelectorAll('.event .event-main')[idx].click(), i);
    await page.waitForTimeout(140);
    if (await page.evaluate(() => !!document.querySelector('#sheet .geo-jump'))) { opened = true; break; }
    await page.click('#sheet .sheet-titlebar .icon-btn[data-close]'); await page.waitForTimeout(100);
  }
  assert.ok(opened, '4: нашли событие с кнопкой «на карте»');
  await page.click('#sheet .geo-jump'); await page.waitForTimeout(700);
  assert.equal(await scrollY(), 0, '4: событие→карта открыло карту сверху');
  assert.ok(await onScreen('#myCoordRow'), '4: координаты видны и при переходе с события');
  console.log('✓ 4. событие → «на карте» открывает карту сверху (координаты видны)');

  // --- 5. офлайн: карта из кэша тоже открывается сверху
  await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(700);
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 800)); await page.waitForTimeout(150);
  killSrv(); await page.waitForTimeout(300); // РЕАЛЬНЫЙ офлайн
  await openMap();
  assert.equal(await scrollY(), 0, '5: офлайн — карта открылась сверху');
  assert.ok(await onScreen('#myCoordRow'), '5: офлайн — координаты видны');
  console.log('✓ 5. офлайн: карта открывается сверху из кэша');

  await ctx.close(); await browser.close();
  killSrv();
  console.log('\n=== КАРТА ОТКРЫВАЕТСЯ СВЕРХУ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
