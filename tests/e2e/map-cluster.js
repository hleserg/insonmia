'use strict';
/* Кластеризация меток карты (офлайн, локальный markercluster, без CDN):
   открытие на различимом зуме, кластеры с числами, тап по кластеру раскрывает,
   приближение распадается на отдельные метки, фильтр кластеризует только
   видимое. Ни одного внешнего запроса. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8159;
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
  // никаких внешних (не-localhost) запросов — всё офлайн, без CDN
  const external = [];
  page.on('request', r => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname)) external.push(r.url()); });

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);
  // markercluster подгрузился локально
  const mcLocal = await page.evaluate(() => typeof L.markerClusterGroup === 'function');
  assert.ok(mcLocal, 'markercluster загружен (локально)');

  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(1300);

  // 1. Открытие: различимый зум + кластеры с числами (метки не «в кучу»)
  const open = await page.evaluate(() => ({
    zoom: GEO.map.getZoom(),
    totalPoints: GEO.clusterGroup.getLayers().length,
    clusters: document.querySelectorAll('.geo-cluster').length,
    singles: document.querySelectorAll('.leaflet-marker-pane .geo-marker').length,
    nums: [...document.querySelectorAll('.geo-cluster .cluster-inner')].slice(0, 6).map(e => e.textContent),
  }));
  console.log('открытие:', JSON.stringify(open));
  assert.ok(open.zoom >= 15, `дефолтный зум должен быть различимым (≥15), а не «вся поляна в комок»: ${open.zoom}`);
  assert.ok(open.clusters > 0, 'на старте есть кластеры (метки схлопнуты, не навалены)');
  assert.ok(open.nums.every(t => /^\d+$/.test(t)), 'кластеры подписаны числами: ' + JSON.stringify(open.nums));
  // доказательство кластеризации: точек в группе много, а в DOM отдельных мало
  assert.ok(open.totalPoints > open.singles + open.clusters, 'часть меток схлопнута в кластеры (в DOM отдельных меньше, чем точек)');
  console.log(`✓ 1. открытие: зум ${open.zoom}, ${open.clusters} кластеров с числами, ${open.singles} одиночных из ${open.totalPoints} точек`);

  // 2. Тап по кластеру → раскрытие (zoomToBoundsOnClick → зум увеличился).
  //    Берём кластер, реально видимый в области карты (часть — за вьюпортом).
  const z0 = await page.evaluate(() => GEO.map.getZoom());
  const spot = await page.evaluate(() => {
    for (const el of document.querySelectorAll('.geo-cluster')) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx > 4 && cx < innerWidth - 4 && cy > 120 && cy < innerHeight - 4) return { cx, cy };
    }
    return null;
  });
  assert.ok(spot, 'нашли кластер в пределах вьюпорта карты');
  await page.mouse.click(spot.cx, spot.cy);
  await page.waitForTimeout(900);
  const z1 = await page.evaluate(() => GEO.map.getZoom());
  assert.ok(z1 > z0, `тап по кластеру должен приблизить/раскрыть: ${z0} → ${z1}`);
  console.log(`✓ 2. тап по кластеру раскрывает (зум ${z0} → ${z1})`);

  // 3. Сильное приближение → кластеры распадаются на отдельные метки
  await page.evaluate(() => GEO.map.setZoom(18));
  await page.waitForTimeout(900);
  const zoomed = await page.evaluate(() => ({
    clusters: document.querySelectorAll('.geo-cluster').length,
    markers: document.querySelectorAll('.leaflet-marker-pane .geo-marker').length,
  }));
  console.log('на зуме 18:', JSON.stringify(zoomed));
  assert.ok(zoomed.markers > zoomed.clusters, 'при приближении преобладают отдельные метки, а не кластеры');
  console.log(`✓ 3. приближение распадает кластеры на метки (${zoomed.markers} меток, ${zoomed.clusters} кластеров)`);

  // 4. Фильтр кластеризует только видимое: выключим всё → в группе 0 точек
  await page.evaluate(() => GEO.map.setView([GEO.map.getCenter().lat, GEO.map.getCenter().lng], 15));
  await page.waitForTimeout(400);
  await page.click('#mapChips .chip-bulk >> nth=1'); // «ничего»
  await page.waitForTimeout(400);
  const noneN = await page.evaluate(() => GEO.clusterGroup.getLayers().length);
  assert.equal(noneN, 0, 'после «ничего» кластерная группа пуста');
  await page.click('#mapChips .chip[data-cat="wc"]'); // одни туалеты
  await page.waitForTimeout(400);
  const wcN = await page.evaluate(() => GEO.clusterGroup.getLayers().length);
  assert.ok(wcN > 5 && wcN < open.totalPoints, `кластеризуются только видимые (туалеты): ${wcN}`);
  console.log(`✓ 4. фильтр кластеризует только видимое (туалетов ${wcN})`);

  // 5. Офлайн: ни одного внешнего запроса (локальный markercluster, без CDN)
  assert.equal(external.length, 0, 'внешних запросов быть не должно (офлайн, без CDN): ' + JSON.stringify(external.slice(0, 3)));
  console.log('✓ 5. ноль внешних запросов — всё офлайн, локальный markercluster');

  await ctx.close(); await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  console.log('\n=== КЛАСТЕРИЗАЦИЯ КАРТЫ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
