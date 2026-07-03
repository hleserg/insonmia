'use strict';
/* Фаза 4 аудита: UX глазами уставшего гостя (360px, один палец, темнота). */
const { chromium, launchOpts, REPO, tmpProfile } = require('./_env');
const assert = require('assert');

const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const T = Date.UTC(2026, 6, 10, 18, 0); // пт 10 июля, 21:00 МСК — прайм-тайм
const findings = [];
const note = (s) => { findings.push(s); console.log('  !', s); };

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, deviceScaleFactor: 2,
    timezoneId: 'UTC', serviceWorkers: 'block', // UX-прогон без SW-помех
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = await ctx.newPage();
  await page.clock.install({ time: T });
  page.on('pageerror', e => note('pageerror: ' + e.message));
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);

  // 1. Нулевой тап: дефолтный вид — «сейчас»
  const activeTab = await page.textContent('.tab.active');
  console.log('дефолтный вид:', activeTab.trim());
  assert.ok(/сейчас/.test(activeTab), 'дефолтный вид не «сейчас» — до «что идёт» больше 0 тапов');

  const shot = (n) => page.screenshot({ path: `/tmp/claude-0/-home-user-insonmia/1806d6c8-2cd9-5bb9-a0f2-b25cf16ccac9/scratchpad/ux-${n}.png` });

  const views = ['now', 'schedule', 'favorites', 'map', 'nearby'];
  const badText = /\bundefined\b|\bNaN\b|\[object |\bnull\b/;

  for (const v of views) {
    await page.click(`.tab[data-view="${v}"]`);
    await page.waitForTimeout(500);

    // 2. тап-таргеты: все видимые интерактивные элементы
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, a, select, input, .tab, .chip')) {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || st.visibility === 'hidden') continue;
        // эффективная зона тапа: сам элемент + паддинги родителя не считаем, честные размеры
        if (Math.min(r.width, r.height) < 40) {
          out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return [...new Set(out)];
    });
    small.forEach(s => note(`[${v}] тап-таргет <40px: ${s}`));

    // 3. undefined/NaN в текстах
    const txt = await page.evaluate(() => document.body.innerText);
    if (badText.test(txt)) note(`[${v}] мусор в тексте: ` + txt.match(badText));

    // 4. горизонтальный скролл на 360px
    const over = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    if (over.doc > 362 || over.body > 362) note(`[${v}] горизонтальный перелив: doc=${over.doc} body=${over.body}`);

    // 5. мелкий шрифт
    const tiny = await page.evaluate(() => {
      const out = new Set();
      for (const el of document.querySelectorAll('#content *, .app-footer *, .tabs *')) {
        if (!el.textContent.trim() || el.children.length) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 11) out.add(`${el.className || el.tagName} ${fs}px "${el.textContent.trim().slice(0, 25)}"`);
      }
      return [...out].slice(0, 8);
    });
    tiny.forEach(s => note(`[${v}] шрифт <11px: ${s}`));

    await shot(v);
  }

  // 6. пустое избранное — осмысленный текст
  await page.click('.tab[data-view="favorites"]');
  await page.waitForTimeout(300);
  const favTxt = (await page.evaluate(() => document.querySelector('#content').innerText)).trim();
  console.log('пустое избранное:', JSON.stringify(favTxt.slice(0, 120)));
  assert.ok(favTxt.length > 20, 'пустое избранное без объяснения');

  // 7. поиск с мусорным запросом — в сетке программы
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(300);
  await page.click('#btnSearch');
  await page.fill('#searchInput', 'кзхчфыр');
  await page.waitForTimeout(400);
  const searchTxt = (await page.evaluate(() => document.querySelector('#content').innerText)).trim();
  console.log('пустой поиск:', JSON.stringify(searchTxt.slice(0, 100)));
  assert.ok(searchTxt.length > 5, 'пустой результат поиска без сообщения');
  await page.click('#btnSearchClose');

  // 8. карточка события: открытие шитика, перелив, мусор
  await page.waitForTimeout(400);
  await page.click('.event >> nth=0');
  await page.waitForTimeout(400);
  const sheetVisible = await page.evaluate(() => !document.querySelector('#sheet').classList.contains('hidden'));
  assert.ok(sheetVisible, 'шитик события не открылся');
  const sheetOver = await page.evaluate(() => {
    const b = document.querySelector('.sheet-card');
    return b.scrollWidth - b.clientWidth;
  });
  if (sheetOver > 2) note(`шитик события: горизонтальный перелив ${sheetOver}px`);
  const sheetTxt = await page.evaluate(() => document.querySelector('#sheetBody').innerText);
  if (badText.test(sheetTxt)) note('шитик: мусор в тексте: ' + sheetTxt.match(badText));
  await shot('sheet');
  await page.click('#sheet .icon-btn[data-close]'); // ✕, бэкдроп перекрыт картой шитика

  // 9. дисклеймер и контакт
  const foot = await page.evaluate(() => {
    const f = document.querySelector('.app-footer');
    const a = f.querySelector('a[href*="t.me/skhlebnikov"]');
    return {
      beta: /this is a beta build/.test(f.innerText),
      legal: /Неофициальное фанатское/.test(f.innerText),
      version: /от \d/.test(f.querySelector('#dataVersion').textContent),
      tg: !!a, target: a && a.getAttribute('target'),
    };
  });
  console.log('футер:', JSON.stringify(foot));
  assert.ok(foot.beta && foot.legal && foot.tg, 'футер неполный: ' + JSON.stringify(foot));
  if (!foot.version) note('версия данных в футере пуста');

  // 10. «рядом» БЕЗ разрешения геолокации — не вечный спиннер
  const ctx2 = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
  const p2 = await ctx2.newPage();
  await p2.clock.install({ time: T });
  await p2.goto(BASE + '/', { waitUntil: 'load' });
  await p2.click('.tab[data-view="nearby"]');
  await p2.waitForTimeout(2500);
  const nearTxt = (await p2.evaluate(() => document.querySelector('#content').innerText)).trim();
  console.log('«рядом» без geo-разрешения:', JSON.stringify(nearTxt.slice(0, 140)));
  assert.ok(nearTxt.length > 20, '«рядом» без геолокации — пусто/спиннер');
  await ctx2.close();

  // 11. контраст ключевых пар (WCAG relative luminance)
  const contrast = await page.evaluate(() => {
    function lum(c) {
      const m = c.match(/\d+(\.\d+)?/g).map(Number);
      const [r, g, b] = m.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    function ratio(fg, bg) { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
    const bg = getComputedStyle(document.body).backgroundColor;
    const out = {};
    const probe = (name, sel) => {
      const el = document.querySelector(sel);
      if (el) out[name] = +ratio(getComputedStyle(el).color, bg).toFixed(2);
    };
    probe('обычный текст', '.event-title');
    probe('muted', '.muted, .event-meta');
    probe('время (зелёное)', '.event-time');
    probe('таб неактивный', '.tab:not(.active)');
    probe('футер', '.footer-legal');
    return out;
  });
  console.log('контраст к фону:', JSON.stringify(contrast));
  for (const [k, v] of Object.entries(contrast)) {
    if (v < 4.5) note(`контраст ниже 4.5:1 — ${k}: ${v}`);
  }

  await ctx.close(); await browser.close();
  console.log(`\n=== Ф4: находок ${findings.length} ===`);
  findings.forEach(f => console.log('  -', f));
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
