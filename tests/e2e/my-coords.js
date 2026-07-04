'use strict';
/* «Мои координаты» на карте (для потеряшек): строка [📍 координаты][🔗],
   без фикса — «включить геолокацию» + 🔗 неактивна, тап по координатам копирует,
   🔗 шарит текст+#pin=+geo: (фолбэк в буфер, Huawei без share), #pin= офлайн. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8166;
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
    geolocation: PT, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
  });
  // Huawei без сервисов Google: navigator.share отсутствует → фолбэк в буфер
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }));
  const page = await ctx.newPage();
  const external = [];
  page.on('request', r => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname)) external.push(r.url()); });
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(1300);

  // --- 1. без фикса: строка видна, «включить геолокацию», 🔗 неактивна
  assert.ok(await page.isVisible('#myCoordRow'), 'строка «мои координаты» видна на карте');
  assert.match(await page.textContent('#myCoordText'), /включить геолокацию/, 'без фикса — «включить геолокацию»');
  assert.ok(await page.evaluate(() => document.querySelector('#myCoordShare').disabled), '🔗 неактивна без фикса');
  console.log('✓ 1. без фикса: строка + «включить геолокацию» + 🔗 неактивна');

  // --- 2. тап по «включить геолокацию» → фикс, строка с координатами, 🔗 активна
  await page.click('#myCoordText');
  await page.waitForTimeout(500);
  const txt = await page.textContent('#myCoordText');
  assert.match(txt, /📍\s*54\.680\d+,\s*35\.089\d+/, 'координаты в строке: ' + txt);
  assert.ok(!(await page.evaluate(() => document.querySelector('#myCoordShare').disabled)), '🔗 активна после фикса');
  // координаты НЕ обрезаются многоточием (весь текст влезает в свой бокс)
  const clipped = await page.evaluate(() => {
    const el = document.querySelector('#myCoordText');
    return el.scrollWidth > el.clientWidth + 1;
  });
  assert.ok(!clipped, 'координаты обрезаются многоточием (scrollWidth > clientWidth)');
  console.log('✓ 2. фикс → координаты видны целиком (не обрезаны), 🔗 активна');

  // --- 3. тап по координатам копирует «lat, lng»
  await page.click('#myCoordText');
  await page.waitForTimeout(200);
  const clipCoord = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clipCoord, /^54\.680\d+,\s*35\.089\d+$/, 'в буфере ровно координаты: ' + clipCoord);
  console.log('✓ 3. тап по координатам копирует их: ' + clipCoord);

  // --- 4. 🔗 без navigator.share → буфер: «Я здесь» + #pin=-диплинк + geo:
  await page.click('#myCoordShare');
  await page.waitForTimeout(250);
  const clipShare = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clipShare, /Я здесь:\s*54\.680\d+,\s*35\.089\d+/, 'текст «Я здесь»: ' + clipShare);
  assert.ok(clipShare.includes('#pin=54.680'), 'диплинк #pin= в тексте: ' + clipShare);
  assert.ok(/geo:54\.680\d+,35\.089\d+/.test(clipShare), 'geo:-ссылка в тексте: ' + clipShare);
  assert.ok(clipShare.includes(BASE + '/'), 'полный URL с origin+путём: ' + clipShare);
  assert.ok(decodeURIComponent(clipShare).includes('Я здесь'), 'имя «Я здесь» в диплинке');
  console.log('✓ 4. 🔗 → буфер (Huawei-фолбэк): текст + #pin= + geo:');

  // --- 4b. потеряшка ушёл: сместились → 🔗 шлёт СВЕЖИЕ координаты, не первый фикс
  const MOVED = { latitude: 54.69111, longitude: 35.10222 };
  await ctx.setGeolocation(MOVED);
  await page.click('#myCoordShare');
  await page.waitForTimeout(300);
  const clipMoved = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(/Я здесь:\s*54\.691\d*,\s*35\.102\d*/.test(clipMoved), 'после смещения шлёт новую точку: ' + clipMoved);
  assert.ok(!clipMoved.includes('54.680'), 'старый фикс не протёк в шаринг: ' + clipMoved);
  const rowMoved = await page.textContent('#myCoordText');
  assert.match(rowMoved, /54\.691/, 'строка тоже обновилась на свежую: ' + rowMoved);
  console.log('✓ 4b. смещение → 🔗 и строка отдают СВЕЖИЕ координаты (не залипший фикс)');

  // --- 4c. фолбэк-поле шаринга чистит превью/кнопку от прошлого импорта
  const clean = await page.evaluate(() => {
    document.querySelector('#pinImportPreview').textContent = 'СТАРОЕ ПРЕВЬЮ';
    document.querySelector('#pinImportApply').classList.remove('hidden');
    showTextInImportField('Я здесь: тест');
    return {
      preview: document.querySelector('#pinImportPreview').textContent,
      applyHidden: document.querySelector('#pinImportApply').classList.contains('hidden'),
    };
  });
  assert.equal(clean.preview, '', 'превью от прошлого импорта очищено');
  assert.ok(clean.applyHidden, 'кнопка «добавить всё» скрыта в поле-заглушке');
  await page.click('#pinImport .sheet-titlebar .icon-btn[data-close]').catch(() => {});
  await page.waitForTimeout(150);
  console.log('✓ 4c. фолбэк-поле шаринга без залипшего превью/импорта');
  await ctx.setGeolocation(PT); // вернём исходную точку для остальных сценариев

  // --- 4d. провал фикса (таймаут GPS) инвалидирует строку: 🔗 гаснет, не врёт старой точкой
  await page.evaluate(() => { navigator.geolocation.getCurrentPosition = (ok, err) => err({ code: 3, message: 'timeout' }); });
  await page.click('#myCoordShare');
  await page.waitForTimeout(300);
  assert.match(await page.textContent('#myCoordText'), /включить геолокацию/, 'после таймаута строка сброшена');
  assert.ok(await page.evaluate(() => document.querySelector('#myCoordShare').disabled), '🔗 неактивна после провала фикса');
  console.log('✓ 4d. провал фикса (таймаут) гасит строку — 🔗 не врёт старой точкой');

  // --- 5. открытие этого же #pin= офлайн → входящая точка «Я здесь»
  const hash = clipShare.split('\n').find(l => l.includes('#pin='));
  await page.goto(hash, { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  const inc = await page.textContent('#pinIncomingBody');
  assert.match(inc, /Я здесь/, 'входящая точка «Я здесь» показана офлайн: ' + inc);
  console.log('✓ 5. #pin= офлайн открывает точку «Я здесь»');
  await page.click('#pinIncoming .sheet-titlebar .icon-btn[data-close]');
  await page.waitForTimeout(200);

  // --- 6. 360px: строка влезает без горизонтального перелива
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(800);
  const over = await page.evaluate(() => document.documentElement.scrollWidth > 362);
  assert.ok(!over, 'горизонтальный перелив на 360px');
  console.log('✓ 6. 360px: строка [координаты][🔗] влезает');

  assert.equal(external.length, 0, 'внешних запросов не было (офлайн): ' + JSON.stringify(external.slice(0, 3)));
  console.log('✓ 7. офлайн: 0 внешних запросов');

  await ctx.close(); await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  console.log('\n=== МОИ КООРДИНАТЫ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
