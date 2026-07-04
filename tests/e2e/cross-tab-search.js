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

  // --- 8. Офлайн: ни одного внешнего запроса за весь сценарий
  assert.equal(external.length, 0, 'внешних запросов не было (офлайн): ' + JSON.stringify(external.slice(0, 3)));
  console.log('✓ 8. всё офлайн — ноль внешних запросов');

  await ctx.close(); await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  console.log('\n=== СКВОЗНОЙ ПОИСК: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

async function clickFunnel(page) {
  await page.locator('.filter-chip-btn:visible').first().click();
}
