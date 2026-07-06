'use strict';
/* Раздел «Сейчас» сам отрабатывает НАСТУПЛЕНИЕ и ход фестивальных дней.
   Гоняем реальный DOM через page.clock на ключевых моментах (МСК-логика в
   контексте UTC — доказываем независимость от таймзоны устройства):
   до феста → наступление 9-го → внутри → cutoff 06:00 (ночь 12→13) →
   после феста; отдельно — АВТО-переключение активного дня по ходу часов без
   единого клика (30-сек tick). Активный день полосы = индекс кнопки .active. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8231;
const BASE = `http://127.0.0.1:${PORT}`;
const PROG = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'program.json'), 'utf8'));
const DAYS = [...new Set(PROG.events.map(e => e.date).filter(Boolean))].sort();
// МСК-эпоха: наивная московская ISO минус 3 часа (как epochFromISO в core.js)
const MSK = (y, mo, d, h, mi = 0) => Date.UTC(y, mo, d, h, mi) - 3 * 3600 * 1000;

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);

  // индекс активного дня в полосе + факт наличия live-группы и баннеров «сейчас»
  async function snapshot(page) {
    return page.evaluate(() => {
      const btns = [...document.querySelectorAll('#dayStrip .day-btn')];
      const activeIdx = btns.findIndex(b => b.classList.contains('active'));
      const body = document.body.innerText;
      return {
        nBtns: btns.length,
        activeIdx,
        activeText: activeIdx >= 0 ? btns[activeIdx].innerText.replace(/\s+/g, ' ').trim() : null,
        hasLive: /Идёт сейчас/i.test(body),
        hasNext: /Далее/i.test(body),
        prestart: /до старта/i.test(body),
        ended: /Фестиваль завершён/i.test(body),
      };
    });
  }

  // открыть приложение в контексте UTC с зафиксированным МСК-моментом
  async function openAt(ms) {
    const ctx = await browser.newContext({
      viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
    });
    const page = await ctx.newPage();
    await page.clock.install({ time: ms });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    // «Сейчас» — вкладка по умолчанию; на всякий случай кликнем
    await page.click('.tab[data-view="now"]');
    await page.waitForTimeout(200);
    return { ctx, page, errs };
  }

  const idxOf = (d) => DAYS.indexOf(d);
  let ok = 0;
  const check = (cond, msg) => { assert.ok(cond, msg); ok++; console.log('  ✓ ' + msg); };

  // --- 1. ДО феста (6 июля 12:00): предстарт, без live, полоса не подсвечена
  {
    const { ctx, page, errs } = await openAt(MSK(2026, 6, 6, 12));
    const s = await snapshot(page);
    check(s.prestart, '1. до феста: баннер «до старта»');
    check(!s.hasLive, '1. до феста: НЕТ группы «Идёт сейчас»');
    check(s.activeIdx === -1, '1. до феста: полоса дней не подсвечена');
    check(s.hasNext, '1. до феста: есть «Далее» (программа впереди)');
    check(errs.length === 0, '1. без ошибок страницы');
    await ctx.close();
  }

  // --- 2. НАСТУПЛЕНИЕ 9-го: 06:00 фест-суточный рубеж → активна «чт 9»
  {
    const { ctx, page } = await openAt(MSK(2026, 6, 9, 6));
    const s = await snapshot(page);
    check(s.activeIdx === idxOf('2026-07-09'), '2. 09.07 06:00: активна вкладка «чт 9 июл» САМА (idx ' + s.activeIdx + ', «' + s.activeText + '»)');
    check(!s.hasLive, '2. 09.07 06:00: событий ещё нет (первое 10:00)');
    await ctx.close();
  }
  // --- 2b. Первое событие 09.07 10:05 → live появился, баннер снят
  {
    const { ctx, page } = await openAt(MSK(2026, 6, 9, 10, 5));
    const s = await snapshot(page);
    check(s.activeIdx === idxOf('2026-07-09'), '2b. 09.07 10:05: активна «чт 9»');
    check(s.hasLive, '2b. 09.07 10:05: появилась группа «Идёт сейчас»');
    check(!s.prestart, '2b. 09.07 10:05: баннер «до старта» снят');
    await ctx.close();
  }

  // --- 3. ВНУТРИ феста: каждый день днём активна своя вкладка
  for (const d of DAYS) {
    const [Y, M, D] = d.split('-').map(Number);
    const { ctx, page } = await openAt(MSK(Y, M - 1, D, 14));
    const s = await snapshot(page);
    check(s.activeIdx === idxOf(d), `3. ${d} 14:00: активна вкладка этого дня`);
    check(!s.prestart && !s.ended, `3. ${d} 14:00: внутри феста, без баннеров границ`);
    await ctx.close();
  }

  // --- 4a. Cutoff: ночь 12→13, 13.07 02:00 → активен фестдень «вс 12», не 13-й
  {
    const { ctx, page } = await openAt(MSK(2026, 6, 13, 2));
    const s = await snapshot(page);
    check(s.activeIdx === idxOf('2026-07-12'), '4a. 13.07 02:00: активен фестдень «вс 12» (не перескочил на 13-й)');
    check(s.activeIdx !== idxOf('2026-07-13'), '4a. 13.07 02:00: НЕ активен пустой 13-й');
    await ctx.close();
  }
  // --- 4b. Переход 06:00 утра 13-го → активный день сдвинулся на 13-й
  {
    const { ctx, page } = await openAt(MSK(2026, 6, 13, 6));
    const s = await snapshot(page);
    check(s.activeIdx === idxOf('2026-07-13'), '4b. 13.07 06:00: активный день сдвинулся на «пн 13»');
    await ctx.close();
  }
  // --- 4c. Последний день в ночи (14.07 02:00) → ещё фестдень 13, без выхода за диапазон
  {
    const { ctx, page } = await openAt(MSK(2026, 6, 14, 2));
    const s = await snapshot(page);
    check(s.activeIdx === idxOf('2026-07-13'), '4c. 14.07 02:00: подсветка на последнем дне «пн 13», не за диапазоном');
    await ctx.close();
  }

  // --- 5. ПОСЛЕ феста (14.07 08:00): «завершён», без падений и live
  {
    const { ctx, page, errs } = await openAt(MSK(2026, 6, 14, 8));
    const s = await snapshot(page);
    check(s.ended, '5. после феста: баннер «Фестиваль завершён»');
    check(!s.hasLive && !s.hasNext, '5. после феста: нет live/«Далее»');
    check(s.activeIdx === -1, '5. после феста: полоса дней не подсвечена');
    check(errs.length === 0, '5. после феста: без ошибок страницы');
    await ctx.close();
  }

  // --- 6. АВТО-переключение по ходу часов БЕЗ клика: 13.07 05:59:30 → +40с → 13-й
  {
    const { ctx, page } = await openAt(MSK(2026, 6, 13, 5, 59)); // 05:59:00
    let s = await snapshot(page);
    check(s.activeIdx === idxOf('2026-07-12'), '6. 05:59: активен «вс 12» (до рубежа)');
    // прокручиваем часы на 70с — минуем 06:00 и хотя бы один 30-сек tick(); НЕ кликаем
    await page.clock.runFor(70000);
    await page.waitForTimeout(300);
    s = await snapshot(page);
    check(s.activeIdx === idxOf('2026-07-13'), '6. +70с (06:00 пройден): активный день САМ сдвинулся на «пн 13» без клика');
    await ctx.close();
  }

  await browser.close();
  killSrv();
  console.log(`\n=== «СЕЙЧАС»: НАСТУПЛЕНИЕ ФЕСТ-ДНЕЙ — ВСЁ ОК (${ok} проверок) ===`);
  process.exit(0);
})().catch(e => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
