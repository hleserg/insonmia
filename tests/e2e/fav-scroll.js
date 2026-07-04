'use strict';
/* ⭐-toggle НЕ должен ронять прокрутку списка вверх. Раньше toggleFav→render()
   пересобирал #content с нуля → scroll прыгал на 0. Теперь позиция сохраняется:
   из карточки события, из списка, и разумно ведёт себя в «Избранном». */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8171;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 480 }, timezoneId: 'UTC', serviceWorkers: 'block', // низкий вьюпорт → список точно скроллится
  });
  // standalone: иначе тап ⭐ открывает install-гейт, а не сохраняет
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(400);

  const scrollY = () => page.evaluate(() => window.scrollY);
  const scrollTo = y => page.evaluate(v => window.scrollTo(0, v), y);
  // клик по элементу, УЖЕ видимому во вьюпорте, без авто-скролла Playwright
  const clickVisible = sel => page.evaluate(s => {
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      if (r.top > 60 && r.bottom < window.innerHeight - 60) { el.click(); return true; }
    }
    return false;
  }, sel);

  // --- 1. прокрутил → открыл событие → ⭐ в карточке → закрыл → список НА МЕСТЕ
  await scrollTo(600); await page.waitForTimeout(150);
  const y1 = await scrollY();
  assert.ok(y1 > 150, 'список прокручен вниз (для теста): ' + y1);
  assert.ok(await clickVisible('.event .event-main'), 'открыли видимую карточку события');
  await page.waitForTimeout(250);
  assert.ok(await page.isVisible('#sheet'), 'описание открылось');
  await page.click('#detailFav'); await page.waitForTimeout(250); // добавить в избранное
  await page.click('#sheet .sheet-titlebar .icon-btn[data-close]'); await page.waitForTimeout(250);
  const y1after = await scrollY();
  assert.ok(Math.abs(y1after - y1) < 8, `после ⭐ из карточки список НЕ прыгнул: ${y1} → ${y1after}`);
  console.log(`✓ 1. ⭐ из карточки события не роняет прокрутку (${y1}→${y1after})`);

  // --- 2. ⭐ прямо из списка (не открывая событие) → прокрутка на месте
  await scrollTo(500); await page.waitForTimeout(150);
  const y2 = await scrollY();
  assert.ok(y2 > 150, 'список прокручен: ' + y2);
  assert.ok(await clickVisible('.event .fav-btn'), 'тап по видимой ⭐ в списке');
  await page.waitForTimeout(250);
  const y2after = await scrollY();
  assert.ok(Math.abs(y2after - y2) < 8, `⭐ из списка не роняет прокрутку: ${y2} → ${y2after}`);
  console.log(`✓ 2. ⭐ прямо из списка не роняет прокрутку (${y2}→${y2after})`);

  // --- 3. вкладка «Избранное»: удаление ⭐ не швыряет список на самый верх
  await page.evaluate(() => { state.favs = new Set(state.program.events.slice(0, 30).map(e => e.id)); saveFavs(); render(); });
  await page.click('.tab[data-view="favorites"]'); await page.waitForTimeout(300);
  await scrollTo(600); await page.waitForTimeout(150);
  const y3 = await scrollY();
  assert.ok(y3 > 150, 'избранное прокручено: ' + y3);
  assert.ok(await clickVisible('.event .fav-btn'), 'снимаем ⭐ у видимого события в избранном');
  await page.waitForTimeout(250);
  const y3after = await scrollY();
  // одна строка исчезла — допускаем сдвиг, но НЕ прыжок на самый верх
  assert.ok(y3after > 150, `избранное не улетело наверх после снятия ⭐: ${y3} → ${y3after}`);
  console.log(`✓ 3. «Избранное»: снятие ⭐ не швыряет список наверх (${y3}→${y3after})`);

  await ctx.close(); await browser.close();
  killSrv();
  console.log('\n=== ⭐ И ПРОКРУТКА: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
