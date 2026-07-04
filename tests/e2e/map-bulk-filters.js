'use strict';
/* «☑ все»/«☐ ничего» в фильтрах карты: сценарий «оставить одни туалеты»
   одним тапом + «ничего», и «все» включает всё (включая авто-дороги). */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8132;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(1200);

  // точки теперь в кластерной группе — считаем ВИДИМЫЕ точки по её слоям,
  // а не по DOM (в DOM часть меток схлопнута в кружки-кластеры .geo-cluster)
  const stats = () => page.evaluate(() => ({
    markers: GEO.clusterGroup ? GEO.clusterGroup.getLayers().length : 0,
    activeChips: document.querySelectorAll('#mapChips .chip[data-cat].active').length,
    totalChips: document.querySelectorAll('#mapChips .chip[data-cat]').length,
    filters: GEO.filters.size,
  }));

  const before = await stats();
  console.log('старт:', JSON.stringify(before));
  assert.ok(before.markers > 50, 'на старте маркеры должны быть видны');

  // «ничего» — карта пустеет, все чипы гаснут
  await page.click('#mapChips .chip-bulk >> nth=1');
  await page.waitForTimeout(300);
  const none = await stats();
  console.log('после «ничего»:', JSON.stringify(none));
  assert.equal(none.markers, 0, 'после «ничего» маркеров быть не должно');
  assert.equal(none.activeChips, 0, 'все чипы должны погаснуть');

  // «оставить одни туалеты»: ничего + один тап по «туалеты»
  await page.click('#mapChips .chip[data-cat="wc"]');
  await page.waitForTimeout(300);
  const wc = await stats();
  // все видимые точки (в кластерной группе) — категории wc
  const wcMarkers = await page.evaluate(() => {
    const shown = new Set(GEO.clusterGroup.getLayers());
    return Object.values(GEO.pointById)
      .filter(r => shown.has(r.marker))
      .every(r => r.point.category === 'wc');
  });
  console.log('одни туалеты:', JSON.stringify(wc), 'все точки 🚻:', wcMarkers);
  assert.ok(wc.markers > 5 && wcMarkers, 'должны остаться только туалеты');
  assert.equal(wc.activeChips, 1, 'активен ровно один чип');

  // «все» — включается всё, включая выключенные по умолчанию авто-дороги
  await page.click('#mapChips .chip-bulk >> nth=0');
  await page.waitForTimeout(300);
  const all = await stats();
  console.log('после «все»:', JSON.stringify(all));
  assert.ok(all.markers >= before.markers, '«все» должно вернуть не меньше маркеров, чем на старте');
  assert.equal(all.activeChips, all.totalChips, 'все чипы должны гореть');
  // roads-auto захардкожен в кнопке; остальные категории — по фактическим
  // чипам, а не по именам из данных (geo.json может пересобраться)
  const allOn = await page.evaluate(() =>
    GEO.filters.has('roads-auto') &&
    [...document.querySelectorAll('#mapChips .chip[data-cat]')].every(b => GEO.filters.has(b.dataset.cat)));
  assert.ok(allOn, '«все» включает авто-дороги и каждую категорию из ряда чипов');

  // уход с вкладки и возврат — выбор не сбрасывается (state держится в GEO.filters)
  await page.click('#mapChips .chip-bulk >> nth=1');
  await page.click('#mapChips .chip[data-cat="wc"]');
  await page.click('.tab[data-view="now"]');
  await page.waitForTimeout(300);
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(600);
  const back = await stats();
  assert.equal(back.activeChips, 1, 'после возврата на карту фильтр «одни туалеты» должен сохраниться');
  console.log('✓ выбор переживает уход с вкладки');

  await ctx.close(); await browser.close();
  console.log('\n=== BULK-ФИЛЬТРЫ КАРТЫ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
