'use strict';
/* Сквозной поиск: один запрос шарится между вкладками и применяется к данным
   каждой (события / метки / радиус); фильтрует «Избранное»; пустой результат
   объясняет причину и даёт «Очистить»; крестик чистит на всех вкладках;
   «избранное пусто» ≠ «не найдено по запросу»; всё офлайн. Требует standalone
   (иначе ⭐ открывает install-гейт). */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = 8161;
const BASE = `http://127.0.0.1:${PORT}`;
const T = Date.UTC(2026, 6, 10, 12, 0); // пт 10 июля, 15:00 МСК

const STANDALONE = () => {
  Object.defineProperty(navigator, 'standalone', { get: () => true });
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => (q.includes('standalone') ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } : mm(q));
};

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
  await ctx.addInitScript(STANDALONE);
  const page = await ctx.newPage();
  const external = [];
  page.on('request', r => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname)) external.push(r.url()); });
  await page.clock.install({ time: T });
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(700);

  const type = async (q) => { await page.fill('#searchInput', q); await page.waitForTimeout(400); };
  const inputVal = () => page.$eval('#searchInput', el => el.value);
  const contentTxt = () => page.$eval('#content', el => el.innerText);
  const titlesShown = () => page.$$eval('.event .event-title', els => els.map(e => e.textContent.trim()));

  // --- Готовим избранное: отметим два события с РАЗНЫМИ названиями в «программе»
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(300);
  const dayTitles = await titlesShown();
  assert.ok(dayTitles.length >= 2, 'на дне есть события для теста');
  // берём два события с различающимися названиями
  let i0 = 0, i1 = dayTitles.findIndex((t, i) => i > 0 && t !== dayTitles[0]);
  assert.ok(i1 > 0, 'нашли два события с разными названиями');
  const t0 = dayTitles[i0], t1 = dayTitles[i1];
  // отличительное слово из t0, которого нет в t1
  const distinct = t0.toLowerCase().replace(/ё/g, 'е').split(/[^а-яa-z0-9]+/i)
    .find(w => w.length > 3 && !t1.toLowerCase().replace(/ё/g, 'е').includes(w));
  assert.ok(distinct, 'нашли отличительное слово: ' + JSON.stringify([t0, t1]));
  await page.$$eval('.event', (els, [a, b]) => {
    els.forEach(el => {
      const t = el.querySelector('.event-title').textContent.trim();
      if (t === a || t === b) el.querySelector('.fav-btn').click();
    });
  }, [t0, t1]);
  await page.waitForTimeout(300);
  const favBadge = await page.$eval('#favBadge', el => +el.textContent);
  assert.ok(favBadge >= 2, 'два события в избранном: ' + favBadge);
  console.log(`✓ подготовка: отмечено ${favBadge} события (${JSON.stringify([t0, t1])})`);

  // --- 1. Избранное фильтруется по запросу (только совпавшие)
  await page.click('.tab[data-view="favorites"]');
  await page.waitForTimeout(200);
  await page.click('#btnSearch');
  await type(distinct);
  let shown = await titlesShown();
  assert.ok(shown.includes(t0) && !shown.includes(t1), `в избранном по «${distinct}» виден только t0: ` + JSON.stringify(shown));
  console.log('✓ 1. поиск фильтрует «Избранное» по запросу');

  // --- 7. «не найдено по запросу» ≠ «избранное пусто»
  await type('zzzнеттакого');
  let txt = await contentTxt();
  assert.ok(/в избранном ничего не найдено/i.test(txt), 'сообщение про запрос, не про пустое избранное: ' + txt.slice(0, 90));
  assert.ok(await page.$('.empty button'), 'есть «Очистить поиск»');
  console.log('✓ 7. «не найдено по запросу» — отдельное сообщение с «Очистить»');

  // --- 2. Сквозная персистентность: запрос виден и применён на другой вкладке
  await type(distinct);
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(300);
  assert.equal(await inputVal(), distinct, 'запрос виден в поле после перехода на другую вкладку');
  shown = await titlesShown();
  assert.ok(shown.includes(t0), 'программа применила общий запрос');
  console.log('✓ 2. запрос сохраняется между вкладками и применяется к данным вкладки');

  // --- 3. Карта фильтрует метки по общему запросу
  await type('туалет');
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(1200);
  const mapCounts = await page.evaluate(() => ({
    shown: GEO.clusterGroup ? GEO.clusterGroup.getLayers().length : -1,
    total: Object.keys(GEO.pointById).length,
  }));
  assert.ok(mapCounts.shown > 0 && mapCounts.shown < mapCounts.total, `карта сузилась по «туалет»: ${mapCounts.shown}/${mapCounts.total}`);
  const wcOnly = await page.evaluate(() => {
    const shown = new Set(GEO.clusterGroup.getLayers());
    return Object.values(GEO.pointById).filter(r => shown.has(r.marker)).every(r => r.point.category === 'wc');
  });
  assert.ok(wcOnly, 'на карте по «туалет» показаны только туалеты');
  console.log(`✓ 3. карта фильтрует метки по общему запросу (${mapCounts.shown}/${mapCounts.total}, только 🚻)`);

  // --- 4. Ноль результатов на карте → строка «ничего не найдено»
  await type('ффыва');
  await page.waitForTimeout(300);
  const mapStatus = await page.$eval('#mapStatus', el => el.textContent);
  const mapShown = await page.evaluate(() => GEO.clusterGroup.getLayers().length + (GEO.searchLayers || []).length);
  assert.equal(mapShown, 0, 'на карте нет совпадений');
  assert.ok(/ничего не найдено/i.test(mapStatus), 'карта объясняет пустой результат: ' + mapStatus);
  console.log('✓ 4. пустой результат на карте — строка «ничего не найдено»');

  // --- 5. Крестик очистки сбрасывает запрос на всех вкладках
  await page.click('#btnSearchClose');
  await page.waitForTimeout(300);
  assert.equal(await inputVal(), '', 'поле очищено');
  const mapBack = await page.evaluate(() => GEO.clusterGroup.getLayers().length);
  assert.ok(mapBack > 0, 'после очистки метки вернулись');
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(200);
  assert.equal(await inputVal(), '', 'на другой вкладке запрос тоже пуст');
  assert.ok((await titlesShown()).length > 1, 'программа снова показывает всё');
  console.log('✓ 5. крестик чистит запрос на всех вкладках сразу');

  // --- 6. Поиск ∧ фильтр-воронка (И) в связке со сквозным запросом
  await page.click('#btnSearch');
  await type(distinct);
  const withQuery = (await titlesShown()).length;
  await clickFunnel(page);
  await page.waitForTimeout(150);
  // снимем все возрасты кроме одного заведомо не совпадающего с t0 — грубо:
  // просто снимем все → пусто (И с поиском)
  await page.click('#ageClear');
  await page.click('#filterApply');
  await page.waitForTimeout(300);
  txt = await contentTxt();
  assert.ok(/ничего не найдено по запросу/i.test(txt) || (await titlesShown()).length < withQuery,
    'воронка сужает результат поиска (И)');
  console.log('✓ 6. поиск ∧ воронка = пересечение');

  // --- 9. Длинный слитный запрос не рвёт ширину на 360px (overflow-wrap)
  await page.click('#btnSearchClose');
  await page.click('.tab[data-view="schedule"]');
  await page.click('#btnSearch');
  await type('фывапролджэ' + 'ячсмить'.repeat(4)); // ~40 символов без пробелов
  const oflowSched = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(900);
  const oflowMap = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(oflowSched <= 1, 'длинный запрос не даёт гор. overflow в списке: ' + oflowSched);
  assert.ok(oflowMap <= 1, 'длинный запрос не даёт гор. overflow на карте: ' + oflowMap);
  console.log('✓ 9. длинный слитный запрос не рвёт ширину (360px)');
  await page.click('#btnSearchClose');

  // --- 12. РЕГРЕСС (баг с поля): активный поиск на «Программе» НЕ калечит вкладку.
  //  Остаточный запрос делал полосу дней disabled (серой) и ранним return прятал
  //  кнопку «вся программа в календарь» → «дни сломались, выгрузка пропала».
  //  Теперь: кнопка выгрузки на месте, дни кликабельны (без активного — выдача по
  //  всем дням), тап по дню = выход из поиска на этот день.
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(200);
  // сценарий 6 снял все возрасты в воронке — вернём чистое состояние (иначе поиск пуст)
  await page.evaluate(() => { resetFiltersToAll(); render(); });
  await page.waitForTimeout(200);
  const schedBase = await page.evaluate(() => ({
    exp: !!document.querySelector('#btnProgramExport'),
    disabled: [...document.querySelectorAll('#dayStrip .day-btn')].filter(b => b.disabled).length,
  }));
  assert.ok(schedBase.exp, '12: без поиска кнопка «вся программа» видна');
  assert.equal(schedBase.disabled, 0, '12: без поиска дни кликабельны');
  await page.click('#btnSearch');
  await type(distinct);
  const schedSearch = await page.evaluate(() => {
    const days = [...document.querySelectorAll('#dayStrip .day-btn')];
    return {
      exp: !!document.querySelector('#btnProgramExport'),
      disabled: days.filter(b => b.disabled).length,
      active: days.filter(b => b.classList.contains('active')).length,
      groups: document.querySelectorAll('.time-group-label').length,
    };
  });
  assert.ok(schedSearch.exp, '12: ПРИ ПОИСКЕ кнопка «вся программа» ОСТАЁТСЯ (не прячется)');
  assert.equal(schedSearch.disabled, 0, '12: ПРИ ПОИСКЕ дни НЕ disabled (полоса не «мёртвая»)');
  assert.equal(schedSearch.active, 0, '12: при поиске ни один день не подсвечен (выдача по всем дням)');
  assert.ok(schedSearch.groups >= 1, '12: выдача поиска сгруппирована по дню (есть заголовок даты)');
  // тап по дню во время поиска → выходим из поиска на ЭТОТ день
  await page.evaluate(() => document.querySelectorAll('#dayStrip .day-btn')[2].click());
  await page.waitForTimeout(300);
  const afterDayTap = await page.evaluate(() => ({
    q: state.query,
    barHidden: document.querySelector('#searchBar').classList.contains('hidden'),
    active: (document.querySelector('#dayStrip .day-btn.active') || {}).textContent || '',
    exp: !!document.querySelector('#btnProgramExport'),
  }));
  assert.equal(afterDayTap.q, '', '12: тап по дню при поиске сбросил запрос');
  assert.ok(afterDayTap.barHidden, '12: строка поиска скрылась после тапа по дню');
  assert.ok(afterDayTap.active, '12: выбранный день подсвечен: ' + afterDayTap.active);
  assert.ok(afterDayTap.exp, '12: кнопка «вся программа» на месте после выхода из поиска');
  console.log('✓ 12. поиск не калечит «Программу»: дни живые, выгрузка на месте, тап по дню = выход из поиска');

  // --- 8. Офлайн: ни одного внешнего запроса за весь сценарий
  assert.equal(external.length, 0, 'внешних запросов не было (офлайн): ' + JSON.stringify(external.slice(0, 3)));
  console.log('✓ 8. всё офлайн — ноль внешних запросов');
  await ctx.close();

  // === фиксы verify: осиротевшее избранное + фантом метки на карте ===
  const ctx2 = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
  await ctx2.addInitScript(STANDALONE);
  await ctx2.addInitScript(() => {
    localStorage.setItem('insomnia.favs', JSON.stringify(['deadfav0']));  // id, которого нет в программе
    localStorage.setItem('insomnia.pins', JSON.stringify([{ lat: 54.68025, lng: 35.08971, name: 'zzмояметкаzz', emoji: '⛺' }]));
  });
  const p2 = await ctx2.newPage();
  await p2.clock.install({ time: T });
  p2.on('pageerror', e => { console.error('pageerror2:', e.message); process.exitCode = 1; });
  await p2.goto(BASE + '/', { waitUntil: 'load' });
  await p2.waitForTimeout(700);

  // --- 10. Всё избранное осиротело + активен поиск → плашка-сирота, НЕ «не найдено по запросу»
  await p2.click('.tab[data-view="favorites"]');
  await p2.waitForTimeout(200);
  await p2.click('#btnSearch');
  await p2.fill('#searchInput', 'zzмояметка');
  await p2.waitForTimeout(400);
  const favTxt = await p2.$eval('#content', el => el.innerText);
  assert.ok(/больше нет в программе/i.test(favTxt), 'осиротевшее избранное при поиске → плашка-сирота: ' + favTxt.slice(0, 100));
  assert.ok(!/ничего не найдено по запросу/i.test(favTxt), 'НЕ должно быть ложного «не найдено по запросу» при 0 живых избранных');
  console.log('✓ 10. осиротевшее избранное + поиск → плашка-сирота, не «не найдено»');
  await p2.click('#btnSearchClose');

  // --- 11. Удаление своей метки при активном поиске на карте → без фантома
  await p2.click('.tab[data-view="map"]');
  await p2.waitForTimeout(1200);
  await p2.click('#btnSearch');
  await p2.fill('#searchInput', 'zzмояметка');
  await p2.waitForTimeout(500);
  const beforeDel = await p2.evaluate(() => (GEO.searchLayers || []).length);
  assert.ok(beforeDel >= 1, 'метка «лагерь» показана поштучно под поиск: ' + beforeDel);
  // открыть карточку метки и удалить
  const spot = await p2.evaluate(() => {
    const m = (GEO.pinMarkers[0] && GEO.pinMarkers[0].marker && GEO.pinMarkers[0].marker._icon);
    if (!m) return null; const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  assert.ok(spot, 'нашли маркер метки на экране');
  await p2.mouse.click(spot.x, spot.y);
  await p2.waitForTimeout(300);
  await p2.click('#pinCardDel');
  await p2.waitForTimeout(400);
  const afterDel = await p2.evaluate(() => ({
    search: (GEO.searchLayers || []).length,
    pins: (GEO.pinMarkers || []).length,
    ghost: !!(document.querySelector('.pin-my') && !document.querySelector('.pin-my').closest('.map-point')),
  }));
  assert.equal(afterDel.pins, 0, 'метка удалена из state');
  assert.equal(afterDel.search, 0, 'после удаления метки под поиском не осталось фантома на карте');
  console.log('✓ 11. удаление метки при поиске на карте — без фантома');

  await ctx2.close(); await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  console.log('\n=== СКВОЗНОЙ ПОИСК: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

async function clickFunnel(page) {
  await page.locator('.filter-chip-btn:visible').first().click();
}
