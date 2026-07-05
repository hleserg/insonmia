'use strict';
/* Вкладки живут в ЕДИНОМ history-стеке с модалками: «назад» = обратный переход
   по вкладкам. Матрица #65: прямой ход разматывается в обратном порядке; дедуп
   подряд (тот же таб не плодит записей); возврат на посещённую вкладку схлопывает
   до неё; стартовая вкладка = дно стека (там «назад» = штатный выход); модалки/
   событие→карта/фильтры поверх вкладок не ломаются. Каждый сценарий — СВЕЖИЙ
   контекст: пустой sessionStorage → старт всегда «сейчас», чистая история браузера
   → точный подсчёт «назад» до выхода. Офлайн-паритет проверяют соседние сьюты. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8178;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const { spawn } = require('child_process');
  let srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);

  // свежий контекст на КАЖДЫЙ сценарий: пустой sessionStorage (старт = «сейчас»)
  // + чистая история браузера (первый «назад» с дна = выход из приложения)
  const fresh = async () => {
    const ctx = await browser.newContext({
      viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
      geolocation: { latitude: 54.68025, longitude: 35.08971 }, permissions: ['geolocation'],
    });
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
    await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(600);
    await page.evaluate(() => { window.__alive = 'festa'; });
    return { ctx, page };
  };
  const back = async (page) => { await page.evaluate(() => history.back()); await page.waitForTimeout(400); };
  const clickTab = async (page, v) => { await page.click(`.tab[data-view="${v}"]`); await page.waitForTimeout(v === 'map' || v === 'nearby' ? 700 : 300); };
  const alive = (page) => page.evaluate(() => window.__alive === 'festa' && !!document.querySelector('#tabs'));
  const activeTab = (page) => page.evaluate(() => { const a = document.querySelector('.tab.active'); return a ? a.dataset.view : null; });
  const vis = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);
  const toastText = (page) => page.evaluate(() => { const t = document.querySelector('#toast'); return t && !t.classList.contains('hidden') ? t.textContent : null; });
  // на ДНЕ стека выход = двойное «назад» (#66): 1-е «назад» — тост «нажмите ещё
  // раз» и остаёмся; 2-е «назад» в окне — выход. Заменяет прежний одиночный выход.
  const exitAtBottom = async (page, label) => {
    await back(page);
    const tt = await toastText(page);
    assert.ok(await alive(page), `${label}: 1-е «назад» на дне НЕ вышло (страж выхода)`);
    assert.ok(tt && /ещё раз/.test(tt), `${label}: тост «нажмите назад ещё раз» (${tt})`);
    await back(page);
    assert.ok(!(await alive(page)), `${label}: 2-е «назад» в окне → выход`);
  };

  // --- 1. прямой ход по вкладкам → «назад» разматывает в обратном порядке
  {
    const { ctx, page } = await fresh();
    assert.equal(await activeTab(page), 'now', 'старт = «сейчас»');
    await clickTab(page, 'schedule');
    await clickTab(page, 'favorites');
    await clickTab(page, 'map');
    assert.equal(await activeTab(page), 'map', 'дошли до «карты»');
    await back(page); assert.equal(await activeTab(page), 'favorites', 'назад#1 → избранное');
    await back(page); assert.equal(await activeTab(page), 'schedule', 'назад#2 → программа');
    await back(page); assert.equal(await activeTab(page), 'now', 'назад#3 → сейчас (дно)');
    assert.ok(await alive(page), 'на дне ещё живы');
    await exitAtBottom(page, '1');
    await ctx.close();
    console.log('✓ 1. прямой ход now→schedule→favorites→map, «назад» разматывает в обратном порядке до выхода');
  }

  // --- 2. дедуп подряд: повторный клик по той же вкладке не плодит записей
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule');
    await clickTab(page, 'schedule'); // тот же таб дважды — без новой записи
    await clickTab(page, 'schedule');
    assert.equal(await activeTab(page), 'schedule', 'на программе');
    await back(page);
    assert.equal(await activeTab(page), 'now', 'один «назад» = сразу «сейчас» (дедуп: не 3 записи schedule)');
    await ctx.close();
    console.log('✓ 2. дедуп подряд: повтор той же вкладки не плодит записей истории');
  }

  // --- 3. возврат на посещённую вкладку СХЛОПЫВАЕТ стек до неё (без петли)
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule');
    await clickTab(page, 'favorites');
    await clickTab(page, 'schedule'); // возврат на schedule → схлопнуть, favorites-шаг убрать
    await page.waitForTimeout(300);   // дать микротаск-триму истории отработать
    assert.equal(await activeTab(page), 'schedule', 'вернулись на программу');
    await back(page);
    assert.equal(await activeTab(page), 'now', 'назад → «сейчас» (схлопнули, favorites НЕ всплыл)');
    assert.ok(await alive(page), 'живы');
    await exitAtBottom(page, '3');
    await ctx.close();
    console.log('✓ 3. возврат на посещённую вкладку схлопывает стек до неё (нет петли favorites)');
  }

  // --- 4. стартовая вкладка = дно: без переходов «назад» = штатный выход
  {
    const { ctx, page } = await fresh();
    assert.equal(await activeTab(page), 'now', 'на старте «сейчас»');
    assert.ok(await alive(page), 'живы');
    await exitAtBottom(page, '4');
    await ctx.close();
    console.log('✓ 4. стартовая вкладка = дно стека: «назад» = тост, второе «назад» выходит');
  }

  // --- 5. модалка описания ПОВЕРХ вкладок в едином стеке: «назад» снимает слои
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule');
    await page.click('.event'); await page.waitForTimeout(250);
    assert.ok(await vis(page, '#sheet'), 'описание открыто поверх «программы»');
    await back(page);
    assert.ok(!(await vis(page, '#sheet')) && await activeTab(page) === 'schedule', 'назад#1 закрыл описание, остались на программе');
    await back(page);
    assert.equal(await activeTab(page), 'now', 'назад#2 → «сейчас» (вкладочный слой под описанием)');
    await exitAtBottom(page, '5');
    await ctx.close();
    console.log('✓ 5. описание поверх вкладок: «назад» снимает описание → вкладку → выход (единый стек)');
  }

  // --- 6. событие → «на карте» в единый стек: карта-слой не плодит tab-запись
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule');
    // найти событие с кнопкой «на карте»
    const n = await page.evaluate(() => document.querySelectorAll('.event .event-main').length);
    let opened = false;
    for (let i = 0; i < n; i++) {
      await page.evaluate(idx => document.querySelectorAll('.event .event-main')[idx].click(), i);
      await page.waitForTimeout(140);
      if (await page.evaluate(() => !!document.querySelector('#sheet .geo-jump'))) { opened = true; break; }
      await page.click('#sheet .sheet-titlebar .icon-btn[data-close]'); await page.waitForTimeout(100);
    }
    assert.ok(opened, 'нашли событие с кнопкой «на карте»');
    await page.click('#sheet .geo-jump'); await page.waitForTimeout(600);
    assert.ok(await activeTab(page) === 'map' && !(await vis(page, '#sheet')), 'на карте, описание усыплено');
    await back(page);
    assert.ok(await vis(page, '#sheet'), 'назад#1 вернул описание (карта — nav-слой, не tab-запись)');
    await back(page);
    assert.ok(!(await vis(page, '#sheet')) && await activeTab(page) === 'schedule', 'назад#2 закрыл описание, на программе');
    await back(page);
    assert.equal(await activeTab(page), 'now', 'назад#3 → «сейчас» (вкладочный слой)');
    await exitAtBottom(page, '6');  // событие→карта НЕ добавила лишнюю tab-запись → дно ровно тут
    await ctx.close();
    console.log('✓ 6. событие→карта: карта — nav-слой, не плодит tab-запись; выход ровно на дне');
  }

  // --- 7. фильтры (модалка) поверх вкладок: «назад» закрывает фильтры, потом вкладки
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule');
    await page.click('#btnFilter'); await page.waitForTimeout(250);
    assert.ok(await vis(page, '#filterSheet'), 'фильтры открылись');
    await back(page);
    assert.ok(!(await vis(page, '#filterSheet')) && await activeTab(page) === 'schedule', 'назад#1 закрыл фильтры, на программе');
    await back(page);
    assert.equal(await activeTab(page), 'now', 'назад#2 → «сейчас»');
    await exitAtBottom(page, '7');
    await ctx.close();
    console.log('✓ 7. фильтры поверх вкладок: «назад» снимает модалку, затем разматывает вкладки');
  }

  // --- 8. возврат на СТАРТОВУЮ вкладку схлопывает весь стек → «назад» сразу выход
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule');
    await clickTab(page, 'favorites');
    await clickTab(page, 'map');
    await clickTab(page, 'now'); // возврат на дно → схлопнуть ВСЁ
    await page.waitForTimeout(300);
    assert.equal(await activeTab(page), 'now', 'вернулись на стартовую «сейчас»');
    assert.ok(await alive(page), 'живы (на дне)');
    // весь промежуточный стек схлопнут → выход ровно двойным «назад» (тост+выход),
    // без 3 холостых нажатий на промежуточные {tab}-записи
    await exitAtBottom(page, '8');
    await ctx.close();
    console.log('✓ 8. возврат на стартовую вкладку схлопывает весь стек — «назад» сразу выходит');
  }

  // --- 9. длинная смешанная цепочка: дедуп + схлопывание вместе, ровный выход
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule');
    await clickTab(page, 'schedule');  // дедуп (нет записи)
    await clickTab(page, 'map');
    await clickTab(page, 'nearby');
    await clickTab(page, 'map');        // возврат на map → схлопнуть nearby
    await page.waitForTimeout(300);
    assert.equal(await activeTab(page), 'map', 'на «карте» после схлопывания nearby');
    await back(page); assert.equal(await activeTab(page), 'schedule', 'назад#1 → программа (nearby схлопнут)');
    await back(page); assert.equal(await activeTab(page), 'now', 'назад#2 → сейчас (schedule без дублей)');
    await exitAtBottom(page, '9');
    await ctx.close();
    console.log('✓ 9. смешанная цепочка (дедуп + схлопывание) разматывается ровно, без лишних «назад»');
  }

  // --- 10. РЕГРЕСС verify #65: событие→карта НЕ плодит дубль {tab:map} → нет
  //         мёртвого «назад». Путь: карта→программа→событие→«на карте»→программа→
  //         карта→назад ДОЛЖЕН сразу сменить экран (а не остаться на карте).
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'map');         // [{tab:now}], view=map
    await clickTab(page, 'schedule');    // [{tab:now},{tab:map}], view=schedule
    // открыть событие с кнопкой «на карте»
    const n = await page.evaluate(() => document.querySelectorAll('.event .event-main').length);
    let opened = false;
    for (let i = 0; i < n; i++) {
      await page.evaluate(idx => document.querySelectorAll('.event .event-main')[idx].click(), i);
      await page.waitForTimeout(140);
      if (await page.evaluate(() => !!document.querySelector('#sheet .geo-jump'))) { opened = true; break; }
      await page.click('#sheet .sheet-titlebar .icon-btn[data-close]'); await page.waitForTimeout(100);
    }
    assert.ok(opened, '10: нашли событие с кнопкой «на карте»');
    await page.click('#sheet .geo-jump'); await page.waitForTimeout(600); // событие→карта (оверлей)
    assert.ok(await activeTab(page) === 'map' && !(await vis(page, '#sheet')), '10: на карте-оверлее');
    await clickTab(page, 'schedule');    // уход с оверлея ВКЛАДКОЙ: state.view вернётся под оверлей
    assert.ok(await activeTab(page) === 'schedule' && !(await vis(page, '#sheet')), '10: ушли на программу, дубль {tab:map} не создан');
    await clickTab(page, 'map');         // возврат на карту — схлопнуть до одной записи map
    assert.equal(await activeTab(page), 'map', '10: снова на карте');
    await back(page);
    // ключевая проверка: «назад» СРАЗУ уводит с карты (не мёртвое нажатие)
    assert.ok(await activeTab(page) !== 'map', '10: «назад» СРАЗУ сменил экран (нет мёртвого нажатия из дубля {tab:map})');
    assert.equal(await activeTab(page), 'now', '10: «назад» вернул на стартовую «сейчас»');
    assert.ok(await alive(page), '10: живы');
    await exitAtBottom(page, '10');
    await ctx.close();
    console.log('✓ 10. verify #65: событие→карта не плодит дубль {tab:map}, «назад» без мёртвого нажатия');
  }

  await browser.close();
  killSrv();
  console.log('\n=== ВКЛАДКИ В ЕДИНОМ HISTORY-СТЕКЕ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
