'use strict';
/* «Назад» после перехода «событие → на карте» ВОЗВРАЩАЕТ описание того же
   события, а не выходит из приложения. Цепочка: программа → [описание] →
   [на карте] → назад = описание → назад = программа. Карта напрямую (вкладкой) →
   «назад» штатный, без фантомного описания. Не ломает перехват модалок. Офлайн. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8173;
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
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });

  const back = async () => { await page.evaluate(() => history.back()); await page.waitForTimeout(400); };
  const alive = () => page.evaluate(() => window.__alive === 'festa' && !!document.querySelector('#tabs'));
  const vis = sel => page.evaluate(s => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);
  const tabActive = v => page.evaluate(view => document.querySelector(`.tab[data-view="${view}"]`).classList.contains('active'), v);
  const title = () => page.evaluate(() => { const t = document.querySelector('#sheet .detail-title'); return t ? t.textContent : null; });
  const boot = async () => {
    await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(600);
    await page.evaluate(() => { window.__alive = 'festa'; });
  };
  // открыть первое событие, у которого есть кнопка «на карте» (.geo-jump)
  const openEventWithGeo = async () => {
    await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(400);
    const n = await page.evaluate(() => document.querySelectorAll('.event .event-main').length);
    for (let i = 0; i < n; i++) {
      await page.evaluate(idx => document.querySelectorAll('.event .event-main')[idx].click(), i);
      await page.waitForTimeout(140);
      if (await page.evaluate(() => !!document.querySelector('#sheet .geo-jump'))) return await title();
      await page.click('#sheet .sheet-titlebar .icon-btn[data-close]'); await page.waitForTimeout(100);
    }
    return null;
  };

  await boot();
  const evTitle = await openEventWithGeo();
  assert.ok(evTitle, 'нашли событие с кнопкой «на карте» (.geo-jump)');

  // --- 1. событие → «на карте» → «назад» ВЕРНУЛО описание того же события
  await page.click('#sheet .geo-jump'); await page.waitForTimeout(600);
  assert.ok(!(await vis('#sheet')), 'после «на карте» описание скрыто, показана карта');
  assert.ok(await tabActive('map'), 'активна вкладка «карта»');
  await back();
  assert.ok(await vis('#sheet'), '«назад» с карты ВЕРНУЛ описание (не вылет)');
  assert.equal(await title(), evTitle, 'вернулось ТО ЖЕ событие');
  assert.ok(await alive(), 'приложение живо');
  console.log('✓ 1. событие → на карте → «назад» вернул описание того же события');

  // --- 2. ещё «назад» → описание закрылось, вернулись в программу
  await back();
  assert.ok(!(await vis('#sheet')), 'ещё «назад» закрыл описание');
  assert.ok(await tabActive('schedule'), 'вернулись в программу');
  assert.ok(await alive(), 'приложение живо (не вышли раньше времени)');
  console.log('✓ 2. ещё «назад» → описание закрылось, в списке (не вылет)');

  // --- 2c. ТОЧНЫЙ РЕПРО бага: событие→карта→назад(описание)→назад(программа, НЕ выход)→назад(выход)
  await boot();
  await openEventWithGeo();
  await page.click('#sheet .geo-jump'); await page.waitForTimeout(500); // на карте
  await back();
  assert.ok(await vis('#sheet'), '2c: назад#1 вернул описание');
  await back();
  assert.ok(!(await vis('#sheet')) && await alive(), '2c: назад#2 → программа, НЕ выход (был баг: pushState внутри popstate)');
  await page.evaluate(() => history.back()); await page.waitForTimeout(350);
  assert.ok(await page.evaluate(() => !document.querySelector('#tabs')), '2c: назад#3 → только теперь выход из приложения');
  console.log('✓ 2c. размотка событие→карта→описание→программа→выход: back#2 НЕ выходит (баг починен)');

  // --- 3. карта НАПРЯМУЮ (вкладкой) → «назад» штатный, без фантомного описания
  await boot();
  await page.click('.tab[data-view="map"]'); await page.waitForTimeout(800);
  await page.evaluate(() => history.back()); await page.waitForTimeout(350);
  assert.ok(await page.evaluate(() => !document.querySelector('#tabs')), 'карта вкладкой → «назад» покидает приложение (нет левого описания)');
  console.log('✓ 3. карта напрямую → «назад» штатный (без фантомного описания)');

  // --- 4. повторяемость: событие → карта → назад → событие → карта → назад → событие
  await boot();
  await openEventWithGeo();
  for (let k = 0; k < 2; k++) {
    await page.click('#sheet .geo-jump'); await page.waitForTimeout(500);
    assert.ok(await tabActive('map'), `цикл ${k}: на карте`);
    await back();
    assert.ok(await vis('#sheet'), `цикл ${k}: «назад» вернул описание`);
    assert.equal(await title(), evTitle, `цикл ${k}: то же событие`);
  }
  assert.ok(await alive(), 'после повторов приложение живо, стек не сломан');
  console.log('✓ 4. событие↔карта по «назад» работает повторно (стек не сломан)');

  // --- 5. не сломан перехват модалок: фильтры закрываются по «назад»
  await back(); await page.waitForTimeout(150); // закрыть описание
  await page.click('#btnFilter'); await page.waitForTimeout(250);
  assert.ok(await vis('#filterSheet'), 'фильтры открылись');
  await back();
  assert.ok(!(await vis('#filterSheet')) && await alive(), '«назад» закрыл фильтры (прошлый фикс цел)');
  console.log('✓ 5. перехват модалок цел (фильтры закрываются по «назад»)');

  // --- 5b. ушёл с карты ВКЛАДКОЙ → «назад» НЕ воскрешает старое описание (шаг снят)
  await boot();
  await openEventWithGeo();
  await page.click('#sheet .geo-jump'); await page.waitForTimeout(500); // на карте, шаг возврата в стеке
  assert.ok(await tabActive('map'), '5b: на карте');
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(300); // ушёл вкладкой сам
  assert.ok(await tabActive('schedule') && !(await vis('#sheet')), '5b: ушли на программу вкладкой, описания нет');
  await page.evaluate(() => history.back()); await page.waitForTimeout(350);
  assert.ok(!(await vis('#sheet')), '5b: «назад» НЕ воскресил описание (осиротевший шаг снят при смене вкладки)');
  console.log('✓ 5b. смена вкладки снимает шаг возврата — «назад» не воскрешает описание');

  // --- 5c. описание, открытое ПОВЕРХ карты → «назад» с geo-jump возвращает описание НА КАРТЕ
  await boot();
  const evGeoId = await page.evaluate(() => {
    const ev = (state.program.events || []).find(e => typeof eventGeoPoints === 'function' && eventGeoPoints(e).length);
    return ev ? ev.id : null;
  });
  assert.ok(evGeoId, 'нашли событие с гео-точкой');
  await page.evaluate(() => switchView('map')); await page.waitForTimeout(700);
  await page.evaluate(id => openDetail(id), evGeoId); await page.waitForTimeout(300);
  assert.ok(await vis('#sheet') && await tabActive('map'), '5c: описание открыто ПОВЕРХ карты');
  await page.click('#sheet .geo-jump'); await page.waitForTimeout(500);
  assert.ok(await tabActive('map') && !(await vis('#sheet')), '5c: geo-jump → карта, описание усыплено');
  await back();
  assert.ok(await vis('#sheet') && await tabActive('map'), '5c: «назад» вернул описание ПОВЕРХ КАРТЫ, не выбросило на «Программу»');
  console.log('✓ 5c. описание над картой: «назад» с geo-jump возвращает к описанию на карте (fromView=реальный вид)');

  // --- 6. офлайн: событие → карта → «назад» возвращает описание без сети
  await boot();
  await openEventWithGeo();
  killSrv(); await page.waitForTimeout(300); // РЕАЛЬНЫЙ офлайн
  await page.click('#sheet .geo-jump'); await page.waitForTimeout(500);
  assert.ok(await tabActive('map'), 'офлайн: на карте');
  await back();
  assert.ok(await vis('#sheet') && await title() === evTitle, 'офлайн: «назад» вернул то же описание');
  assert.ok(await alive(), 'офлайн: приложение живо');
  console.log('✓ 6. офлайн: событие → карта → «назад» возвращает описание');

  await ctx.close(); await browser.close();
  killSrv();
  console.log('\n=== «НАЗАД» ПОСЛЕ «НА КАРТЕ»: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
