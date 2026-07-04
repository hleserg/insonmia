'use strict';
/* Фильтры/день/радиус/поиск переживают рефреш (sessionStorage): F5/тихий reload
   их сохраняет, новая сессия (закрыл приложение) — сбрасывает на «всё».
   Индикатор воронки восстанавливается. Офлайн. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8170;
const BASE = `http://127.0.0.1:${PORT}`;
const PT = { latitude: 54.68025, longitude: 35.08971 };

(async () => {
  const { spawn } = require('child_process');
  let srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);

  const getState = page => page.evaluate(() => ({
    type: state.type,
    ageSize: state.filters ? state.filters.age.size : -1,
    ageTotal: state.filters ? state.filters._ages.length : -1,
    venueSize: state.filters ? state.filters.venue.size : -1,
    venueTotal: state.filters ? state.filters._venues.length : -1,
    day: state.day, query: state.query,
    radius: (typeof GEO !== 'undefined' && GEO.nearby) ? GEO.nearby.radius : null,
    typeChipActive: (document.querySelector('#typeChips .chip.active[data-type]') || {}).dataset ? document.querySelector('#typeChips .chip.active[data-type]').dataset.type : null,
  }));
  const dotHidden = page => page.evaluate(() => document.querySelector('#filterDot').classList.contains('hidden'));

  // === Основной контекст (SW заблокирован): рефреш = сеть, sessionStorage жив ===
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
    geolocation: PT, permissions: ['geolocation'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(700);

  // --- 1. тип-чип «дневная» → рефреш → сохранился, чип активен
  await page.click('#typeChips .chip[data-type="program"]'); await page.waitForTimeout(200);
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(700);
  let s = await getState(page);
  assert.equal(s.type, 'program', 'тип переживает рефреш: ' + s.type);
  assert.equal(s.typeChipActive, 'program', 'активный чип восстановлен: ' + s.typeChipActive);
  console.log('✓ 1. тип-фильтр переживает рефреш (чип активен)');

  // --- 2/6. ценз-воронка сужена → рефреш → сужение сохранилось + точка на воронке
  await page.evaluate(() => { openFilterSheet(); filterDraft.age = new Set([state.filters._ages[0]]); applyFilters(); });
  await page.waitForTimeout(200);
  s = await getState(page);
  assert.ok(s.ageSize < s.ageTotal && s.ageSize === 1, `ценз сужен до 1: ${s.ageSize}/${s.ageTotal}`);
  assert.ok(!(await dotHidden(page)), 'точка на воронке видна (фильтр активен)');
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(700);
  s = await getState(page);
  assert.equal(s.ageSize, 1, 'ценз-сужение пережило рефреш: ' + s.ageSize);
  assert.ok(!(await dotHidden(page)), '✓6: индикатор фильтра восстановлен после рефреша');
  console.log('✓ 2/6. ценз-воронка переживает рефреш + индикатор восстановлен');

  // --- 4. тип + поиск + день вместе → всё переживает рефреш
  await page.click('#typeChips .chip[data-type="animation"]'); await page.waitForTimeout(150);
  await page.click('#btnSearch'); await page.waitForTimeout(120);
  await page.fill('#searchInput', 'фильм'); await page.waitForTimeout(350);
  const dayBefore = (await getState(page)).day;
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(700);
  s = await getState(page);
  assert.equal(s.type, 'animation', 'тип (в комбо) пережил: ' + s.type);
  assert.equal(s.query, 'фильм', 'поиск пережил: ' + s.query);
  assert.equal(s.day, dayBefore, 'день пережил: ' + s.day);
  assert.equal(await page.inputValue('#searchInput'), 'фильм', 'поле поиска восстановлено видимым');
  console.log('✓ 4. тип+поиск+день вместе переживают рефреш');

  // --- 5. «рядом»: радиус переживает рефреш
  await page.click('.tab[data-view="nearby"]'); await page.waitForTimeout(600);
  await page.click('#mapChips .chip >> text=150 м').catch(async () => {
    await page.evaluate(() => { GEO.nearby.radius = 150; saveFilterState(); });
  });
  await page.waitForTimeout(200);
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(700);
  s = await getState(page);
  assert.equal(s.radius, 150, 'радиус «рядом» пережил рефреш: ' + s.radius);
  console.log('✓ 5. радиус «рядом» переживает рефреш');

  // --- 3. НОВАЯ сессия (закрыл приложение) → sessionStorage пуст → дефолт «всё»
  const ctx2 = await browser.newContext({
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
    geolocation: PT, permissions: ['geolocation'],
  });
  const page2 = await ctx2.newPage();
  await page2.goto(BASE + '/', { waitUntil: 'load' }); await page2.waitForTimeout(700);
  const s2 = await getState(page2);
  assert.equal(s2.type, 'all', 'новая сессия: тип по умолчанию «всё»');
  assert.equal(s2.ageSize, s2.ageTotal, 'новая сессия: ценз полный (не сужен)');
  assert.equal(s2.query, '', 'новая сессия: поиск пуст');
  assert.ok(await dotHidden(page2), 'новая сессия: точки на воронке нет');
  console.log('✓ 3. новая сессия → фильтры на «всё» (sessionStorage чист)');
  await ctx2.close();

  // === 7. Офлайн: SW-контекст, кэш онлайн → gasим сервер → рефреш из кэша ===
  const ctxSW = await browser.newContext({
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC',
    geolocation: PT, permissions: ['geolocation'],
  });
  const pageSW = await ctxSW.newPage();
  const external = [];
  pageSW.on('request', r => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname)) external.push(r.url()); });
  await pageSW.goto(BASE + '/', { waitUntil: 'load' }); await pageSW.waitForTimeout(1500); // дать SW прекэшировать
  await pageSW.click('#typeChips .chip[data-type="program"]'); await pageSW.waitForTimeout(200);
  killSrv(); await pageSW.waitForTimeout(400); // РЕАЛЬНЫЙ офлайн
  await pageSW.reload({ waitUntil: 'load' }); await pageSW.waitForTimeout(800);
  const sSW = await getState(pageSW);
  assert.equal(sSW.type, 'program', 'офлайн-рефреш (из кэша) сохранил фильтр: ' + sSW.type);
  assert.equal(external.length, 0, 'офлайн: 0 внешних запросов: ' + JSON.stringify(external.slice(0, 3)));
  console.log('✓ 7. офлайн: фильтр переживает рефреш из кэша, 0 внешних запросов');
  await ctxSW.close();

  await ctx.close(); await browser.close();
  killSrv();
  console.log('\n=== ФИЛЬТРЫ ПЕРЕЖИВАЮТ РЕФРЕШ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
