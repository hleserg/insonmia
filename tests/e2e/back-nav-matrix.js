'use strict';
/* СКВОЗНОЙ АУДИТ НАВИГАЦИИ (матрица маршрутов A–F). Инвариант: видимый слой ⇔
   ровно одна history-запись; «назад» снимает РОВНО ОДИН верхний слой; выход из
   приложения — только на дне и только после двойного «назад». Каждый сценарий —
   свежий контекст (пустой sessionStorage → старт «сейчас», чистая история).
   Ключевой репро BUG1: защита от выхода обязана работать на СВЕЖЕМ запуске, в т.ч.
   если «назад» нажали ПОКА приложение ещё грузится (медленное устройство). */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8184;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const { spawn } = require('child_process');
  let srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);

  const mkctx = async () => {
    const ctx = await browser.newContext({
      viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
      geolocation: { latitude: 54.68025, longitude: 35.08971 }, permissions: ['geolocation'],
    });
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    return ctx;
  };
  const fresh = async () => {
    const ctx = await mkctx();
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
    await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(600);
    await page.evaluate(() => { window.__alive = 'festa'; });
    return { ctx, page };
  };
  const back = async (page) => { await page.evaluate(() => history.back()); await page.waitForTimeout(400); };
  const alive = (page) => page.evaluate(() => window.__alive === 'festa' && !!document.querySelector('#tabs'));
  const gone = (page) => page.evaluate(() => !document.querySelector('#tabs')); // ушли со страницы
  const tab = (page) => page.evaluate(() => { const a = document.querySelector('.tab.active'); return a ? a.dataset.view : null; });
  const vis = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);
  const toastText = (page) => page.evaluate(() => { const t = document.querySelector('#toast'); return t && !t.classList.contains('hidden') ? t.textContent : ''; });
  const clickTab = async (page, v) => { await page.click(`.tab[data-view="${v}"]`); await page.waitForTimeout(v === 'map' || v === 'nearby' ? 700 : 300); };
  const openEvent = async (page) => { await page.click('.event'); await page.waitForTimeout(250); };
  // на дне: 1-е «назад» = тост, 2-е = выход
  const exitAtBottom = async (page, label) => {
    await back(page);
    assert.ok(await alive(page), `${label}: 1-е «назад» на дне НЕ вышло (страж)`);
    assert.ok(/ещё раз/.test(await toastText(page)), `${label}: тост «нажмите ещё раз»`);
    await back(page);
    assert.ok(await gone(page), `${label}: 2-е «назад» → выход`);
  };

  // ═══ BUG1: защита от выхода на СВЕЖЕМ ЗАПУСКЕ, в т.ч. во время медленной загрузки ═══
  // --- 1. свежий запуск, никуда не ходили → «назад» = тост, «назад» = выход
  {
    const { ctx, page } = await fresh();
    assert.equal(await tab(page), 'now', '1: старт «сейчас»');
    await exitAtBottom(page, '1');
    await ctx.close();
    console.log('✓ 1. свежий запуск на стартовой вкладке: «назад»=тост, «назад»=выход (не мгновенный выход)');
  }

  // --- 2. МЕДЛЕННАЯ загрузка: «назад» нажали ПОКА грузятся данные → всё равно тост,
  //        не выход (главный симптом BUG1 на реальном устройстве; страж ставится
  //        синхронно в начале boot, ДО async-загрузок)
  {
    const ctx = await mkctx();
    // тормозим данные: boot зависнет на await loadProgram/... на ~1.5с
    await ctx.route('**/data/*.json*', async route => {
      await new Promise(r => setTimeout(r, 1500));
      route.continue();
    });
    const page = await ctx.newPage();
    let exited = false;
    page.on('framenavigated', f => { if (f === page.mainFrame() && !f.url().includes(String(PORT))) exited = true; });
    await page.goto(BASE + '/', { waitUntil: 'commit' });
    await page.waitForTimeout(400); // boot стартовал, но данные ещё грузятся
    await page.evaluate(() => history.back()); await page.waitForTimeout(300);
    const toast1 = await toastText(page);
    assert.ok(/ещё раз/.test(toast1), '2: «назад» во время загрузки → ТОСТ (страж успел встать до async): ' + JSON.stringify(toast1));
    assert.ok(!exited, '2: приложение НЕ вышло с первого «назад» на медленной загрузке');
    await page.evaluate(() => history.back()); await page.waitForTimeout(400);
    assert.ok(await gone(page) || exited, '2: второе «назад» → выход');
    await ctx.close();
    console.log('✓ 2. BUG1: «назад» во время медленной загрузки → тост, не мгновенный выход');
  }

  // ═══ A. Чистые вкладки ═══
  // --- 3. прямой ход + обратная размотка + дно=тост=выход
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule'); await clickTab(page, 'favorites'); await clickTab(page, 'map'); await clickTab(page, 'nearby');
    assert.equal(await tab(page), 'nearby', '3: дошли до «рядом»');
    await back(page); assert.equal(await tab(page), 'map', '3: назад→карта');
    await back(page); assert.equal(await tab(page), 'favorites', '3: назад→избранное');
    await back(page); assert.equal(await tab(page), 'schedule', '3: назад→программа');
    await back(page); assert.equal(await tab(page), 'now', '3: назад→сейчас (дно)');
    await exitAtBottom(page, '3');
    await ctx.close();
    console.log('✓ 3. чистые вкладки: прямой ход разматывается в обратном порядке, дно=тост=выход');
  }

  // --- 4. скачки программа↔карта ×6 → «назад» НЕ требует много нажатий (схлопывание)
  {
    const { ctx, page } = await fresh();
    for (let i = 0; i < 6; i++) { await clickTab(page, i % 2 ? 'map' : 'schedule'); }
    // сейчас на карте (i=5 нечётный). стек: now→schedule→map схлопнут до 2 записей максимум
    assert.equal(await tab(page), 'map', '4: на карте после скачков');
    await back(page); assert.equal(await tab(page), 'schedule', '4: назад→программа (схлопнуто, не карта)');
    await back(page); assert.equal(await tab(page), 'now', '4: назад→сейчас');
    await exitAtBottom(page, '4');
    await ctx.close();
    console.log('✓ 4. скачки программа↔карта ×6: «назад» разматывает за 2 шага (схлопывание, не 6)');
  }

  // --- 5. повторный тап той же вкладки → стек не растёт (дедуп)
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule'); await clickTab(page, 'schedule'); await clickTab(page, 'schedule');
    await back(page); assert.equal(await tab(page), 'now', '5: один «назад» = «сейчас» (дедуп, не 3 записи)');
    await exitAtBottom(page, '5');
    await ctx.close();
    console.log('✓ 5. повтор той же вкладки не растит стек (дедуп)');
  }

  // ═══ B. Модалки на разных вкладках; крестик == «назад» ═══
  // --- 6. фильтры на программе: «назад» и крестик дают одно, стек чист
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule');
    // «назад» закрывает фильтры
    await page.click('#btnFilter'); await page.waitForTimeout(250);
    assert.ok(await vis(page, '#filterSheet'), '6: фильтры открыты');
    await back(page);
    assert.ok(!(await vis(page, '#filterSheet')) && await tab(page) === 'schedule', '6: «назад» закрыл фильтры, остались в программе');
    // крестик закрывает так же
    await page.click('#btnFilter'); await page.waitForTimeout(250);
    await page.click('#filterSheet .sheet-titlebar .icon-btn[data-close]'); await page.waitForTimeout(250);
    assert.ok(!(await vis(page, '#filterSheet')), '6: крестик закрыл фильтры');
    await back(page); assert.equal(await tab(page), 'now', '6: стек чист — «назад» ушёл на «сейчас»');
    await exitAtBottom(page, '6');
    await ctx.close();
    console.log('✓ 6. фильтры: «назад»==крестик, стек чист после обоих');
  }

  // --- 7. избранное → открыть событие → «назад» (закрылось описание, в избранном)
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule'); // события есть в программе; избранное может быть пусто
    await openEvent(page);
    assert.ok(await vis(page, '#sheet'), '7: описание события открыто');
    await back(page);
    assert.ok(!(await vis(page, '#sheet')) && await tab(page) === 'schedule', '7: «назад» закрыл описание, в программе');
    await back(page); assert.equal(await tab(page), 'now', '7: «назад» → сейчас (вкладочный слой)');
    await exitAtBottom(page, '7');
    await ctx.close();
    console.log('✓ 7. событие → «назад» закрывает описание, остаёмся во вкладке');
  }

  // ═══ C. Событие ↔ карта (болезненный узел) ═══
  const openEventWithGeo = async (page) => {
    await clickTab(page, 'schedule');
    const n = await page.evaluate(() => document.querySelectorAll('.event .event-main').length);
    for (let i = 0; i < n; i++) {
      await page.evaluate(idx => document.querySelectorAll('.event .event-main')[idx].click(), i);
      await page.waitForTimeout(140);
      if (await page.evaluate(() => !!document.querySelector('#sheet .geo-jump'))) return true;
      await page.click('#sheet .sheet-titlebar .icon-btn[data-close]'); await page.waitForTimeout(100);
    }
    return false;
  };
  // --- 8. программа→событие→на карте→назад=СОБЫТИЕ→назад=программа→...→дно→тост→выход
  {
    const { ctx, page } = await fresh();
    assert.ok(await openEventWithGeo(page), '8: нашли событие с «на карте»');
    await page.click('#sheet .geo-jump'); await page.waitForTimeout(600);
    assert.ok(await tab(page) === 'map' && !(await vis(page, '#sheet')), '8: на карте, описание усыплено');
    await back(page); assert.ok(await vis(page, '#sheet'), '8: назад#1 = СНОВА ОПИСАНИЕ (не проскок)');
    await back(page); assert.ok(!(await vis(page, '#sheet')) && await tab(page) === 'schedule', '8: назад#2 = программа');
    await back(page); assert.equal(await tab(page), 'now', '8: назад#3 = сейчас (вкладочный слой под описанием)');
    await exitAtBottom(page, '8');
    await ctx.close();
    console.log('✓ 8. событие↔карта: каждый «назад» = один слой, без проскоков и раннего выхода');
  }

  // --- 9. повторный цикл событие→карта→назад→событие→карта→назад не ломает стек
  {
    const { ctx, page } = await fresh();
    assert.ok(await openEventWithGeo(page), '9: событие с «на карте»');
    for (let k = 0; k < 3; k++) {
      await page.click('#sheet .geo-jump'); await page.waitForTimeout(500);
      assert.ok(await tab(page) === 'map', `9: цикл ${k} на карте`);
      await back(page);
      assert.ok(await vis(page, '#sheet'), `9: цикл ${k} назад вернул описание`);
    }
    await back(page); assert.ok(!(await vis(page, '#sheet')) && await tab(page) === 'schedule', '9: описание закрылось, программа');
    await back(page); assert.equal(await tab(page), 'now', '9: сейчас');
    await exitAtBottom(page, '9');
    await ctx.close();
    console.log('✓ 9. повторный цикл событие↔карта (×3) не ломает стек');
  }

  // --- 10. карта НАПРЯМУЮ (вкладкой) → «назад» штатно, без призрачного описания
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'map');
    await back(page);
    assert.ok(await alive(page) && !(await vis(page, '#sheet')), '10: карта вкладкой → «назад» без призрачного описания');
    assert.equal(await tab(page), 'now', '10: вернулись на «сейчас»');
    await exitAtBottom(page, '10');
    await ctx.close();
    console.log('✓ 10. карта вкладкой → «назад» штатный, без призрачного описания');
  }

  // ═══ D. Глубокие смешанные цепочки ═══
  // --- 11. сейчас→программа→событие→карта→назад→событие→назад→программа→фильтры→
  //         назад→программа→назад→сейчас→дно→тост→выход. КАЖДЫЙ назад = один слой.
  {
    const { ctx, page } = await fresh();
    assert.ok(await openEventWithGeo(page), '11: событие с «на карте»'); // now→schedule→#sheet
    await page.click('#sheet .geo-jump'); await page.waitForTimeout(600); // +карта-оверлей
    await back(page); assert.ok(await vis(page, '#sheet'), '11: назад→описание');
    await back(page); assert.ok(!(await vis(page, '#sheet')) && await tab(page) === 'schedule', '11: назад→программа');
    await page.click('#btnFilter'); await page.waitForTimeout(250); // +фильтры
    assert.ok(await vis(page, '#filterSheet'), '11: фильтры открыты');
    await back(page); assert.ok(!(await vis(page, '#filterSheet')) && await tab(page) === 'schedule', '11: назад закрыл фильтры, в программе');
    await back(page); assert.equal(await tab(page), 'now', '11: назад→сейчас');
    await exitAtBottom(page, '11');
    await ctx.close();
    console.log('✓ 11. глубокая цепочка (вкладки+событие→карта+фильтры): каждый «назад» = один слой до выхода');
  }

  // --- 12. избранное→программа→событие→на карте→ФОРМА МЕТКИ→назад→карта→назад→
  //         событие→назад→программа→назад→избранное→назад→сейчас→дно→тост→выход
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'favorites');                       // now→favorites
    assert.ok(await openEventWithGeo(page), '12: событие с «на карте»'); // favorites→schedule→#sheet
    await page.click('#sheet .geo-jump'); await page.waitForTimeout(600); // +карта-оверлей
    await page.click('#btnAddPin'); await page.waitForTimeout(250);        // +меню метки (модалка на карте)
    assert.ok(await vis(page, '#pinAddMenu'), '12: меню метки открыто на карте');
    await back(page); assert.ok(!(await vis(page, '#pinAddMenu')) && await tab(page) === 'map', '12: назад закрыл меню метки, на карте');
    await back(page); assert.ok(await vis(page, '#sheet') && await tab(page) === 'schedule', '12: назад→описание (восстановлено над своим видом=программа)');
    await back(page); assert.ok(!(await vis(page, '#sheet')) && await tab(page) === 'schedule', '12: назад закрыл описание, в программе');
    await back(page); assert.equal(await tab(page), 'favorites', '12: назад→избранное');
    await back(page); assert.equal(await tab(page), 'now', '12: назад→сейчас');
    await exitAtBottom(page, '12');
    await ctx.close();
    console.log('✓ 12. глубокая цепочка (избранное+событие→карта+форма метки): размотка послойно до выхода');
  }

  // ═══ E. Пограничное ═══
  // --- 13. свежий запуск→назад→тост→ждать >2с→назад→снова тост (окно истекло, не выход)
  {
    const { ctx, page } = await fresh();
    await back(page); assert.ok(/ещё раз/.test(await toastText(page)) && await alive(page), '13: назад#1 → тост');
    await page.waitForTimeout(2300); // окно ~2с истекло
    await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.classList.add('hidden'); });
    await back(page);
    assert.ok(await alive(page), '13: после истечения окна «назад» снова НЕ вышло');
    assert.ok(/ещё раз/.test(await toastText(page)), '13: снова тост (окно сброшено, не выход с первого)');
    await back(page); assert.ok(await gone(page), '13: следующее «назад» в окне → выход');
    await ctx.close();
    console.log('✓ 13. окно истекло → следующее «назад» снова тост (не выход с первого)');
  }

  // --- 14. тост выхода НЕ появляется при открытой модалке (защита только на дне)
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule');
    await page.click('#btnFilter'); await page.waitForTimeout(250);
    await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.classList.add('hidden'); });
    await back(page); // закрывает фильтры, НЕ выход, НЕ тост
    assert.ok(!(await vis(page, '#filterSheet')), '14: фильтры закрылись');
    assert.ok(!/ещё раз/.test(await toastText(page)), '14: тоста выхода НЕТ при закрытии модалки (не на дне)');
    await ctx.close();
    console.log('✓ 14. тост выхода не появляется при закрытии модалки (только на дне)');
  }

  // --- 15. фильтры (sessionStorage) переживают переходы по вкладкам
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule');
    // применим тип-фильтр (день/чип) — просто кликнем тип-чип, если есть
    const setType = await page.evaluate(() => { const c = document.querySelector('#filters .chip:not(.active):not(.filter-chip-btn)'); if (c) { c.click(); return c.textContent; } return null; });
    await page.waitForTimeout(200);
    await clickTab(page, 'map'); await clickTab(page, 'schedule');
    const stillActive = await page.evaluate(t => { const chips = [...document.querySelectorAll('#filters .chip')]; const c = chips.find(x => x.textContent === t); return c ? c.classList.contains('active') : null; }, setType);
    if (setType !== null) assert.ok(stillActive, '15: тип-фильтр пережил переход вкладок');
    await ctx.close();
    console.log('✓ 15. фильтры переживают переходы по вкладкам (sessionStorage)');
  }

  await browser.close();
  killSrv();
  console.log('\n=== АУДИТ НАВИГАЦИИ (МАТРИЦА A–F): ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
