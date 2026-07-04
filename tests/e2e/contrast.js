'use strict';
/* Аудит контраста: обходит ВСЕ текстовые элементы во всех видах и шитах,
   считает реальный ratio текста к фактическому фону (учитывая прозрачные
   родительские фоны), выводит таблицу и всех, кто <4.5:1. */
const { chromium, launchOpts, REPO } = require('./_env');
const { spawn } = require('child_process');

const PORT = 8145;
const BASE = `http://127.0.0.1:${PORT}`;
const T = Date.UTC(2026, 6, 10, 18, 0);

const AUDIT = () => {
  // эффективный фон: идём вверх по дереву, пока не встретим непрозрачный
  function bgOf(el) {
    let e = el;
    while (e) {
      const b = getComputedStyle(e).backgroundColor;
      const m = b.match(/[\d.]+/g);
      if (m && (m.length < 4 || +m[3] > 0)) return b;
      e = e.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  }
  function lum(c) {
    const m = c.match(/[\d.]+/g).map(Number);
    let [r, g, b, a] = m;
    if (a === 0) return null;
    [r, g, b] = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function ratio(fg, bg) {
    const a = lum(fg), b = lum(bg);
    if (a == null || b == null) return null;
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    // только элементы с СОБСТВЕННЫМ видимым текстом (без детей-элементов)
    const hasOwnText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!hasOwnText) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || +st.opacity === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const fg = st.color;
    const bg = bgOf(el);
    const rt = ratio(fg, bg);
    if (rt == null) continue;
    const label = (el.id ? '#' + el.id : '') + '.' + (el.className || el.tagName).toString().trim().split(/\s+/).join('.');
    const txt = el.textContent.trim().slice(0, 24);
    const key = label + '|' + fg + '|' + bg;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: label.slice(0, 40), txt, fg, bg, ratio: +rt.toFixed(2), fs: parseFloat(st.fontSize) });
  }
  return out;
};

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true });
    const mm = window.matchMedia.bind(window); window.matchMedia = q => q.includes('standalone') ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } : mm(q); });
  const page = await ctx.newPage();
  await page.clock.install({ time: T });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(700);

  const all = [];
  const collect = async (name) => {
    const rows = await page.evaluate(AUDIT);
    rows.forEach(r => all.push({ view: name, ...r }));
  };

  // все виды
  for (const v of ['now', 'schedule', 'favorites', 'nearby']) {
    await page.click(`.tab[data-view="${v}"]`);
    await page.waitForTimeout(500);
    await collect(v);
  }
  // избранное с событием → карточка/детали
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(300);
  await page.locator('.event').first().locator('.fav-btn').click();
  await page.waitForTimeout(200);
  await page.click('.event-main >> nth=0');
  await page.waitForTimeout(400);
  await collect('detail');
  await page.click('#sheet .icon-btn[data-close]');
  // настройки
  await page.click('#btnSettings');
  await page.waitForTimeout(300);
  await collect('settings');
  await page.click('#settings .icon-btn[data-close]');
  // карта + метка-карточка
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(1200);
  await collect('map');

  await browser.close(); srv.kill('SIGKILL');

  // дедуп по label|fg|bg
  const uniq = new Map();
  all.forEach(r => { const k = r.label + '|' + r.fg + '|' + r.bg; if (!uniq.has(k)) uniq.set(k, r); });
  const rows = [...uniq.values()].sort((a, b) => a.ratio - b.ratio);
  console.log('\n=== КОНТРАСТ: все текстовые элементы (отсортировано по возрастанию) ===');
  console.log('ratio | fs | view | label | «текст»');
  rows.forEach(r => console.log(`${String(r.ratio).padStart(5)} | ${String(r.fs).padStart(4)} | ${r.view.padEnd(9)} | ${r.label.padEnd(40)} | ${JSON.stringify(r.txt)}`));
  const bad = rows.filter(r => r.ratio < 4.5);
  console.log(`\n=== НИЖЕ 4.5:1 (${bad.length}) ===`);
  bad.forEach(r => console.log(`${String(r.ratio).padStart(5)} | ${r.view} | ${r.label} | fg=${r.fg} bg=${r.bg} | ${JSON.stringify(r.txt)}`));
  const floor = rows.length ? rows[0].ratio : 0;
  console.log(`\nfloor = ${floor}:1 · элементов проверено: ${rows.length}`);
  const assert = require('assert');
  assert.equal(bad.length, 0, `текст с контрастом <4.5:1 (WCAG AA): ${bad.map(b => b.label + ' ' + b.ratio).join('; ')}`);
  assert.ok(floor >= 4.5, 'floor ниже 4.5:1');
  console.log('=== КОНТРАСТ: все текстовые элементы ≥4.5:1 (WCAG AA) ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
