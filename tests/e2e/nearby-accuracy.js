'use strict';
/* «Рядом» адаптируется под РЕАЛЬНУЮ точность GPS (core.accuracyProfile):
   - динамические радиусы по accuracy (≤50 / 50–200 / >200);
   - честная строка «GPS: ±N», дистанции с ~ при большой погрешности;
   - >1000 м → «рядом» не работает, честно шлём на карту;
   - радиусы адаптируются при СМЕНЕ категории, но не «дёргаются» внутри неё;
   - работает офлайн. Точность фикса задаём мок-геолокацией window.__fireGeoAcc. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8241;
const BASE = `http://127.0.0.1:${PORT}`;
const PT = [54.68025, 35.08971]; // в границах поляны — точки «рядом» найдутся

(async () => {
  const { spawn } = require('child_process');
  let srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);

  const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const fresh = async ({ clock = false, ios = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block', ...(ios ? { userAgent: IOS_UA } : {}) });
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    await ctx.addInitScript(() => {
      window.__geoCbs = [];
      window.__fireGeoAcc = (lat, lng, acc) => window.__geoCbs.forEach(cb => cb({ coords: { latitude: lat, longitude: lng, accuracy: acc } }));
      navigator.geolocation.watchPosition = (ok) => { window.__geoCbs.push(ok); return window.__geoCbs.length; };
      navigator.geolocation.clearWatch = () => {};
      if (navigator.permissions && navigator.permissions.query) navigator.permissions.query = d => d && d.name === 'geolocation' ? Promise.resolve({ state: 'granted' }) : Promise.resolve({ state: 'prompt' });
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
    if (clock) await page.clock.install({ time: new Date('2026-07-10T14:00:00Z') });
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.click('.tab[data-view="nearby"]'); await page.waitForTimeout(300);
    return { ctx, page };
  };
  const fireAcc = (page, acc) => page.evaluate((a) => window.__fireGeoAcc(a[0], a[1], a[2]), [PT[0], PT[1], acc]);
  // тексты радиус-чипов: берём ИМЕННО ряд радиусов (где есть чип «N м»),
  // не путая с рядом тип-фильтра «всё/дневная/анимация·ночь»
  const radii = (page) => page.evaluate(() => {
    const row = [...document.querySelectorAll('.chip-row')]
      .find(r => [...r.querySelectorAll('.chip')].some(c => /\d+\s*м/.test(c.innerText)));
    if (!row) return [];
    return [...row.querySelectorAll('.chip:not(.filter-chip-btn)')].map(b => b.innerText.trim());
  });
  const gpsLine = (page) => page.evaluate(() => {
    const g = document.querySelector('.gps-accuracy'); return g ? g.innerText.trim() : null; });
  const bodyText = (page) => page.evaluate(() => document.body.innerText);
  const distHasTilde = (page) => page.evaluate(() =>
    [...document.querySelectorAll('.map-point .muted.small')].some(s => /~\s*\d+\s*м/.test(s.innerText)));

  let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log('  ✓ ' + m); };

  // --- 1. accuracy 30 м → радиусы 150/300/600/всё, дистанции ТОЧНЫЕ (без ~)
  {
    const { ctx, page } = await fresh();
    await fireAcc(page, 30); await page.waitForTimeout(300);
    check(JSON.stringify(await radii(page)) === JSON.stringify(['150 м', '300 м', '600 м', 'всё']), '1. acc=30 → радиусы 150/300/600/всё');
    check(!(await distHasTilde(page)), '1. дистанции точные, без ~');
    const g = await gpsLine(page);
    check(g && /±30 м/.test(g) && !/примерные/.test(g), '1. строка «GPS: ±30 м», без «примерные»: ' + g);
    await ctx.close();
  }

  // --- 1b. мелкая точность (acc=3 м) → «±5 м», НЕ «±0 м» (нулевой погрешности нет)
  {
    const { ctx, page } = await fresh();
    await fireAcc(page, 3); await page.waitForTimeout(300);
    const g = await gpsLine(page);
    check(g && /±5 м/.test(g) && !/±0/.test(g), '1b. acc=3 → «GPS: ±5 м», не «±0 м»: ' + g);
    await ctx.close();
  }

  // --- 2. accuracy 500 м → радиусы 500/1000/2000/всё, ~-дистанции, «GPS: ±500 м»
  {
    const { ctx, page } = await fresh();
    await fireAcc(page, 500); await page.waitForTimeout(300);
    check(JSON.stringify(await radii(page)) === JSON.stringify(['500 м', '1000 м', '2000 м', 'всё']), '2. acc=500 → радиусы 500/1000/2000/всё');
    const g = await gpsLine(page);
    check(g && /±500 м/.test(g), '2. строка «GPS: ±500 м»: ' + g);
    check(/примерные/.test(g), '2. в строке помечено «дистанции примерные»');
    check(await distHasTilde(page), '2. дистанции с ~ (приблизительные)');
    check(/Порядок и дистанции примерные/.test(await bodyText(page)), '2. дисклеймер о приблизительном порядке');
    await ctx.close();
  }

  // --- 3. accuracy 1500 м → «рядом» не работает: честное сообщение + «смотреть карту»
  {
    const { ctx, page } = await fresh();
    await fireAcc(page, 1500); await page.waitForTimeout(300);
    const body = await bodyText(page);
    check(/GPS неточный/i.test(body), '3. сообщение «GPS неточный»');
    check(/±1\.5 км/.test(body), '3. показана погрешность ±1.5 км');
    check((await radii(page)).length === 0, '3. радиус-чипы скрыты (фильтровать нечестно)');
    const hasMapBtn = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => /смотреть карту/i.test(b.innerText)));
    check(hasMapBtn, '3. есть кнопка «смотреть карту»');
    // кнопка реально ведёт на карту
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /смотреть карту/i.test(b.innerText)).click());
    await page.waitForTimeout(400);
    check(await page.evaluate(() => document.querySelector('.tab[data-view="map"]').classList.contains('active')), '3. «смотреть карту» открыла карту');
    await ctx.close();
  }

  // --- 5. Плавность: троттл (10 с) гасит частые фиксы — список не «дёргается»;
  //        по прошествии интервала при СМЕНЕ категории радиусы адаптируются.
  {
    const { ctx, page } = await fresh({ clock: true });
    await fireAcc(page, 30); await page.waitForTimeout(200);
    const r1 = await radii(page);
    check(JSON.stringify(r1) === JSON.stringify(['150 м', '300 м', '600 м', 'всё']), '5. старт acc=30 → мелкие радиусы');
    // быстрый повторный фикс в пределах троттла (10 с) — ОТБРАСЫВАЕТСЯ, список цел
    await fireAcc(page, 120); await page.waitForTimeout(200);
    check(JSON.stringify(await radii(page)) === JSON.stringify(r1), '5. фикс внутри троттла (10с) не дёрнул радиусы');
    // прошёл интервал троттла — следующий фикс новой категории принят, адаптация
    await page.clock.runFor(11000);
    await fireAcc(page, 120); await page.waitForTimeout(200);
    check(JSON.stringify(await radii(page)) === JSON.stringify(['300 м', '600 м', '1000 м', 'всё']), '5. после троттла смена категории → радиусы адаптировались');
    await ctx.close();
  }

  // тексты дистанций точек «рядом» (для проверки направления)
  const distSpans = (page) => page.evaluate(() =>
    [...document.querySelectorAll('.map-point .muted.small')].map(s => s.innerText.trim()));
  const DIRS = /севернее|восточнее|южнее|западнее/;

  // --- F1. Направление показываем ТОЛЬКО при годной точности (неверная стрелка
  //         уводит не туда). acc=30 → есть сторона света; acc=500 → только «~N м».
  {
    const { ctx, page } = await fresh();
    await fireAcc(page, 30); await page.waitForTimeout(300);
    const good = await distSpans(page);
    check(good.length > 0 && good.some(t => DIRS.test(t)), 'F1. acc=30: направление («севернее» и т.п.) показано');
    check(good.every(t => !/~/.test(t)), 'F1. acc=30: дистанции точные, без ~');
    await ctx.close();
  }
  {
    const { ctx, page } = await fresh();
    await fireAcc(page, 500); await page.waitForTimeout(300);
    const coarse = await distSpans(page);
    check(coarse.length > 0, 'F1. acc=500: список «рядом» есть');
    check(coarse.every(t => !DIRS.test(t)), 'F1. acc=500: направление СКРЫТО (неверная стрелка хуже отсутствия)');
    check(coarse.every(t => /~\s*\d+\s*м/.test(t)), 'F1. acc=500: осталась только грубая дистанция «~N м»');
    await ctx.close();
  }

  // --- F3. iOS: подсказка про «Точную геопозицию» в help и в сообщении >1 км
  {
    const { ctx, page } = await fresh({ ios: true });
    await fireAcc(page, 1500); await page.waitForTimeout(300);
    check(/Точной геопозиции/i.test(await bodyText(page)), 'F3. iOS >1км: острый tip про «Точную геопозицию»');
    // textContent включает пункт даже у свёрнутого <details>
    const helpTxt = await page.evaluate(() => { const d = document.querySelector('details.geo-help'); return d ? d.textContent : ''; });
    check(/Точн[а-яё]* геопозици/i.test(helpTxt), 'F3. iOS: пункт про Precise Location в help');
    await ctx.close();
  }
  // F3b. НЕ-iOS: подсказки про Precise Location НЕТ (не мусолим Android)
  {
    const { ctx, page } = await fresh();
    await fireAcc(page, 1500); await page.waitForTimeout(300);
    check(!/Точной геопозиции/i.test(await bodyText(page)), 'F3b. Android >1км: без iOS-подсказки Precise');
    await ctx.close();
  }

  // --- 6. Офлайн: приложение уже загружено (geo.json в памяти) — убиваем сервер,
  //        адаптация под точность рендерится без сети (как в поле в авиарежиме).
  {
    const { ctx, page } = await fresh();
    killSrv(); await page.waitForTimeout(300); // реальный офлайн, но страница жива
    await fireAcc(page, 500); await page.waitForTimeout(300);
    check(JSON.stringify(await radii(page)) === JSON.stringify(['500 м', '1000 м', '2000 м', 'всё']), '6. офлайн: радиусы адаптируются под accuracy');
    const g = await gpsLine(page);
    check(g && /±500 м/.test(g), '6. офлайн: строка точности показана');
    await ctx.close();
  }

  await browser.close();
  killSrv();
  console.log(`\n=== «РЯДОМ» ПОД ТОЧНОСТЬ GPS: ВСЁ ОК (${ok} проверок) ===`);
  process.exit(0);
})().catch(e => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
