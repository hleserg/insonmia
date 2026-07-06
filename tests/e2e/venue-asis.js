'use strict';
/* Площадка-плейсхолдер «тстцтсттсцтс» отображается ДОСЛОВНО (не «Сцена
   (уточняется)»), и кнопка «на карте» ведёт на одноимённую точку — мэтчинг
   событие↔карта сошёлся сам (оба «тстцтсттсцтс»). Работает офлайн. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = 8193;
const BASE = `http://127.0.0.1:${PORT}`;
const PROG = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'program.json'), 'utf8'));
const GEO = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'geo.json'), 'utf8'));
const PLACEHOLDER = 'тстцтсттсцтс';
// день фестиваля с событием на плейсхолдере + сама точка
const phEvent = PROG.events.filter(e => e.venue === PLACEHOLDER).sort((a, b) => a.startISO.localeCompare(b.startISO))[0];
const phPoint = GEO.points.find(p => /тстц/i.test(p.name));
const DAYS = [...new Set(PROG.events.map(e => e.date))].sort();
// момент — раньше всех событий, чтобы ничего не было «в прошлом» и карточки жили
const T = Date.UTC(2026, 6, 9, 5, 0);

(async () => {
  assert.ok(phEvent, 'в данных есть событие на «тстцтсттсцтс»');
  assert.ok(phPoint, 'в geo.json есть точка «Тстцтсттсцтс»');
  const { spawn } = require('child_process');
  let srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.clock.install({ time: T });
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);

  const goDay = async (day) => {
    await page.locator('#dayStrip .day-btn').nth(DAYS.indexOf(day)).click();
    await page.waitForTimeout(200);
  };

  // --- 1. Площадка отображается ДОСЛОВНО «тстцтсттсцтс», без «Сцена (уточняется)»
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(200);
  await goDay(phEvent.date);
  const card = page.locator(`.event[data-id="${phEvent.id}"]`);
  await card.waitFor({ timeout: 5000 });
  const venueText = await card.locator('.venue-pill').textContent();
  assert.ok(venueText.includes(PLACEHOLDER), '1: площадка показана дословно: ' + venueText);
  assert.ok(!/уточня/i.test(venueText), '1: НЕ должно быть выдуманного «Сцена (уточняется)»: ' + venueText);
  // и по всему экрану нигде нет подмены
  const bodyTxt = await page.evaluate(() => document.body.innerText);
  assert.ok(!/Сцена \(уточня/i.test(bodyTxt), '1: «Сцена (уточняется)» не встречается на экране');
  console.log('✓ 1. площадка «тстцтсттсцтс» — дословно, без переименования');

  // --- 2. Мэтчинг: описание → «на карте» ведёт на точку g011 (оба «тстцтсттсцтс»)
  await card.locator('.event-main').click();
  await page.waitForTimeout(300);
  assert.ok(await page.isVisible('#sheet'), 'описание открылось');
  const geoBtn = page.locator(`#sheet .geo-jump[data-gid="${phPoint.id}"]`);
  assert.equal(await geoBtn.count(), 1, `2: кнопка «на карте» ведёт на точку ${phPoint.id} (мэтчинг сошёлся)`);
  // проверим и напрямую движок мэтчинга
  const matched = await page.evaluate((v) => (typeof eventGeoPoints === 'function'
    ? eventGeoPoints({ venue: v }).map(p => p.id) : null), PLACEHOLDER);
  assert.deepEqual(matched, [phPoint.id], '2: eventGeoPoints(«тстцтсттсцтс») → [' + phPoint.id + ']');
  await geoBtn.click();
  await page.waitForTimeout(700);
  assert.ok(await page.evaluate(() => document.querySelector('.tab[data-view="map"]').classList.contains('active')), '2: «на карте» открыла карту');
  console.log('✓ 2. мэтчинг событие↔карта сошёлся: «на карте» → точка ' + phPoint.id);

  await ctx.close();

  // --- 3. Офлайн: площадка as-is и мэтчинг работают из SW-кэша
  const ctxOff = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC' });
  const pageOff = await ctxOff.newPage();
  await pageOff.clock.install({ time: T });
  pageOff.on('pageerror', e => { console.error('pageerror-off:', e.message); process.exitCode = 1; });
  await pageOff.goto(BASE + '/', { waitUntil: 'load' });
  await pageOff.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready; });
  await pageOff.waitForTimeout(1500);
  killSrv(); await pageOff.waitForTimeout(300);
  await pageOff.reload({ waitUntil: 'load' }).catch(() => {});
  await pageOff.waitForTimeout(700);
  await pageOff.click('.tab[data-view="schedule"]'); await pageOff.waitForTimeout(200);
  await pageOff.locator('#dayStrip .day-btn').nth(DAYS.indexOf(phEvent.date)).click();
  await pageOff.waitForTimeout(250);
  const vOff = await pageOff.locator(`.event[data-id="${phEvent.id}"] .venue-pill`).textContent();
  assert.ok(vOff.includes(PLACEHOLDER) && !/уточня/i.test(vOff), '3: офлайн — площадка дословно: ' + vOff);
  const matchedOff = await pageOff.evaluate((v) => eventGeoPoints({ venue: v }).map(p => p.id), PLACEHOLDER);
  assert.deepEqual(matchedOff, [phPoint.id], '3: офлайн — мэтчинг сходится');
  console.log('✓ 3. офлайн: площадка as-is + мэтчинг из SW-кэша');
  await ctxOff.close();

  await browser.close();
  killSrv();
  console.log('\n=== ПЛОЩАДКА AS-IS: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
