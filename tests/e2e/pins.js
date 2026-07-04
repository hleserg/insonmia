'use strict';
/* E2E меток: форма, лонгтап, персистентность, «рядом», шаринг, диплинк, импорт текста. */
const { chromium, launchOpts, REPO, tmpProfile } = require('./_env');
const { spawn } = require('child_process');
const assert = require('assert');

const PORT = 8100, BASE = `http://127.0.0.1:${PORT}`;
const GEOPOS = { latitude: 54.681149, longitude: 35.091007 };
const T = Date.UTC(2026, 6, 9, 15, 0);
let server = null;
const serverOn = () => { server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' }); return new Promise(r => setTimeout(r, 800)); };

(async () => {
  await serverOn();
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC',
    geolocation: GEOPOS, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.clock.install({ time: T });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  // 1. создание через ➕: имя, русская запятая, эмодзи, заметка
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(900);
  await page.click('#btnAddPin');
  await page.click('#pinAddCoords'); // ➕ теперь открывает меню способов
  await page.fill('#pinName', 'Наш лагерь');
  await page.fill('#pinCoords', '54,68120 35,09110');
  await page.click('#pinEmojiRow button[data-emoji="⛺"]');
  await page.fill('#pinNote', 'за жёлтым шатром');
  await page.click('#pinSave');
  await page.waitForTimeout(600);
  let pins = await page.evaluate(() => JSON.parse(localStorage.getItem('insomnia.pins')));
  assert.equal(pins.length, 1);
  assert.equal(pins[0].emoji, '⛺');
  assert.ok(Math.abs(pins[0].lat - 54.68120) < 1e-9, 'русская запятая не распозналась');
  const markers = await page.locator('#leafletMap .pin-my').count();
  assert.ok(markers >= 1, 'маркера на карте нет');
  console.log('1. создание через ➕: OK (русская запятая, эмодзи, маркер на карте)');

  // 2. лонгтап (contextmenu) по карте открывает редактор с координатами
  await page.click('#leafletMap', { button: 'right', position: { x: 180, y: 300 } });
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => !document.querySelector('#pinEditor').classList.contains('hidden'));
  const coordsPrefilled = await page.inputValue('#pinCoords');
  assert.ok(opened, 'редактор не открылся по лонгтапу');
  assert.ok(/54\.\d+, 35\.\d+/.test(coordsPrefilled), 'координаты не подставились: ' + coordsPrefilled);
  await page.click('#pinEditor .icon-btn[data-close]');
  console.log('2. лонгтап: OK (редактор с координатами точки)');

  // 3. «рядом»: мои метки первым блоком
  await page.click('.tab[data-view="nearby"]');
  await page.waitForTimeout(800);
  const nearTxt = await page.evaluate(() => document.querySelector('#content').innerText);
  assert.ok(/мои метки/.test(nearTxt), 'нет блока «мои метки»');
  assert.ok(nearTxt.indexOf('мои метки') < nearTxt.indexOf('Наш лагерь'), 'порядок блока неверный');
  const firstLabel = await page.evaluate(() => document.querySelector('#content .time-group-label').textContent);
  assert.equal(firstLabel, 'мои метки', 'блок «мои» не первый');
  console.log('3. «рядом»: OK — мои метки первым блоком, с метрами');

  // 4. персистентность: перезагрузка
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  pins = await page.evaluate(() => JSON.parse(localStorage.getItem('insomnia.pins')));
  assert.equal(pins.length, 1, 'метка не пережила перезагрузку');
  console.log('4. персистентность: OK');

  // 5. шаринг: «рядом» -> тап по своей метке (зум+карточка) -> «поделиться» -> буфер
  await page.click('.tab[data-view="nearby"]');
  await page.waitForTimeout(700);
  await page.locator('#content .map-point', { hasText: 'Наш лагерь' }).first().click();
  await page.waitForTimeout(900); // switchView('map') + setView + openPinCard
  await page.click('#pinCardShare');
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(clip.includes('#pin=54.68120,35.09110,'), 'диплинк не в hash: ' + clip);
  assert.ok(clip.startsWith(BASE + '/'), 'нет полного URL c origin+путём: ' + clip);
  assert.ok(decodeURIComponent(clip).includes('Наш лагерь'), 'имя не в ссылке');
  await page.click('#sheet .icon-btn[data-close]');
  console.log('5. шаринг: OK —', clip.slice(0, 60) + '…');

  // 6. диплинк из чужой ссылки: «Добавить» + hash вычищен
  await page.goto(BASE + '/#pin=54.69000,35.08000,' + encodeURIComponent('Машина Димы') + ',🚗', { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  const sheetTxt = await page.evaluate(() => document.querySelector('#pinIncomingBody').innerText);
  assert.ok(/Машина Димы/.test(sheetTxt), 'входящая метка не показана');
  const hashNow = await page.evaluate(() => location.hash);
  assert.equal(hashNow, '', 'hash не вычищен replaceState: ' + hashNow);
  await page.click('#pinIncomingAdd');
  await page.waitForTimeout(700);
  pins = await page.evaluate(() => JSON.parse(localStorage.getItem('insomnia.pins')));
  assert.equal(pins.length, 2, 'входящая метка не добавилась');
  console.log('6. диплинк: OK — «Добавить» работает, hash вычищен');

  // 7. повторное имя обновляет, не дублирует (через ту же форму)
  await page.click('#btnAddPin');
  await page.click('#pinAddCoords'); // ➕ теперь открывает меню способов
  await page.fill('#pinName', 'наш лагерь'); // другой регистр
  await page.fill('#pinCoords', '54.68800, 35.08000');
  await page.click('#pinEmojiRow button[data-emoji="🔥"]');
  await page.click('#pinSave');
  await page.waitForTimeout(500);
  pins = await page.evaluate(() => JSON.parse(localStorage.getItem('insomnia.pins')));
  assert.equal(pins.length, 2, 'дубль по имени');
  const camp = pins.find(p => /лагерь/i.test(p.name));
  assert.equal(camp.emoji, '🔥', 'обновление не применилось');
  console.log('7. повторное имя: OK — обновление без дубля');

  // 8. «добавить из текста» из настроек
  await page.click('#btnSettings');
  await page.waitForTimeout(400);
  await page.click('#btnPinsImport');
  await page.fill('#pinImportText', 'Душевая наша\n54,6820 35,0790\n\ngeo:54.6835,35.0765');
  await page.click('#pinImportGo');
  await page.waitForTimeout(300);
  const prevRows = await page.locator('.pin-import-row').count();
  assert.equal(prevRows, 2, 'превью не 2 строки: ' + prevRows);
  await page.click('#pinImportApply');
  await page.waitForTimeout(500);
  pins = await page.evaluate(() => JSON.parse(localStorage.getItem('insomnia.pins')));
  assert.equal(pins.length, 4, 'импорт из текста не добавил: ' + pins.length);
  console.log('8. импорт из текста: OK — имя из соседней строки + geo:');

  // 9. экспорт одной строкой -> буфер, и она же парсится обратно
  await page.click('#btnSettings');
  await page.waitForTimeout(300);
  await page.click('#btnPinsExport');
  await page.waitForTimeout(300);
  const exp = await page.evaluate(() => navigator.clipboard.readText());
  const parsedBack = await page.evaluate(l => window.InsomniaCore.parsePinsFromText(l).length, exp);
  assert.equal(parsedBack, 4, 'экспортная строка не парсится обратно: ' + parsedBack);
  console.log('9. экспорт одной строкой: OK — round-trip 4/4');

  // 10. переполнение вёрстки на 360px с открытым редактором
  await page.click('#btnAddPin').catch(() => {});
  await page.click('#pinAddCoords').catch(() => {}); // меню → форма
  const over = await page.evaluate(() => document.documentElement.scrollWidth > 362);
  assert.ok(!over, 'горизонтальный перелив 360px');
  console.log('10. 360px: OK');

  const real = errors.filter(e => !/favicon|icon from the Manifest/i.test(e));
  if (real.length) { console.log('КОНСОЛЬ:', real.join('\n')); }
  assert.equal(real.length, 0, 'ошибки консоли');
  console.log('\nМЕТКИ E2E: ВСЁ ЗЕЛЁНОЕ');
  await browser.close();
  server.kill('SIGKILL');
  process.exit(0);
})().catch(async e => { console.error('FAIL:', e.message); if (server) server.kill('SIGKILL'); process.exit(1); });
