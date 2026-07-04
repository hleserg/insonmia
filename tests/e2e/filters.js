'use strict';
/* Фильтры по возрастному цензу и локации: модалка-воронка, мультивыбор,
   черновик с откатом, И-пересечение с днём, пустое состояние + сброс, память
   сессии (сброс на новом запуске), «рядом» = только ценз, развилка экспорта.
   Экспорт-часть работает и в браузерном режиме (share нет → скачивание). */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = 8155;
const BASE = `http://127.0.0.1:${PORT}`;
const T = Date.UTC(2026, 6, 10, 18, 0); // пт 10 июля, 21:00 МСК

// ожидаемые значения из данных (для точных проверок счётчиков)
const PROG = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'program.json'), 'utf8'));
const EVENTS = PROG.events;
const withStart = EVENTS.filter(e => e.startISO);
const N_ALL = withStart.length;
const N_18 = withStart.filter(e => (e.age || '').trim() === '18+').length;
const AGES = [...new Set(EVENTS.map(e => (e.age || '').trim()).filter(Boolean))];
const N_VENUES = new Set(EVENTS.map(e => (e.venue || '').trim()).filter(Boolean)).size;

// заведомо пустая пара (ценз, локация): такого сочетания в данных нет,
// но по отдельности значения существуют → гарантированное «Ничего не найдено»
const venueAges = {};
EVENTS.forEach(e => {
  const v = (e.venue || '').trim(), a = (e.age || '').trim();
  if (!v || !a) return;
  (venueAges[v] = venueAges[v] || new Set()).add(a);
});
let EMPTY_AGE = null, EMPTY_VENUE = null;
outer: for (const v of Object.keys(venueAges)) {
  for (const a of AGES) if (!venueAges[v].has(a)) { EMPTY_VENUE = v; EMPTY_AGE = a; break outer; }
}
assert.ok(EMPTY_VENUE && EMPTY_AGE, 'не нашли заведомо-пустую пару ценз+локация в данных');

