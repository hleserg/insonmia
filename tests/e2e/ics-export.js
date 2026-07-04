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
    // msg — текст сообщения (🔗 «поделиться»); text — содержимое .ics-файла
    window.__share = { title: d.title, msg: d.text || null, name: f && f.name, type: f && f.type, text: f ? await f.text() : null };
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
  await page.locator('.event').first().locator('.fav-btn').click();
  await page.waitForTimeout(200);
  await page.click('.event .fav-btn:not(.on) >> nth=0'); // второе, ещё не отмеченное
  await page.waitForTimeout(200);
  const favCount = await page.evaluate(() => JSON.parse(localStorage.getItem('insomnia.favs') || '[]').length);
  assert.equal(favCount, 2, 'должно быть ровно 2 избранных, а не ' + favCount);

  // --- 1. Детали события: кнопки есть, 📅 вызывает share с .ics-файлом ---
  await page.click('.event-main >> nth=0');
  await page.waitForTimeout(300);
  assert.ok(await page.isVisible('#detailCal'), 'кнопка «в календарь» есть в деталях');
  assert.ok(await page.isVisible('#detailShare'), 'кнопка «поделиться» есть');
  assert.ok(await page.isVisible('#detailIcs'), 'кнопка «скачать .ics» есть');
  await page.click('#detailCal');
  await page.waitForTimeout(200);
  const shared = await page.evaluate(() => window.__share);
  assert.ok(shared, '📅 должна вызвать navigator.share');
  assert.match(shared.name, /^insomnia-.+\.ics$/, 'имя файла латиницей .ics: ' + shared.name);
  assert.equal(shared.type, 'text/calendar', 'MIME text/calendar');
  assert.ok(/BEGIN:VCALENDAR[\s\S]*BEGIN:VEVENT[\s\S]*DTSTART:\d{8}T\d{6}Z[\s\S]*BEGIN:VALARM[\s\S]*END:VCALENDAR/.test(shared.text), 'валидный VCALENDAR с VEVENT/VALARM');
  assert.equal(shared.msg, null, '📅 «в календарь» — без текста сообщения (только файл)');
  console.log('✓ 📅 share: файл', shared.name, '—', shared.text.match(/BEGIN:VEVENT/g).length, 'VEVENT');

  // --- 1b. 🔗 «поделиться»: текст самодостаточен + файл ---
  await page.evaluate(() => { window.__share = null; });
  await page.click('#detailShare');
  await page.waitForTimeout(200);
  const shareLink = await page.evaluate(() => window.__share);
  assert.ok(shareLink && shareLink.msg, '🔗 должна передать текст сообщения');
  assert.ok(/МСК/.test(shareLink.msg) && /Бессонница 2026/.test(shareLink.msg), 'текст самодостаточен (дата/МСК/фест): ' + JSON.stringify(shareLink.msg));
  assert.ok(shareLink.text && shareLink.text.includes('BEGIN:VEVENT'), '🔗 прикладывает и .ics-файл');
  console.log('✓ 🔗 share: текст +', shareLink.name);

  // 🔗 текст ночного события содержит пометку «ночь на …» (как в карточке)
  const nightMsg = await page.evaluate(() => {
    const e = state.program.events.find(x => window.InsomniaCore.nightInfo(x));
    return e ? eventShareText(e) : null;
  });
  assert.ok(nightMsg && /ночь на/i.test(nightMsg), 'ночное событие: текст шэра с пометкой «ночь на …»: ' + JSON.stringify(nightMsg));
  console.log('✓ 🔗 ночное событие помечено в тексте');

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
  // избранное СОХРАНЯЕТ VALARM (флаг withAlarm не сломал осознанный выбор)
  assert.equal((routeShared.text.match(/BEGIN:VALARM/g) || []).length, 2, 'у избранного напоминания на месте');
  console.log('✓ маршрут: один файл,', vevents, 'VEVENT, VALARM на месте');

  // --- 3a. 🔗 «поделиться маршрутом»: текст-список + .ics с VALARM ---
  assert.ok(await page.isVisible('#routeShare'), 'кнопка «поделиться маршрутом» есть');
  await page.evaluate(() => { window.__share = null; });
  await page.click('#routeShare');
  await page.waitForTimeout(200);
  const routeMsg = await page.evaluate(() => window.__share);
  assert.ok(routeMsg && routeMsg.msg, '🔗 маршрут: есть текст-сообщение');
  assert.ok(/Мой маршрут на Бессоннице/.test(routeMsg.msg), 'заголовок списка');
  assert.ok(/Сгенерено в приложении/.test(routeMsg.msg), 'подпись в конце');
  assert.equal((routeMsg.text.match(/BEGIN:VEVENT/g) || []).length, 2, '🔗 приложен .ics избранного (2 VEVENT)');
  assert.equal((routeMsg.text.match(/BEGIN:VALARM/g) || []).length, 2, '🔗 маршрут: VALARM сохранён');
  console.log('✓ 🔗 маршрут: текст-список + .ics с напоминаниями');

  // группировка по фест-дням + ночная пометка (крафтовый набор через routeShareText)
  const routeText = await page.evaluate(() => {
    const C = window.InsomniaCore;
    const mk = (iso, title, venue) => { const ms = C.epochFromISO(iso); return { _startMs: ms, _festDay: C.getFestivalDay(ms), start: iso.slice(11, 16), title, venue }; };
    return routeShareText([
      mk('2026-07-10T19:00', 'Открытие', 'Главная'),
      mk('2026-07-10T22:00', 'Ночной показ', 'Экран 1'),
      mk('2026-07-11T02:00', 'Полночный джаз', 'Чайка'), // 02:00 сб → фест-день пятницы
      mk('2026-07-11T17:00', 'Карнавал', 'Сбор у Чайки'),
    ]);
  });
  assert.ok(/Пт 10\.07[\s\S]*Сб 11\.07/.test(routeText), 'дни сгруппированы и по порядку: ' + JSON.stringify(routeText));
  // 02:00-событие идёт в блоке пятницы (до заголовка субботы) и помечено 🌙
  const idxNight = routeText.indexOf('Полночный джаз');
  const idxSat = routeText.indexOf('Сб 11.07');
  assert.ok(idxNight > 0 && idxNight < idxSat, 'ночное 02:00 под фест-днём пятницы, не субботы');
  assert.ok(/• 02:00 🌙 Полночный джаз/.test(routeText), 'ночное событие помечено 🌙: ' + JSON.stringify(routeText));
  assert.ok(/• 19:00 Открытие — Главная/.test(routeText), 'строка события: время, название, площадка');
  console.log('✓ 🔗 маршрут: группировка по дням + ночная пометка');

  // --- 3b. ВСЯ ПРОГРАММА: модалка-предупреждение, Отмена, затем выгрузка без VALARM ---
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(400);
  assert.ok(await page.isVisible('#btnProgramExport'), 'кнопка «вся программа в календарь» в разделе Программа');
  await page.click('#btnProgramExport');
  await page.waitForTimeout(250);
  assert.ok(await page.isVisible('#programExport'), 'по тапу — модалка-предупреждение (не сразу выгрузка)');
  const warnTxt = (await page.evaluate(() => document.querySelector('#programExport .sheet-body').innerText)).toLowerCase();
  assert.ok(/напоминани[ея].*не будут|не будут включены/.test(warnTxt), 'предупреждение: напоминаний не будет');
  assert.ok(/не обнов|разовый снимок/.test(warnTxt), 'предупреждение: разовый снимок');
  // [Отмена] реально отменяет — модалка закрыта, ничего не выгружено
  await page.evaluate(() => { window.__share = null; });
  await page.click('#programExport .btn.ghost[data-close]');
  await page.waitForTimeout(200);
  assert.ok(!(await page.isVisible('#programExport')), '[Отмена] закрывает модалку');
  assert.equal(await page.evaluate(() => window.__share), null, '[Отмена] ничего не выгружает');
  console.log('✓ модалка: оба предупреждения, [Отмена] отменяет');
  // подтверждаем → полный ICS без VALARM
  await page.click('#btnProgramExport');
  await page.waitForTimeout(200);
  await page.click('#programExportGo');
  await page.waitForTimeout(400);
  const full = await page.evaluate(() => window.__share);
  assert.ok(full && full.name === 'insomnia-full-program.ics', 'файл insomnia-full-program.ics: ' + (full && full.name));
  const fullN = (full.text.match(/BEGIN:VEVENT/g) || []).length;
  assert.ok(fullN > 600, 'вся программа: 600+ VEVENT (получили ' + fullN + ')');
  assert.equal((full.text.match(/BEGIN:VALARM/g) || []).length, 0, 'вся программа — НИ ОДНОГО VALARM');
  assert.equal((full.text.match(/BEGIN:VCALENDAR/g) || []).length, 1, 'один VCALENDAR');
  assert.ok(!(await page.isVisible('#programExport')), 'после выгрузки модалка закрыта');
  console.log('✓ вся программа:', fullN, 'VEVENT, 0 VALARM, один файл');

  // --- 3c. Диагностика Web Share: панель показывает значения API ---
  await page.click('#btnSettings');
  await page.waitForTimeout(200);
  await page.click('#btnShareDiag');
  await page.waitForTimeout(300);
  assert.ok(await page.isVisible('#diagPanel'), 'диаг-панель появилась');
  const diagTxt = await page.evaluate(() => document.querySelector('#diagPanel pre').textContent);
  assert.ok(/typeof navigator\.share:/.test(diagTxt) && /canShare\(\{files\}\):/.test(diagTxt), 'панель содержит ключевые значения: ' + JSON.stringify(diagTxt.slice(0, 120)));
  await page.click('#diagPanel .btn'); // закрыть (или скопировать) — панель есть
  await page.waitForTimeout(100);
  await page.evaluate(() => { const p = document.getElementById('diagPanel'); if (p) p.remove(); });
  await page.click('#settings .icon-btn[data-close]');
  await page.waitForTimeout(150);
  console.log('✓ диагностика: панель со значениями Web Share');

  // --- 3d. Фолбэк БЕЗ navigator.share → скачивание + внятный тост (не немой) ---
  {
    const ctxN = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block', acceptDownloads: true });
    await ctxN.addInitScript(STANDALONE);
    await ctxN.addInitScript(() => { try { delete navigator.share; } catch {}; try { delete navigator.canShare; } catch {}; Object.defineProperty(navigator, 'share', { get: () => undefined, configurable: true }); });
    const pN = await ctxN.newPage();
    await pN.clock.install({ time: T });
    await pN.goto(BASE + '/', { waitUntil: 'load' });
    await pN.waitForTimeout(500);
    await pN.click('.tab[data-view="schedule"]');
    await pN.waitForTimeout(300);
    await pN.locator('.event').first().locator('.fav-btn').click();
    await pN.waitForTimeout(150);
    await pN.click('.tab[data-view="favorites"]');
    await pN.waitForTimeout(300);
    const [dlN] = await Promise.all([
      pN.waitForEvent('download'),
      pN.click('#routeShare'),
    ]);
    await dlN.saveAs(path.join(os.tmpdir(), 'ics-noshare-' + Date.now() + '.ics'));
    await pN.waitForTimeout(200);
    const noShareToast = (await pN.evaluate(() => document.querySelector('#toast')?.textContent || '')).trim();
    assert.ok(/недоступн/i.test(noShareToast) && /(буфер|скопирован|скачан)/i.test(noShareToast), 'фолбэк без share — внятный тост, не немой: ' + JSON.stringify(noShareToast));
    console.log('✓ фолбэк без Web Share: скачивание +', JSON.stringify(noShareToast.slice(0, 60)));
    await ctxN.close();
  }
  // сервер ещё жив — офлайн-часть ниже сама его убьёт

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
  const disabled = await p3.evaluate(() => ({
    cal: document.querySelector('#routeCal')?.disabled,
    share: document.querySelector('#routeShare')?.disabled,
    ics: document.querySelector('#routeIcs')?.disabled,
  }));
  assert.equal(disabled.cal, true, 'при пустом избранном «в календарь» неактивна');
  assert.equal(disabled.share, true, 'при пустом избранном «поделиться маршрутом» неактивна');
  assert.equal(disabled.ics, true, 'при пустом избранном скачивание неактивно');
  const hint = await p3.getAttribute('#routeShare', 'title');
  assert.ok(hint && /избранное/i.test(hint), 'есть подсказка почему неактивна');
  console.log('✓ пустое избранное: все три кнопки неактивны с подсказкой');
  try { srv2.kill('SIGKILL'); } catch {}

  await ctx.close(); await ctx2.close(); await browser.close();
  console.log('\n=== ЭКСПОРТ В КАЛЕНДАРЬ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
