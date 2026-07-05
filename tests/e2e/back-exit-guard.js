'use strict';
/* Защита от случайного выхода (#66): на ДНЕ навигации (стартовая вкладка, 0
   модалок) первое «назад» показывает тост «нажмите ещё раз, чтобы выйти» и НЕ
   выходит; второе «назад» в окне ~2с — выход; окно истекло — сброс (снова тост,
   не молчаливый выход). Срабатывает ТОЛЬКО на дне: пока есть модалка/вкладка
   куда вернуться — обычное поведение без тоста. Каждый сценарий — свежий контекст
   (пустой sessionStorage → старт «сейчас», чистая история). Приоритет Android
   (аппаратный «назад»); на iOS-свайпе окно то же. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8179;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const { spawn } = require('child_process');
  let srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);

  const fresh = async () => {
    const ctx = await browser.newContext({
      viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
      geolocation: { latitude: 54.68025, longitude: 35.08971 }, permissions: ['geolocation'],
    });
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
    await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(650); // +страж выхода (setTimeout 0)
    await page.evaluate(() => { window.__alive = 'festa'; });
    return { ctx, page };
  };
  const back = async (page) => { await page.evaluate(() => history.back()); await page.waitForTimeout(400); };
  const alive = (page) => page.evaluate(() => window.__alive === 'festa' && !!document.querySelector('#tabs'));
  const activeTab = (page) => page.evaluate(() => { const a = document.querySelector('.tab.active'); return a ? a.dataset.view : null; });
  const vis = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);
  const toastText = (page) => page.evaluate(() => { const t = document.querySelector('#toast'); return t && !t.classList.contains('hidden') ? t.textContent : null; });
  const clickTab = async (page, v) => { await page.click(`.tab[data-view="${v}"]`); await page.waitForTimeout(300); };
  const hideToast = (page) => page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.classList.add('hidden'); });

  // --- 1. на дне: 1-е «назад» → тост + остались; 2-е «назад» в окне → выход
  {
    const { ctx, page } = await fresh();
    assert.equal(await activeTab(page), 'now', 'старт на дне «сейчас»');
    await back(page);
    assert.ok(await alive(page), '1: 1-е «назад» НЕ вышло (страж выхода)');
    const tt = await toastText(page);
    assert.ok(tt && /ещё раз/.test(tt), `1: показан тост «нажмите ещё раз» (${tt})`);
    await back(page);
    assert.ok(!(await alive(page)), '1: 2-е «назад» в окне → выход');
    await ctx.close();
    console.log('✓ 1. дно: 1-е «назад» = тост «нажмите ещё раз», 2-е «назад» = выход');
  }

  // --- 2. окно истекло → сброс: 1-е тост; ждём >2с; 2-е снова тост (не выход); 3-е выход
  {
    const { ctx, page } = await fresh();
    await back(page);
    assert.ok((await toastText(page) || '').match(/ещё раз/), '2: 1-е «назад» → тост');
    await page.waitForTimeout(2300); // окно ~2с истекло → страж восстановлен, флаг сброшен
    await hideToast(page);           // убрать прошлый тост, чтобы проверить свежий
    await back(page);
    assert.ok(await alive(page), '2: после истечения окна «назад» снова НЕ вышло (сброс)');
    assert.ok((await toastText(page) || '').match(/ещё раз/), '2: показан СВЕЖИЙ тост (окно сброшено, не выход)');
    await back(page);
    assert.ok(!(await alive(page)), '2: 3-е «назад» (в новом окне) → выход');
    await ctx.close();
    console.log('✓ 2. окно ~2с истекло → сброс: следующее «назад» снова тост, не молчаливый выход');
  }

  // --- 3. НЕ на дне (модалка): «назад» закрывает модалку БЕЗ тоста; на дне — тост
  {
    const { ctx, page } = await fresh();
    await page.evaluate(() => showSheet('#settings')); await page.waitForTimeout(200);
    assert.ok(await vis(page, '#settings'), '3: модалка настроек открыта');
    await hideToast(page);
    await back(page);
    assert.ok(!(await vis(page, '#settings')) && await alive(page), '3: «назад» закрыл модалку, остались в приложении');
    assert.ok(!/ещё раз/.test(await toastText(page) || ''), '3: при закрытии модалки тоста выхода НЕТ (не на дне)');
    await back(page);
    assert.ok((await toastText(page) || '').match(/ещё раз/) && await alive(page), '3: теперь на дне — «назад» показал тост выхода');
    await ctx.close();
    console.log('✓ 3. модалка открыта → «назад» закрывает её без тоста; тост только на дне');
  }

  // --- 4. НЕ на дне (вкладка): «назад» = переход по вкладкам без тоста; на дне — тост+выход
  {
    const { ctx, page } = await fresh();
    await clickTab(page, 'schedule');
    await hideToast(page);
    await back(page);
    assert.ok(await activeTab(page) === 'now' && await alive(page), '4: «назад» вернул на предыдущую вкладку «сейчас»');
    assert.ok(!/ещё раз/.test(await toastText(page) || ''), '4: смена вкладки «назад» БЕЗ тоста выхода');
    await back(page);
    assert.ok((await toastText(page) || '').match(/ещё раз/) && await alive(page), '4: на дне «назад» → тост выхода');
    await back(page);
    assert.ok(!(await alive(page)), '4: 2-е «назад» в окне → выход');
    await ctx.close();
    console.log('✓ 4. вкладка → «назад» переход без тоста; на дне тост, второе «назад» выходит');
  }

  // --- 5. страж восстановлен после взаимодействия в окне (не молчаливый выход)
  {
    const { ctx, page } = await fresh();
    await back(page); // 1-е «назад» на дне: тост, окно открыто, страж съеден
    assert.ok((await toastText(page) || '').match(/ещё раз/), '5: 1-е «назад» → тост');
    await page.evaluate(() => showSheet('#settings')); await page.waitForTimeout(200); // взаимодействие в окне
    assert.ok(await vis(page, '#settings'), '5: открыли модалку в окне выхода');
    await page.waitForTimeout(2300); // окно истекло, пока модалка открыта (страж не ставился — не на дне)
    await back(page); // закрыть модалку → вернулись на дно → страж восстановлен (end-check)
    assert.ok(!(await vis(page, '#settings')) && await alive(page), '5: модалка закрыта, на дне');
    await hideToast(page);
    await back(page);
    assert.ok(await alive(page), '5: «назад» на дне после возврата НЕ вышло молча (страж восстановлен)');
    assert.ok((await toastText(page) || '').match(/ещё раз/), '5: снова тост выхода (страж вернулся)');
    await back(page);
    assert.ok(!(await alive(page)), '5: следующее «назад» в окне → выход');
    await ctx.close();
    console.log('✓ 5. взаимодействие в окне + возврат на дно → страж восстановлен, нет молчаливого выхода');
  }

  // --- 6. офлайн: защита работает без сети
  {
    const { ctx, page } = await fresh();
    killSrv(); await page.waitForTimeout(300); // РЕАЛЬНЫЙ офлайн
    await back(page);
    assert.ok(await alive(page), '6: офлайн — 1-е «назад» НЕ вышло');
    assert.ok((await toastText(page) || '').match(/ещё раз/), '6: офлайн — тост выхода показан');
    await back(page);
    assert.ok(!(await alive(page)), '6: офлайн — 2-е «назад» → выход');
    await ctx.close();
    console.log('✓ 6. офлайн: защита от случайного выхода работает без сети');
  }

  await browser.close();
  killSrv();
  console.log('\n=== ЗАЩИТА ОТ СЛУЧАЙНОГО ВЫХОДА: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
