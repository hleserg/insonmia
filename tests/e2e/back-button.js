'use strict';
/* Системная «назад»/свайп закрывает модалку, а не выкидывает из приложения
   (History API). Каждая модалка = запись истории; popstate закрывает верхнюю;
   крестик и «назад» эквивалентны; история не пухнет; нет модалок → «назад»
   штатно уходит из приложения; вложенность закрывается послойно; офлайн. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8169;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const { spawn } = require('child_process');
  let srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
    geolocation: { latitude: 54.68025, longitude: 35.08971 }, permissions: ['geolocation'],
  });
  // standalone — как установленная PWA (в т.ч. для iOS-паритета жеста «назад»)
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });

  const back = async () => { await page.evaluate(() => history.back()); await page.waitForTimeout(180); };
  const alive = () => page.evaluate(() => window.__alive === 'festa' && !!document.querySelector('#tabs'));
  const hist = () => page.evaluate(() => history.length);
  const vis = sel => page.evaluate(s => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);

  const boot = async () => {
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(600);
    await page.evaluate(() => { window.__alive = 'festa'; });
  };
  await boot();

  // --- 1. описание события → «назад» закрывает, остаёмся в приложении
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(400);
  await page.click('.event'); await page.waitForTimeout(250);
  assert.ok(await vis('#sheet'), 'описание события открылось');
  await back();
  assert.ok(!(await vis('#sheet')), 'после «назад» описание закрылось');
  assert.ok(await alive(), 'приложение НЕ вылетело (жив, вкладки на месте)');
  console.log('✓ 1. событие → «назад» закрывает описание, не выходя из приложения');

  // --- 2. 10 событий открыл-закрыл через «назад»: ни вылета, история не пухнет
  const h0 = await hist();
  let hAfterFirst = null;
  for (let i = 0; i < 10; i++) {
    await page.click('.event'); await page.waitForTimeout(120);
    assert.ok(await vis('#sheet'), `итерация ${i}: открылось`);
    if (i === 0) hAfterFirst = await hist();
    await back();
    assert.ok(!(await vis('#sheet')), `итерация ${i}: закрылось`);
    assert.ok(await alive(), `итерация ${i}: не вылетели`);
  }
  const hAfterTen = await hist();
  assert.equal(hAfterTen, hAfterFirst, `история не растёт: ${hAfterFirst} → ${hAfterTen}`);
  console.log(`✓ 2. 10× открыл-закрыл «назад»: 0 вылетов, история стабильна (${h0}→${hAfterTen})`);

  // --- 3. модалка фильтров → «назад» закрывает
  await page.click('#btnFilter'); await page.waitForTimeout(250);
  assert.ok(await vis('#filterSheet'), 'фильтры открылись');
  await back();
  assert.ok(!(await vis('#filterSheet')), '«назад» закрыл фильтры');
  assert.ok(await alive(), 'после фильтров живы');
  console.log('✓ 3. фильтры → «назад» закрывает');

  // --- 4. форма метки (карта) → «назад» закрывает
  await page.click('.tab[data-view="map"]'); await page.waitForTimeout(1200);
  await page.click('#btnAddPin'); await page.waitForTimeout(150);
  await page.click('#pinAddCoords'); await page.waitForTimeout(200); // меню→редактор (переход)
  assert.ok(await vis('#pinEditor'), 'редактор метки открылся');
  await back();
  assert.ok(!(await vis('#pinEditor')), '«назад» закрыл редактор метки');
  assert.ok(await alive(), 'после редактора живы');
  console.log('✓ 4. форма метки → «назад» закрывает (переход меню→редактор корректен)');

  // --- 5. вложенность: две модалки → «назад» закрывает по одному слою
  await page.evaluate(() => { showSheet('#settings'); showSheet('#pinImport'); });
  await page.waitForTimeout(150);
  assert.ok(await vis('#settings') && await vis('#pinImport'), 'обе модалки открыты (стек 2)');
  await back();
  assert.ok(!(await vis('#pinImport')) && await vis('#settings'), '«назад» закрыл верхнюю, нижняя жива');
  await back();
  assert.ok(!(await vis('#settings')), 'ещё «назад» закрыл нижнюю');
  assert.ok(await alive(), 'после вложенности живы');
  console.log('✓ 5. вложенность: «назад» снимает по одному слою (стек синхронен истории)');

  // --- 6. крестик и «назад» эквивалентны, история не пухнет между способами
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(300);
  await page.click('.event'); await page.waitForTimeout(200);
  await page.click('#sheet .sheet-titlebar .icon-btn[data-close]'); await page.waitForTimeout(220);
  assert.ok(!(await vis('#sheet')), 'крестик закрыл');
  const hByCross = await hist();
  await page.click('.event'); await page.waitForTimeout(200);
  await back();
  assert.ok(!(await vis('#sheet')), '«назад» закрыл');
  const hByBack = await hist();
  // тот же цикл через крестик и через «назад» оставляет историю в одном состоянии
  assert.equal(hByCross, hByBack, `крестик и «назад» → одинаковая история: ${hByCross} vs ${hByBack}`);
  console.log('✓ 6. крестик == «назад» (одинаковое состояние истории, без лишних записей)');

  // --- 6b. переход через hideAllSheets+showSheet (как импорт/входящая метка) синхронен
  await page.evaluate(() => { showSheet('#settings'); });
  await page.waitForTimeout(120);
  await page.evaluate(() => { hideAllSheets(); showSheet('#pinImport'); }); // один тик — как openPinImport
  await page.waitForTimeout(150);
  assert.ok(await vis('#pinImport') && !(await vis('#settings')), 'переход: импорт открыт, настройки закрыты');
  await back();
  assert.ok(!(await vis('#pinImport')), '«назад» закрыл импорт (переход не накопил лишнего)');
  assert.ok(await alive(), 'после перехода живы');
  console.log('✓ 6b. hideAllSheets+showSheet переход синхронен истории (флоу карты)');

  // --- 7. Escape (hideAllSheets) НЕ оставляет фантом: без модалок «назад» ВЫХОДИТ
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(200);
  await page.click('.event'); await page.waitForTimeout(200);
  assert.ok(await vis('#sheet'), 'событие открыто');
  await page.keyboard.press('Escape'); await page.waitForTimeout(220);
  assert.ok(!(await vis('#sheet')), 'Escape (hideAllSheets) закрыл описание');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.sheet:not(.hidden)').length), 0, 'модалок нет');
  await page.evaluate(() => history.back()); await page.waitForTimeout(300);
  const leftApp = await page.evaluate(() => !document.querySelector('#tabs')); // ушли со страницы
  assert.ok(leftApp, 'после Escape/hideAllSheets стек чист → «назад» ВЫХОДИТ (не холостое нажатие, не залипший фантом)');
  console.log('✓ 7. hideAllSheets чистит стек — без модалок «назад» штатно выходит');

  // --- 8. офлайн: «назад» закрывает модалку без сети, приложение не конфликтует
  await boot(); // вернёмся в приложение
  killSrv(); await page.waitForTimeout(300); // РЕАЛЬНЫЙ офлайн — гасим сервер
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(300);
  await page.click('.event'); await page.waitForTimeout(200);
  assert.ok(await vis('#sheet'), 'офлайн: описание открылось');
  await back();
  assert.ok(!(await vis('#sheet')), 'офлайн: «назад» закрыл');
  assert.ok(await alive(), 'офлайн: приложение живо');
  console.log('✓ 8. офлайн: «назад» закрывает модалку, конфликта нет');

  await ctx.close(); await browser.close();
  killSrv();
  console.log('\n=== СИСТЕМНАЯ «НАЗАД»: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
