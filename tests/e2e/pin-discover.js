'use strict';
/* Обнаруживаемое создание метки: кнопка ➕ открывает меню способов
   (GPS / точкой на карте / координаты), режим «точкой» ставит метку по тапу,
   подсказка внизу карты пока меток нет (закрывается, помнит), FAQ, офлайн. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8165;
const BASE = `http://127.0.0.1:${PORT}`;
const PT = { latitude: 54.68025, longitude: 35.08971 };

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
    geolocation: PT, permissions: ['geolocation'],
  });
  const page = await ctx.newPage();
  const external = [];
  page.on('request', r => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname)) external.push(r.url()); });
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(1300);

  // --- 4/1. Первый заход, 0 меток → подсказка внизу видна; ➕ на месте
  assert.ok(await page.isVisible('#btnAddPin'), 'кнопка ➕ видна на карте');
  assert.ok(await page.isVisible('#mapPinHint'), 'при 0 метках видна подсказка внизу карты');
  console.log('✓ 1/4. ➕ на карте + подсказка «поставь метку» при 0 метках');

  // --- 5. Подсказка закрывается крестиком и не возвращается (localStorage)
  await page.click('#mapPinHintClose');
  await page.waitForTimeout(150);
  assert.ok(!(await page.isVisible('#mapPinHint')), 'подсказка скрылась по ✕');
  assert.equal(await page.evaluate(() => localStorage.getItem('insomnia.pinHintDismissed')), '1', 'запомнили закрытие');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(1000);
  assert.ok(!(await page.isVisible('#mapPinHint')), 'после перезагрузки подсказка не вернулась (0 меток, но закрыта)');
  console.log('✓ 5. подсказка закрывается и не мозолит глаза (localStorage)');

  // --- 1/меню. Тап ➕ → меню способов (три кнопки)
  await page.click('#btnAddPin');
  await page.waitForTimeout(200);
  assert.ok(await page.isVisible('#pinAddMenu'), 'по ➕ открылось меню способов');
  for (const id of ['#pinAddGps', '#pinAddTap', '#pinAddCoords']) {
    assert.ok(await page.isVisible(id), 'в меню есть кнопка ' + id);
  }
  console.log('✓ меню способов: GPS / точкой / координаты');

  // --- 2. «Выбрать точкой» → режим + подсказка сверху; тап по карте ставит метку
  await page.click('#pinAddTap');
  await page.waitForTimeout(150);
  assert.ok(!(await page.isVisible('#pinAddMenu')), 'меню закрылось');
  assert.ok(await page.isVisible('#mapPlaceHint'), 'подсказка сверху «коснитесь карты»');
  assert.equal(await page.evaluate(() => GEO.placeMode), true, 'режим выбора точкой активен');
  // детерминированно: инициируем тап по карте
  await page.evaluate(() => GEO.map.fire('click', { latlng: { lat: 54.6815, lng: 35.0905 } }));
  await page.waitForTimeout(250);
  assert.ok(await page.isVisible('#pinEditor'), 'тап по карте открыл редактор метки');
  assert.equal(await page.evaluate(() => GEO.placeMode), false, 'режим выключился после постановки');
  const coords = await page.$eval('#pinCoords', el => el.value);
  assert.ok(/54\.68/.test(coords), 'координаты подставлены из тапа: ' + coords);
  await page.fill('#pinName', 'Наш лагерь');
  await page.click('#pinSave');
  await page.waitForTimeout(300);
  const pinCount = await page.evaluate(() => (state.pins || []).length);
  assert.equal(pinCount, 1, 'метка создана: ' + pinCount);
  console.log('✓ 2. «выбрать точкой» → режим → тап ставит метку');

  // --- 2b. режим «точкой» не залипает: передумал и открыл меню/другой способ →
  //     placeMode сброшен, следующий обычный тап по карте НЕ ставит метку
  await page.click('#btnAddPin'); await page.waitForTimeout(120);
  await page.click('#pinAddTap'); await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => GEO.placeMode), true, 'режим включился');
  await page.click('#btnAddPin'); await page.waitForTimeout(120); // передумал — снова меню
  assert.equal(await page.evaluate(() => GEO.placeMode), false, 'повторное меню сбросило режим');
  assert.ok(!(await page.isVisible('#mapPlaceHint')), 'подсказка режима скрылась');
  await page.click('#pinAddCoords'); await page.waitForTimeout(120); // выбрал другой способ
  await page.click('#pinEditor .icon-btn[data-close]'); await page.waitForTimeout(120);
  const before = await page.evaluate(() => (state.pins || []).length);
  await page.evaluate(() => GEO.map.fire('click', { latlng: { lat: 54.6819, lng: 35.0909 } }));
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => (state.pins || []).length);
  assert.equal(after, before, 'обычный тап по карте не должен ставить метку после сброса режима');
  assert.ok(!(await page.isVisible('#pinEditor')), 'редактор не открылся ложно');
  console.log('✓ 2b. режим «точкой» не залипает (меню/другой способ сбрасывают)');

  // --- 3. Лонгтап (contextmenu) всё ещё работает — открывает редактор
  await page.evaluate(() => GEO.map.fire('contextmenu', { latlng: { lat: 54.682, lng: 35.09 } }));
  await page.waitForTimeout(200);
  assert.ok(await page.isVisible('#pinEditor'), 'лонгтап (contextmenu) открывает редактор');
  await page.click('#pinEditor .icon-btn[data-close]');
  await page.waitForTimeout(150);
  console.log('✓ 3. лонгтап по карте по-прежнему открывает редактор');

  // --- 6. Способ «в моём месте» (GPS) → редактор с координатами позиции
  await page.click('#btnAddPin');
  await page.waitForTimeout(150);
  await page.click('#pinAddGps');
  await page.waitForTimeout(500);
  assert.ok(await page.isVisible('#pinEditor'), 'GPS-способ открыл редактор');
  const gpsCoords = await page.$eval('#pinCoords', el => el.value);
  assert.ok(/54\.680/.test(gpsCoords), 'координаты из GPS подставлены: ' + gpsCoords);
  await page.click('#pinEditor .icon-btn[data-close]');
  console.log('✓ 6. «в моём месте» (GPS) → редактор с координатами позиции');

  // --- 7. Контраст подсказок читаем + офлайн
  await page.click('#btnAddPin'); await page.waitForTimeout(100);
  await page.click('#pinAddTap'); await page.waitForTimeout(150);
  const contrast = await page.evaluate(() => {
    const lum = (r, g, b) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const parse = s => s.match(/\d+(\.\d+)?/g).map(Number);
    const contr = el => {
      let bg = parse(getComputedStyle(el).backgroundColor), node = el;
      while ((bg.length === 4 && bg[3] === 0) && node.parentElement) { node = node.parentElement; bg = parse(getComputedStyle(node).backgroundColor); }
      const fg = parse(getComputedStyle(el).color).slice(0, 3);
      const a = lum(...fg) + 0.05, b = lum(...bg.slice(0, 3)) + 0.05;
      return +(Math.max(a, b) / Math.min(a, b)).toFixed(2);
    };
    return contr(document.querySelector('#mapPlaceHint span'));
  });
  assert.ok(contrast >= 4.5, `контраст подсказки режима ${contrast} < 4.5`);
  await page.click('#mapPlaceCancel');
  assert.equal(external.length, 0, 'внешних запросов не было (офлайн): ' + JSON.stringify(external.slice(0, 3)));
  console.log(`✓ 7. контраст подсказки ${contrast}:1, офлайн (0 внешних запросов)`);

  await ctx.close(); await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  console.log('\n=== ОБНАРУЖИВАЕМАЯ МЕТКА: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
