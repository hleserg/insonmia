'use strict';
/* Репро бага: поиск «очень странное» должен находить спектакль 12 июля
   с любого выбранного дня и из «сейчас». */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const T = Date.UTC(2026, 6, 9, 18, 0); // чт 9 июля, 21:00 МСК — первый день феста

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  await page.clock.install({ time: T });
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);

  const contentText = () => page.evaluate(() => document.querySelector('#content').innerText);

  // 1. «Программа», выбран ПЕРВЫЙ день (9 июля) — спектакль 12-го
  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(300);
  await page.click('.day-btn >> nth=0');
  await page.waitForTimeout(300);
  let txt = await contentText();
  assert.ok(!txt.includes('Очень странное место'), 'преикондиция: на 9 июля спектакля быть не должно');

  await page.click('#btnSearch');
  // плейсхолдер поля поиска не обрезается на 360px и не жмёт каретку к краю
  const ph = await page.evaluate(() => {
    const el = document.querySelector('#searchInput');
    const cs = getComputedStyle(el);
    return {
      placeholder: el.placeholder,
      overflow: el.scrollWidth - el.clientWidth, // >0 = текст не влезает
      padLeft: parseFloat(cs.paddingLeft),
      mono: /mono/i.test(cs.fontFamily),
    };
  });
  assert.ok(!/название, площадка/.test(ph.placeholder), 'плейсхолдер не длинный перечень: ' + ph.placeholder);
  assert.ok(ph.overflow <= 1, 'плейсхолдер/поле не переполняется по ширине на 360px: overflow=' + ph.overflow);
  assert.ok(ph.padLeft >= 12, 'у поля есть left-padding (каретка не у края): ' + ph.padLeft);
  assert.ok(ph.mono, 'терминальный моноширинный стиль сохранён');
  console.log(`✓ плейсхолдер «${ph.placeholder}» влезает (overflow ${ph.overflow}), padding-left ${ph.padLeft}px, mono`);
  await page.fill('#searchInput', 'очень странное');
  await page.waitForTimeout(400);
  txt = await contentText();
  assert.ok(txt.includes('Очень странное место'), 'ПОИСК С ДРУГОГО ДНЯ НЕ НАШЁЛ спектакль: ' + JSON.stringify(txt.slice(0, 120)));
  console.log('✓ поиск с 9 июля находит спектакль 12-го');

  // заголовок дня в выдаче — чтобы было видно, КОГДА событие
  assert.ok(/вс, 12 июл/i.test(txt), 'в выдаче нет заголовка дня «вс, 12 июл»: ' + JSON.stringify(txt.slice(0, 160)));
  console.log('✓ выдача группируется заголовком дня (вс, 12 июл)');

  // полоса дат при поиске заглушена и не подсвечена
  const strip = await page.evaluate(() => ({
    disabled: [...document.querySelectorAll('.day-btn')].every(b => b.disabled),
    active: document.querySelectorAll('.day-btn.active').length,
  }));
  assert.ok(strip.disabled && strip.active === 0, 'полоса дат при поиске должна быть заглушена: ' + JSON.stringify(strip));
  console.log('✓ полоса дат при поиске заглушена, ничего не подсвечено');

  // 2. очистка поиска — вернулись к выбранному дню (9 июля), полоса живая
  await page.click('#btnSearchClose');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    txt: document.querySelector('#content').innerText.slice(0, 200),
    activeIdx: [...document.querySelectorAll('.day-btn')].findIndex(b => b.classList.contains('active')),
    anyDisabled: [...document.querySelectorAll('.day-btn')].some(b => b.disabled),
  }));
  assert.ok(after.activeIdx === 0 && !after.anyDisabled, 'после очистки полоса должна ожить с прежним днём: ' + JSON.stringify(after));
  assert.ok(!after.txt.includes('Очень странное место'), 'после очистки не должно остаться выдачи поиска');
  console.log('✓ очистка поиска возвращает выбранный день (9 июля), полоса кликабельна');

  // 3. из «сейчас»: ввод запроса переключает в программу и находит
  await page.click('.tab[data-view="now"]');
  await page.waitForTimeout(300);
  await page.click('#btnSearch');
  await page.fill('#searchInput', 'Очень СТРАННОЕ'); // регистр не должен мешать
  await page.waitForTimeout(400);
  const view = await page.evaluate(() => document.querySelector('.tab.active').dataset.view);
  txt = await contentText();
  assert.equal(view, 'schedule', 'ввод запроса в «сейчас» должен переключить в программу');
  assert.ok(txt.includes('Очень странное место'), 'поиск из «сейчас» не нашёл: ' + JSON.stringify(txt.slice(0, 120)));
  console.log('✓ поиск из «сейчас» (в другом регистре) переключает в программу и находит');

  // 4. фильтр типа при поиске уважается: «анимация» + «очень странное» → пусто
  await page.click('.chip[data-type="animation"]');
  await page.waitForTimeout(300);
  txt = await contentText();
  assert.ok(!txt.includes('Очень странное место') && txt.includes('ничего не найдено'), 'тип-фильтр при поиске должен работать: ' + JSON.stringify(txt.slice(0, 120)));
  console.log('✓ фильтр типа продолжает действовать при поиске');
  await page.click('.chip[data-type="all"]');

  await ctx.close(); await browser.close();
  console.log('\n=== ПОИСК ПО ВСЕМ ДНЯМ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
