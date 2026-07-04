'use strict';
/* Экспорт в календарь: share-путь (мок), скачивание, ОФЛАЙН-генерация,
   пустое избранное. Требует standalone (иначе ⭐ открывает install-гейт). */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8135;
const BASE = `http://127.0.0.1:${PORT}`;
const T = Date.UTC(2026, 6, 10, 18, 0); // пт 10 июля, 21:00 МСК

const STANDALONE = () => {
  Object.defineProperty(navigator, 'standalone', { get: () => true });
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => (q.includes('standalone') ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } : mm(q));
};

// мок Web Share с файлами: сохраняем имя/тип/содержимое переданного файла
const SHARE_MOCK = () => {
  window.__share = null;
  navigator.canShare = (d) => !!(d && d.files && d.files.length);
  navigator.share = async (d) => {
    const f = d.files && d.files[0];
    window.__share = { title: d.title, name: f && f.name, type: f && f.type, text: f ? await f.text() : null };
  };
};

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  let srvAlive = true;
  const killSrv = () => { if (srvAlive) { try { srv.kill('SIGKILL'); } catch {} srvAlive = false; } };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC',
    acceptDownloads: true,
  });
  await ctx.addInitScript(STANDALONE);
  await ctx.addInitScript(SHARE_MOCK);
  const page = await ctx.newPage();
  await page.clock.install({ time: T });
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(700);

  // дождаться, что SW реально закэшировал шелл (для офлайн-части)
  await page.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready; });
  for (let i = 0; i < 30; i++) {
    const have = await page.evaluate(async () => {
      const ks = await caches.keys();
      if (!ks.length) return 0;
      const c = await caches.open(ks[0]);
      return (await c.keys()).length;
    });
    if (have >= 15) break;
    await page.waitForTimeout(300);
  }

  // добавить 2 события в избранное (standalone → сохраняется).
  // toggleFav перерисовывает список → кликаем свежими локаторами по очереди
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(400);
  assert.ok((await page.$$('.fav-btn')).length >= 2, 'на дне должно быть ≥2 события');
  await page.click('.event:nth-of-type(1) .fav-btn');
  await page.waitForTimeout(200);
  await page.click('.event:not(.is-past) .fav-btn:not(.on) >> nth=0'); // второе, ещё не отмеченное
  await page.waitForTimeout(200);
  const favCount = await page.evaluate(() => JSON.parse(localStorage.getItem('insomnia.favs') || '[]').length);
  assert.equal(favCount, 2, 'должно быть ровно 2 избранных, а не ' + favCount);

  // --- 1. Детали события: кнопки есть, 📅 вызывает share с .ics-файлом ---
  await page.click('.event-main >> nth=0');
  await page.waitForTimeout(300);
  assert.ok(await page.isVisible('#detailCal'), 'кнопка «в календарь» есть в деталях');
  assert.ok(await page.isVisible('#detailIcs'), 'кнопка «скачать .ics» есть');
  await page.click('#detailCal');
  await page.waitForTimeout(200);
  const shared = await page.evaluate(() => window.__share);
  assert.ok(shared, '📅 должна вызвать navigator.share');
  assert.match(shared.name, /^insomnia-.+\.ics$/, 'имя файла латиницей .ics: ' + shared.name);
  assert.equal(shared.type, 'text/calendar', 'MIME text/calendar');
  assert.ok(/BEGIN:VCALENDAR[\s\S]*BEGIN:VEVENT[\s\S]*DTSTART:\d{8}T\d{6}Z[\s\S]*BEGIN:VALARM[\s\S]*END:VCALENDAR/.test(shared.text), 'валидный VCALENDAR с VEVENT/VALARM');
  console.log('✓ 📅 share: файл', shared.name, '—', shared.text.match(/BEGIN:VEVENT/g).length, 'VEVENT');

  // --- 2. ⬇️ .ics — принудительное скачивание, читаем содержимое ---
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#detailIcs'),
  ]);
  const p1 = path.join(os.tmpdir(), 'ics-one-' + Date.now() + '.ics');
  await dl.saveAs(p1);
  const one = fs.readFileSync(p1, 'utf8');
  assert.match(dl.suggestedFilename(), /^insomnia-.+\.ics$/, 'имя скачанного файла');
  assert.ok(one.includes('BEGIN:VCALENDAR') && one.includes('BEGIN:VEVENT'), 'скачанный ICS валиден');
  assert.ok(one.includes('\r\n'), 'CRLF в файле');
  // после скачивания — подсказка «откройте файл»
  const dlToast = (await page.evaluate(() => document.querySelector('#toast')?.textContent || '')).trim();
  assert.ok(/скачан[\s\S]*календарь/i.test(dlToast), 'тост-подсказка после скачивания: ' + JSON.stringify(dlToast));
  console.log('✓ ⬇️ download: файл', dl.suggestedFilename(), '+ подсказка-тост');
  // по умолчанию (lead=15) — VALARM за 15 мин
  assert.ok(one.includes('TRIGGER:-PT15M'), 'по умолчанию напоминание за 15 мин');
  await page.click('#sheet .icon-btn[data-close]');
  await page.waitForTimeout(200);

  // --- 2b. VALARM отражает ВЫБРАННОЕ в настройках время (сквозная проводка) ---
  await page.click('#btnSettings');
  await page.waitForTimeout(200);
  await page.selectOption('#leadSelect', '30');
  await page.waitForTimeout(150);
  await page.click('#settings .icon-btn[data-close]');
  await page.waitForTimeout(150);
  await page.click('.event-main >> nth=0');
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__share = null; });
  await page.click('#detailCal');
  await page.waitForTimeout(150);
  const lead30 = await page.evaluate(() => window.__share);
  assert.ok(lead30 && lead30.text.includes('TRIGGER:-PT30M'), 'VALARM берёт выбранные 30 мин: ' + (lead30 && (lead30.text.match(/TRIGGER:[^\r\n]*/) || '')));
  console.log('✓ VALARM = выбранное время (30 мин)');
  await page.click('#sheet .icon-btn[data-close]');
  await page.waitForTimeout(200);

  // --- 3. Избранное: «весь маршрут» — один файл с 2 VEVENT ---
  await page.click('.tab[data-view="favorites"]');
  await page.waitForTimeout(400);
  assert.ok(await page.isVisible('#routeCal'), 'кнопка «весь маршрут в календарь»');
  const routeShared = await (async () => {
    await page.evaluate(() => { window.__share = null; });
    await page.click('#routeCal');
    await page.waitForTimeout(200);
    return page.evaluate(() => window.__share);
  })();
  assert.ok(routeShared && routeShared.name === 'insomnia-favorites.ics', 'общий файл insomnia-favorites.ics');
  const vevents = (routeShared.text.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(vevents, 2, 'два избранных → 2 VEVENT в одном файле');
  assert.equal((routeShared.text.match(/BEGIN:VCALENDAR/g) || []).length, 1, 'один VCALENDAR');
  console.log('✓ маршрут: один файл,', vevents, 'VEVENT');

  // --- 4. ОФЛАЙН: убиваем сервер, генерация и скачивание всё равно работают ---
  killSrv();
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'load' }); // из SW-кэша
  await page.waitForTimeout(600);
  await page.click('.tab[data-view="favorites"]');
  await page.waitForTimeout(400);
  const [dl2] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#routeIcs'),
  ]);
  const p2 = path.join(os.tmpdir(), 'ics-offline-' + Date.now() + '.ics');
  await dl2.saveAs(p2);
  const off = fs.readFileSync(p2, 'utf8');
  assert.equal((off.match(/BEGIN:VEVENT/g) || []).length, 2, 'офлайн: 2 VEVENT в файле');
  console.log('✓ офлайн-генерация и скачивание работают (сервер убит)');

  // --- 5. Пустое избранное (свежий контекст) → кнопки неактивны ---
  const ctx2 = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC' });
  await ctx2.addInitScript(STANDALONE);
  const p3 = await ctx2.newPage();
  await p3.clock.install({ time: T });
  // сервер уже убит — грузим через отдельный краткоживущий сервер
  const srv2 = spawn('python3', ['-m', 'http.server', '8136'], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  await p3.goto('http://127.0.0.1:8136/', { waitUntil: 'load' });
  await p3.waitForTimeout(500);
  await p3.click('.tab[data-view="favorites"]');
  await p3.waitForTimeout(300);
  const disabled = await p3.evaluate(() => {
    const b = document.querySelector('#routeCal');
    return b ? b.disabled : null;
  });
  assert.equal(disabled, true, 'при пустом избранном «в календарь» неактивна');
  const hint = await p3.getAttribute('#routeCal', 'title');
  assert.ok(hint && /избранное/i.test(hint), 'есть подсказка почему неактивна');
  console.log('✓ пустое избранное: кнопка неактивна с подсказкой');
  try { srv2.kill('SIGKILL'); } catch {}

  await ctx.close(); await ctx2.close(); await browser.close();
  console.log('\n=== ЭКСПОРТ В КАЛЕНДАРЬ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
