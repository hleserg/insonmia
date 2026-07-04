'use strict';
/* В настройках: кнопка «Установить» скрыта в установленном приложении
   (standalone), видна в обычной вкладке браузера. Индикатор офлайн-
   готовности остаётся в обоих случаях. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8147;
const BASE = `http://127.0.0.1:${PORT}`;
const T = Date.UTC(2026, 6, 10, 18, 0);

const STANDALONE = () => {
  Object.defineProperty(navigator, 'standalone', { get: () => true });
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => (q.includes('standalone') ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } : mm(q));
};

async function openSettingsState(page) {
  await page.click('#btnSettings');
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const vis = sel => { const el = document.querySelector(sel); if (!el) return null; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.height > 0; };
    const off = document.querySelector('#offlineStatus');
    return {
      btn: vis('#btnInstall'),
      intro: vis('#installIntro'),
      installed: vis('#installedNote'),
      // индикатор офлайн-готовности заполняется по ответу SW (в тесте SW
      // заблокирован → пуст); проверяем, что он ЕСТЬ и НЕ скрыт нашим кодом
      offlineKept: !!off && !off.classList.contains('hidden'),
    };
  });
}

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });
  const browser = await chromium.launch(launchOpts);

  // 1. Установленное приложение (standalone) → кнопки нет, есть «✓ установлено»
  const ctxS = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
  await ctxS.addInitScript(STANDALONE);
  const pS = await ctxS.newPage();
  await pS.clock.install({ time: T });
  await pS.goto(BASE + '/', { waitUntil: 'load' });
  await pS.waitForTimeout(500);
  const s = await openSettingsState(pS);
  assert.equal(s.btn, false, 'standalone: кнопка «Установить» скрыта');
  assert.equal(s.intro, false, 'standalone: вводный текст установки скрыт');
  assert.equal(s.installed, true, 'standalone: показана пометка «✓ установлено»');
  assert.equal(s.offlineKept, true, 'standalone: индикатор офлайн-готовности не скрыт');
  console.log('✓ standalone: кнопки установки нет, есть «✓ установлено», офлайн-индикатор на месте');
  await ctxS.close();

  // 2. Обычная вкладка браузера → кнопка есть, пометки «установлено» нет
  const ctxB = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
  const pB = await ctxB.newPage();
  await pB.clock.install({ time: T });
  await pB.goto(BASE + '/', { waitUntil: 'load' });
  await pB.waitForTimeout(500);
  const b = await openSettingsState(pB);
  assert.equal(b.btn, true, 'браузер: кнопка «Установить» видна');
  assert.equal(b.intro, true, 'браузер: вводный текст виден');
  assert.equal(b.installed, false, 'браузер: пометки «установлено» нет');
  console.log('✓ браузер: кнопка установки на месте, пометки «установлено» нет');
  await ctxB.close();

  await browser.close();
  console.log('\n=== КНОПКА УСТАНОВКИ В STANDALONE: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
