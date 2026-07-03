'use strict';
/* Инсталл-флоу: плашка в браузерном режиме, ✕ с памятью, отказ в диалоге
   НЕ убивает кнопку, appinstalled прячет всё. Событие beforeinstallprompt
   эмулируется (реальный системный диалог headless-Chromium не показывает —
   финальная приёмка на устройстве за владельцем). */
const { chromium, launchOpts, REPO } = require('./_env');
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = 8100, BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, '..', '..', '..', 'install-shots'); // вне репо
let server = null;
const serverOn = () => { server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' }); return new Promise(r => setTimeout(r, 800)); };
const serverOff = () => { if (server) { server.kill('SIGKILL'); server = null; } return new Promise(r => setTimeout(r, 300)); };

const FAKE_EVENT = (outcome) => `
  (() => {
    const e = new Event('beforeinstallprompt');
    e.userChoice = new Promise(res => { window.__resolveChoice = () => res({ outcome: '${outcome}' }); });
    e.prompt = () => { window.__promptShown = (window.__promptShown || 0) + 1; setTimeout(window.__resolveChoice, 60); };
    window.dispatchEvent(e);
  })()`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await serverOn();
  const browser = await chromium.launch(launchOpts);

  // A. Браузерный режим: плашка видна сразу, текст про офлайн, ✕ с памятью
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC' });
    const page = await ctx.newPage();
    await page.clock.install({ time: Date.UTC(2026, 6, 9, 15, 0) });
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(900);
    const bar = await page.evaluate(() => {
      const b = document.querySelector('#installBar');
      return { hidden: b.classList.contains('hidden'), text: b.innerText };
    });
    assert.ok(!bar.hidden, 'плашка не видна в браузерном режиме');
    assert.ok(/офлайн-режим работать не будет/i.test(bar.text), 'нет крупного предупреждения про офлайн');
    await page.screenshot({ path: path.join(SHOTS, '1-bar-visible.png') });
    // ✕ → скрыта и после перезагрузки не возвращается
    await page.click('#installBarClose');
    let hidden = await page.evaluate(() => document.querySelector('#installBar').classList.contains('hidden'));
    assert.ok(hidden, '✕ не скрыл плашку');
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(700);
    hidden = await page.evaluate(() => document.querySelector('#installBar').classList.contains('hidden'));
    assert.ok(hidden, 'плашка вернулась после перезагрузки (localStorage не сработал)');
    await page.screenshot({ path: path.join(SHOTS, '2-bar-dismissed.png') });
    console.log('A: OK — плашка видна, предупреждение крупное, ✕ помнится через reload');
    await ctx.close();
  }

  // B. Standalone: плашки нет
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(700);
    const hidden = await page.evaluate(() => document.querySelector('#installBar').classList.contains('hidden'));
    assert.ok(hidden, 'плашка видна в standalone');
    console.log('B: OK — в standalone плашки нет');
    await ctx.close();
  }

  // C. Отказ в диалоге НЕ убивает кнопку; повторный prompt работает; accepted+appinstalled прячет всё
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(800);
    // событие -> тап -> «пользователь отменил»
    await page.evaluate(FAKE_EVENT('dismissed'));
    await page.click('#installBarBtn');
    await page.waitForTimeout(400);
    let st = await page.evaluate(() => ({
      shown: window.__promptShown || 0,
      btnDisabled: document.querySelector('#installBarBtn').disabled || document.querySelector('#btnInstall').disabled,
      hint: document.querySelector('#installBarHint').textContent,
      barHidden: document.querySelector('#installBar').classList.contains('hidden'),
    }));
    assert.equal(st.shown, 1, 'prompt() не вызвался');
    assert.ok(!st.btnDisabled, 'кнопка умерла после отказа (старый баг!)');
    assert.ok(!st.barHidden, 'плашка исчезла без установки');
    assert.ok(/меню браузера|Поделиться/i.test(st.hint), 'инструкция не показана после отказа');
    await page.screenshot({ path: path.join(SHOTS, '3-after-dismiss.png') });
    // Chrome выдал новое событие -> кнопка снова ведёт в системный диалог
    await page.evaluate(FAKE_EVENT('accepted'));
    await page.click('#installBarBtn');
    await page.waitForTimeout(400);
    st = await page.evaluate(() => ({ shown: window.__promptShown }));
    assert.equal(st.shown, 2, 'повторный prompt после нового события не сработал');
    // система сообщает об установке
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      barHidden: document.querySelector('#installBar').classList.contains('hidden'),
      hint: document.querySelector('#installHint').textContent,
    }));
    assert.ok(after.barHidden, 'плашка не скрылась по appinstalled');
    assert.ok(/Установлено/.test(after.hint), 'нет подтверждения установки');
    await page.screenshot({ path: path.join(SHOTS, '4-after-installed.png') });
    console.log('C: OK — отказ пережит, повторный prompt работает, appinstalled прячет всё');
    await ctx.close();
  }

  // D. Без beforeinstallprompt вообще: кнопка в настройках сразу даёт инструкцию
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(700);
    await page.click('#btnSettings');
    await page.waitForTimeout(300);
    const disabled = await page.evaluate(() => document.querySelector('#btnInstall').disabled);
    assert.ok(!disabled, 'кнопка в настройках задизейблена без события');
    await page.click('#btnInstall');
    await page.waitForTimeout(300);
    const hint = await page.evaluate(() => document.querySelector('#installHint').textContent);
    assert.ok(/меню браузера|Поделиться/i.test(hint), 'инструкция не показана: ' + hint);
    const over = await page.evaluate(() => document.documentElement.scrollWidth > 362);
    assert.ok(!over, 'перелив 360px с плашкой');
    await page.screenshot({ path: path.join(SHOTS, '5-no-event-instruction.png') });
    console.log('D: OK — без события кнопка живая и ведёт к инструкции, 360px чисто');
    await ctx.close();
  }

  console.log('\nИНСТАЛЛ-ФЛОУ: ВСЁ ЗЕЛЁНОЕ (скрины в ' + SHOTS + ')');
  await browser.close();
  await serverOff();
  process.exit(0);
})().catch(async e => { console.error('FAIL:', e.message); await serverOff(); process.exit(1); });
