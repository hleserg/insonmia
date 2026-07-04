'use strict';
/* Описание события всегда открывается СВЕРХУ, не наследует прокрутку прошлого
   (тот же #sheet переиспользуется — scrollTop .sheet-card залипал). Сброс на
   ОТКРЫТИИ, не на закрытии; скролл внутри и toggle ⭐ в описании не ломаются. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8172;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 420 }, timezoneId: 'UTC', serviceWorkers: 'block', // низкий вьюпорт → карточка описания скроллится
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true })); // для toggle ⭐
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(400);

  const openEvent = async (i) => { await page.evaluate(idx => document.querySelectorAll('.event .event-main')[idx].click(), i); await page.waitForTimeout(200); };
  const cardScroll = () => page.evaluate(() => document.querySelector('#sheet .sheet-card').scrollTop);
  const scrollableBy = () => page.evaluate(() => { const c = document.querySelector('#sheet .sheet-card'); return c.scrollHeight - c.clientHeight; });
  const setCardScroll = y => page.evaluate(v => { document.querySelector('#sheet .sheet-card').scrollTop = v; }, y);
  const closeSheet = async () => { await page.click('#sheet .sheet-titlebar .icon-btn[data-close]'); await page.waitForTimeout(200); };

  // найти ≥2 события с прокручиваемым описанием
  const scrollables = [];
  for (let i = 0; i < 30 && scrollables.length < 2; i++) {
    await openEvent(i);
    if ((await scrollableBy()) > 60) scrollables.push(i);
    await closeSheet();
  }
  assert.ok(scrollables.length >= 2, 'нашли ≥2 длинных (прокручиваемых) описания: ' + JSON.stringify(scrollables));
  const [A, B] = scrollables;

  // --- 1. длинное A → проскроллил вниз → закрыл → длинное B → открылось СВЕРХУ
  await openEvent(A); await setCardScroll(9999); await page.waitForTimeout(100);
  assert.ok((await cardScroll()) > 50, 'A проскроллено вниз: ' + (await cardScroll()));
  await closeSheet();
  await openEvent(B);
  assert.equal(await cardScroll(), 0, 'B открылось СВЕРХУ (не унаследовало скролл A)');
  console.log('✓ 1. другое длинное описание открывается сверху (не помнит позицию прошлого)');

  // --- 2. длинное → короткое → длинное: каждое сверху
  await setCardScroll(9999); await page.waitForTimeout(80); await closeSheet(); // прокрутили B и закрыли
  await openEvent(A);
  assert.equal(await cardScroll(), 0, 'A снова открылось сверху после прокрученного B');
  console.log('✓ 2. чередование длинных описаний — каждое сверху');

  // --- 3. проскроллил → закрыл → открыл ТО ЖЕ → сверху
  await setCardScroll(9999); await page.waitForTimeout(80); await closeSheet();
  await openEvent(A);
  assert.equal(await cardScroll(), 0, 'то же событие после прокрутки+закрытия открылось сверху');
  console.log('✓ 3. открыл-проскроллил-закрыл-открыл то же → сверху');

  // --- 4. скролл внутри работает, а toggle ⭐ в описании НЕ сбрасывает (сброс только на открытии)
  await setCardScroll(140); await page.waitForTimeout(80);
  assert.ok(Math.abs((await cardScroll()) - 140) < 6, 'прокрутка внутри описания работает');
  await page.click('#detailFav'); await page.waitForTimeout(200); // ⭐ → openDetail reopen уже открытой модалки
  assert.ok((await cardScroll()) > 60, 'toggle ⭐ в описании НЕ сбросил скролл наверх: ' + (await cardScroll()));
  console.log('✓ 4. скролл внутри работает, ⭐ в описании не сбрасывает (сброс только при открытии)');

  await ctx.close(); await browser.close();
  killSrv();
  console.log('\n=== ОПИСАНИЕ ОТКРЫВАЕТСЯ СВЕРХУ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
