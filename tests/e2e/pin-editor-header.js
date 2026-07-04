'use strict';
/* Модалка «~/метки/новая»: сохранение (✓ зелёная) и отмена (✕) в закреплённой
   шапке — клавиатура снизу их не перекрывает. Нижней кнопки «Сохранить» нет,
   автофокуса на «название» нет, ✓ сохраняет, ✕ отменяет. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8168;
const BASE = `http://127.0.0.1:${PORT}`;
const PT = { latitude: 54.68025, longitude: 35.08971 };

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
    geolocation: PT, permissions: ['geolocation'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.click('.tab[data-view="map"]');
  await page.waitForTimeout(1200);

  const openEditor = async () => {
    await page.click('#btnAddPin'); await page.waitForTimeout(150);
    await page.click('#pinAddCoords'); await page.waitForTimeout(200);
  };

  // --- 1. ✓ и ✕ в шапке; нижней кнопки «Сохранить» нет
  await openEditor();
  assert.ok(await page.isVisible('#pinEditor'), 'редактор открыт');
  const inHeader = await page.evaluate(() => {
    const save = document.querySelector('#pinSave');
    const bar = document.querySelector('#pinEditor .sheet-titlebar');
    const cancel = document.querySelector('#pinEditor .sheet-titlebar .icon-btn[data-close]');
    return {
      saveInBar: !!(save && bar && bar.contains(save)),
      saveGreen: !!(save && save.classList.contains('filter-apply-btn')),
      cancelInBar: !!cancel,
      bottomSaveInBody: !!document.querySelector('#pinEditor .sheet-body #pinSave'),
    };
  });
  assert.ok(inHeader.saveInBar, '✓ сохранить — в шапке');
  assert.ok(inHeader.saveGreen, '✓ зелёная (filter-apply-btn)');
  assert.ok(inHeader.cancelInBar, '✕ отмена — в шапке');
  assert.ok(!inHeader.bottomSaveInBody, 'нижней кнопки «Сохранить» в теле нет');
  console.log('✓ 1. [✓ зелёная][✕] в шапке, нижней «Сохранить» нет');

  // --- 2. без автофокуса на «название» (клавиатура не выскакивает сразу)
  const focusedName = await page.evaluate(() => document.activeElement === document.querySelector('#pinName'));
  assert.ok(!focusedName, 'поле «название» не в автофокусе при открытии');
  console.log('✓ 2. нет автофокуса на «название»');

  // --- 3. контраст зелёной ✓ читаем (тёмная галочка на зелёном)
  const contrast = await page.evaluate(() => {
    const lum = (r, g, b) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const parse = s => s.match(/\d+(\.\d+)?/g).map(Number);
    const el = document.querySelector('#pinSave');
    const fg = parse(getComputedStyle(el).color).slice(0, 3);
    const bg = parse(getComputedStyle(el).backgroundColor).slice(0, 3);
    const a = lum(...fg) + 0.05, b = lum(...bg) + 0.05;
    return +(Math.max(a, b) / Math.min(a, b)).toFixed(2);
  });
  assert.ok(contrast >= 4.5, `контраст ✓ ${contrast} < 4.5`);
  console.log(`✓ 3. контраст зелёной ✓ ${contrast}:1`);

  // --- 4. ✓ в шапке сохраняет метку и закрывает модалку
  await page.fill('#pinName', 'Штаб');
  await page.fill('#pinCoords', '54.68120, 35.09110');
  await page.click('#pinSave'); // кнопка в шапке
  await page.waitForTimeout(400);
  assert.ok(!(await page.isVisible('#pinEditor')), 'после ✓ модалка закрылась');
  let pins = await page.evaluate(() => (state.pins || []).map(p => p.name));
  assert.ok(pins.includes('Штаб'), 'метка сохранена по ✓ из шапки: ' + JSON.stringify(pins));
  console.log('✓ 4. ✓ в шапке сохраняет + закрывает');

  // --- 5. ✕ отменяет без сохранения
  await openEditor();
  await page.fill('#pinName', 'НеСохраняем');
  await page.fill('#pinCoords', '54.68200, 35.09200');
  await page.click('#pinEditor .sheet-titlebar .icon-btn[data-close]');
  await page.waitForTimeout(300);
  assert.ok(!(await page.isVisible('#pinEditor')), 'после ✕ модалка закрылась');
  pins = await page.evaluate(() => (state.pins || []).map(p => p.name));
  assert.ok(!pins.includes('НеСохраняем'), '✕ не сохранил метку: ' + JSON.stringify(pins));
  console.log('✓ 5. ✕ отменяет без сохранения');

  await ctx.close(); await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  console.log('\n=== ШАПКА РЕДАКТОРА МЕТКИ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