const reExact = s => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC',
    serviceWorkers: 'block', acceptDownloads: true,
  });
  const page = await ctx.newPage();
  await page.clock.install({ time: T });
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);

  const chip = (host, label) => page.locator(host + ' .fchip', { hasText: reExact(label) });
  const visibleAges = () => page.$$eval('.event .age-pill', els => [...new Set(els.map(e => e.textContent.trim()))]);
  const eventCount = () => page.$$eval('.event', els => els.length);
  const dotHidden = () => page.$eval('#filterDot', el => el.classList.contains('hidden'));

  // --- 1. Воронка видна в «сейчас/программа/рядом», скрыта в «избранное/карта»
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(200);
  assert.ok(await page.isVisible('#btnFilter'), 'воронка видна в «программе»');
  await page.click('.tab[data-view="favorites"]');
  await page.waitForTimeout(150);
  assert.ok(!(await page.isVisible('#btnFilter')), 'воронка скрыта в «избранном»');
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(150);
  assert.ok(!(await page.isVisible('#btnFilter')), 'воронка скрыта на «карте»');
  await page.click('.tab[data-view="now"]');
  await page.waitForTimeout(150);
  assert.ok(await page.isVisible('#btnFilter'), 'воронка видна в «сейчас»');
  console.log('✓ 1. видимость воронки по разделам');

  // --- 2. Модалка: чипы из данных, всё выбрано по умолчанию, индикатор погашен
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(200);
  const baselineDay = await eventCount();
  assert.ok(baselineDay > 0, 'на выбранном дне есть события');
  assert.ok(await dotHidden(), 'по умолчанию индикатор активности погашен');
  await page.click('#btnFilter');
  await page.waitForTimeout(200);
  const ageChips = await page.$$eval('#filterAgeChips .fchip', els => els.map(e => e.textContent.trim()));
  const ageOn = await page.$$eval('#filterAgeChips .fchip.on', els => els.length);
  const venueChips = await page.$$eval('#filterVenueChips .fchip', els => els.length);
  const venueOn = await page.$$eval('#filterVenueChips .fchip.on', els => els.length);
  assert.equal(ageChips.length, AGES.length, `чипов ценза ${ageChips.length}, ждём ${AGES.length}`);
  assert.equal(ageOn, AGES.length, 'все чипы ценза выбраны по умолчанию');
  assert.equal(venueChips, N_VENUES, `чипов локации ${venueChips}, ждём ${N_VENUES}`);
  assert.equal(venueOn, N_VENUES, 'все чипы локации выбраны по умолчанию');
  assert.ok(!ageChips.includes('не указано'), 'в данных нет пустого ценза → чипа «не указано» нет');
  console.log(`✓ 2. модалка: ${ageChips.length} ценз + ${venueChips} локаций, всё выбрано`);

  // --- 2б. Контраст чипов ≥4.5:1 в ОБОИХ состояниях (выбран / не выбран)
  // включим один чип и выключим другой, замерим оба
  await chip('#filterVenueChips', EMPTY_VENUE).click(); // снимем один → не выбран
  await page.waitForTimeout(80);
  const contrast = await page.evaluate(() => {
    const lum = (r, g, b) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const parse = s => s.match(/\d+(\.\d+)?/g).map(Number);
    const ratio = (fg, bg) => { const a = lum(...fg) + 0.05, b = lum(...bg) + 0.05; return +(Math.max(a, b) / Math.min(a, b)).toFixed(2); };
    const measure = el => {
      const cs = getComputedStyle(el);
      let bg = parse(cs.backgroundColor);
      let node = el;
      while ((bg.length === 4 && bg[3] === 0) && node.parentElement) { node = node.parentElement; bg = parse(getComputedStyle(node).backgroundColor); }
      return ratio(parse(cs.color).slice(0, 3), bg.slice(0, 3));
    };
    const on = document.querySelector('#filterAgeChips .fchip.on');
    const off = document.querySelector('#filterVenueChips .fchip:not(.on)');
    return { on: measure(on), off: measure(off) };
  });
  assert.ok(contrast.on >= 4.5, `контраст выбранного чипа ${contrast.on} < 4.5`);
  assert.ok(contrast.off >= 4.5, `контраст невыбранного чипа ${contrast.off} < 4.5`);
  await chip('#filterVenueChips', EMPTY_VENUE).click(); // вернём как было
  await page.waitForTimeout(80);
  console.log(`✓ 2б. контраст чипов: выбран ${contrast.on}:1, не выбран ${contrast.off}:1 (≥4.5)`);

  // --- 3. Откат: снять все → Отмена → ничего не изменилось
  await page.click('#filterClear');
  await page.waitForTimeout(100);
  assert.equal(await page.$$eval('#filterAgeChips .fchip.on', e => e.length), 0, 'снять все обнулило ценз');
  await page.click('#filterSheet .icon-btn[data-close]');
  await page.waitForTimeout(200);
  assert.equal(await eventCount(), baselineDay, 'Отмена не должна применять черновик');
  assert.ok(await dotHidden(), 'после отмены индикатор погашен');
  console.log('✓ 3. черновик откатывается по «Отмена»');

  // --- 4. Фильтр ценза 18+: деселект остальных, применяем
  await page.click('#btnFilter');
  await page.waitForTimeout(150);
  for (const a of ageChips) if (a !== '18+') await chip('#filterAgeChips', a).click();
  await page.click('#filterApply');
  await page.waitForTimeout(250);
  assert.ok(!(await dotHidden()), 'после применения фильтра индикатор горит');
  const ages = await visibleAges();
  assert.ok(ages.length === 0 || (ages.length === 1 && ages[0] === '18+'),
    'видимы только 18+ (или пусто): ' + JSON.stringify(ages));
  console.log('✓ 4. ценз 18+: список сузился, индикатор активен');

  // --- 5. И-пересечение с днём: фильтр держится при смене дня
  const dayCount = await page.$$eval('.day-btn', b => b.length);
  let foundNonEmpty = false;
  for (let i = 0; i < dayCount; i++) {
    await page.click(`.day-btn >> nth=${i}`);
    await page.waitForTimeout(150);
    if ((await eventCount()) > 0) {
      foundNonEmpty = true;
      const a = await visibleAges();
      assert.ok(a.length === 1 && a[0] === '18+', `день ${i}: остались не только 18+: ` + JSON.stringify(a));
    }
  }
  assert.ok(foundNonEmpty, 'хотя бы один день имеет события 18+');
  assert.ok(!(await dotHidden()), 'фильтр пережил смену дня');
  console.log('✓ 5. фильтр держится при смене дня (И-пересечение)');

  // --- 6. Пустой результат → «Ничего не найдено» + сброс
  await page.click('#btnFilter');
  await page.waitForTimeout(150);
  await page.click('#filterClear');
  await page.waitForTimeout(100);
  await chip('#filterAgeChips', EMPTY_AGE).click();
  await chip('#filterVenueChips', EMPTY_VENUE).click();
  await page.click('#filterApply');
  await page.waitForTimeout(250);
  assert.equal(await eventCount(), 0, 'несовместимая пара → пусто');
  const emptyTxt = await page.$eval('#content', el => el.innerText);
  assert.ok(/Ничего не найдено/i.test(emptyTxt), 'ожидали «Ничего не найдено»: ' + emptyTxt.slice(0, 80));
  assert.ok(await page.$('.empty button'), 'есть кнопка сброса');
  await page.click('.empty button'); // Сбросить фильтры
  await page.waitForTimeout(200);
  assert.ok(await dotHidden(), 'после сброса индикатор погашен');
  assert.ok((await eventCount()) > 0, 'после сброса события вернулись');
  console.log('✓ 6. пустой результат → «Ничего не найдено» + сброс фильтров');

  // --- 7. Поиск НЕ применяет воронку (grep по всей программе)
  await page.click('#btnFilter');
  await page.waitForTimeout(150);
  for (const a of ageChips) if (a !== '18+') await chip('#filterAgeChips', a).click();
  await page.click('#filterApply');
  await page.waitForTimeout(200);
  await page.click('#btnSearch');
  await page.fill('#searchInput', 'очень странное'); // это НЕ 18+ спектакль
  await page.waitForTimeout(350);
  const found = await page.$eval('#content', el => el.innerText);
  assert.ok(found.includes('Очень странное место'), 'поиск должен игнорировать фильтр воронки (grep по всему)');
  console.log('✓ 7. поиск игнорирует воронку — grep находит вне фильтра');
  await page.click('#btnSearchClose');
  await page.waitForTimeout(200);

  // --- 8. Развилка экспорта: фильтр активен → две кнопки с верным N
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(150);
  await page.click('#btnProgramExport');
  await page.waitForTimeout(200);
  assert.ok(await page.isVisible('#programExportFiltered'), 'при активном фильтре есть кнопка «только отфильтрованные»');
  const filteredLabel = await page.$eval('#programExportFiltered', el => el.textContent);
  const allLabel = await page.$eval('#programExportGo', el => el.textContent);
  assert.ok(filteredLabel.includes(String(N_18)), `кнопка отфильтрованных должна показать ${N_18}: ` + filteredLabel);
  assert.ok(allLabel.includes(String(N_ALL)), `кнопка «всё» должна показать ${N_ALL}: ` + allLabel);
  console.log(`✓ 8. развилка экспорта: две кнопки, N=${N_18} / всё=${N_ALL}`);

  // --- 9. «Только отфильтрованные» → ровно N_18 VEVENT, без VALARM
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#programExportFiltered'),
  ]);
  const ics1 = fs.readFileSync(await dl.path(), 'utf8');
  const vevents = (ics1.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(vevents, N_18, `в .ics должно быть ${N_18} VEVENT, а вышло ${vevents}`);
  assert.ok(!ics1.includes('BEGIN:VALARM'), 'выгрузка программы без напоминаний (VALARM)');
  console.log(`✓ 9. отфильтрованный экспорт: ровно ${vevents} VEVENT, без VALARM`);

  // --- 10. Без фильтра — модалка как раньше (одна кнопка, всё)
  await page.click('#btnFilter');
  await page.waitForTimeout(150);
  await page.click('#filterSelectAll');
  await page.click('#filterApply');
  await page.waitForTimeout(200);
  assert.ok(await dotHidden(), 'после «выбрать все» фильтр неактивен');
  await page.click('#btnProgramExport');
  await page.waitForTimeout(200);
  assert.ok(!(await page.isVisible('#programExportFiltered')), 'без фильтра второй кнопки нет');
  const [dl2] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#programExportGo'),
  ]);
  const ics2 = fs.readFileSync(await dl2.path(), 'utf8');
  const ve2 = (ics2.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(ve2, N_ALL, `полная выгрузка = ${N_ALL} VEVENT, вышло ${ve2}`);
  console.log(`✓ 10. без фильтра — одна кнопка, полная выгрузка ${ve2}`);

  // --- 11. «Рядом»: модалка показывает только ценз (локация скрыта)
  await page.click('.tab[data-view="nearby"]');
  await page.waitForTimeout(200);
  await page.click('#btnFilter');
  await page.waitForTimeout(200);
  assert.ok(await page.isVisible('#filterAgeBlock'), 'в «рядом» ценз есть');
  assert.ok(!(await page.isVisible('#filterVenueBlock')), 'в «рядом» локация скрыта');
  await page.click('#filterSheet .icon-btn[data-close]');
  console.log('✓ 11. «рядом» → воронка только по цензу');

  // --- 12. Память сессии: перезагрузка сбрасывает фильтры к «всё»
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(150);
  await page.click('#btnFilter');
  await page.waitForTimeout(150);
  for (const a of ageChips) if (a !== '18+') await chip('#filterAgeChips', a).click();
  await page.click('#filterApply');
  await page.waitForTimeout(200);
  assert.ok(!(await dotHidden()), 'фильтр активен перед перезагрузкой');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(200);
  assert.ok(await dotHidden(), 'после перезагрузки фильтр сброшен к «всё» (в localStorage не храним)');
  const lsKeys = await page.evaluate(() => Object.keys(localStorage).filter(k => /filter/i.test(k)));
  assert.equal(lsKeys.length, 0, 'фильтры не пишутся в localStorage: ' + JSON.stringify(lsKeys));
  console.log('✓ 12. память сессии: перезагрузка сбрасывает фильтры, localStorage чист');

  await ctx.close(); await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  console.log('\n=== ФИЛЬТРЫ ЦЕНЗ/ЛОКАЦИЯ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
