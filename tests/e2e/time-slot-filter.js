'use strict';
/* Фильтр по времени суток (слоты 3ч) в «Программе»/«Сейчас». Слот — по времени
   НАЧАЛА события в мск, ночь единым хвостом 23:00–07:59. Стык с фестсутками:
   ночное 01:30 живёт на вкладке предыдущего фестдня. Пересечение по И с цензом/
   площадкой/днём. Ожидания считаем через core (та же логика, что в проде). */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../../core.js');

const PORT = 8191;
const BASE = `http://127.0.0.1:${PORT}`;
const T = Date.UTC(2026, 6, 10, 18, 0); // пт 10 июля, 21:00 МСК

const PROG = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'program.json'), 'utf8'));
// декорируем КОПИИ (core мутирует) → _startMs/_festDay как в приложении
const EVENTS = core.decorateEvents(PROG.events.map(e => ({ ...e })));
const withStart = EVENTS.filter(e => e._startMs != null);
const DAYS = [...new Set(withStart.map(e => e._festDay))].sort(); // как p._days в app.js
const SLOT_LABEL = { '08-11': '08:00–11:00', '11-14': '11:00–14:00', '14-17': '14:00–17:00',
  '17-20': '17:00–20:00', '20-23': '20:00–23:00', '23-08': '23:00–08:00' };

// (festDay, slot) → массив событий
const byDaySlot = {};
withStart.forEach(e => {
  const s = core.timeSlotKey(e._startMs);
  ((byDaySlot[e._festDay] ??= {})[s] ??= []).push(e);
});
const dayEvents = (day) => withStart.filter(e => e._festDay === day);

const reExact = s => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.clock.install({ time: T });
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);

  const clickFilter = () => page.locator('.filter-chip-btn:visible').first().click();
  const visIds = () => page.$$eval('#content .event', els => els.map(e => e.dataset.id));
  const eventCount = () => page.$$eval('#content .event', els => els.length);
  const slotChip = (label) => page.locator('#filterSlotChips .fchip', { hasText: reExact(label) });
  const dotHidden = () => page.$$eval('.filter-chip-btn', bs => {
    const vis = bs.find(b => b.offsetParent !== null) || bs[0];
    const d = vis && vis.querySelector('.filter-dot');
    return d ? d.classList.contains('hidden') : true;
  });
  // выбрать день по festDay (кнопки #dayStrip идут в порядке DAYS)
  const goDay = async (day) => {
    const i = DAYS.indexOf(day);
    assert.ok(i >= 0, 'нет такого фестдня: ' + day);
    await page.locator('#dayStrip .day-btn').nth(i).click();
    await page.waitForTimeout(200);
  };
  // оставить выбранным ТОЛЬКО один слот
  const selectOnlySlot = async (slot) => {
    await clickFilter(); await page.waitForTimeout(150);
    await page.click('#slotClear'); await page.waitForTimeout(80);
    await slotChip(SLOT_LABEL[slot]).click(); await page.waitForTimeout(80);
    await page.click('#filterApply'); await page.waitForTimeout(250);
  };
  const allInSlot = async (slot) => {
    const ids = await visIds();
    return ids.every(id => core.timeSlotKey((EVENTS.find(e => e.id === id) || {})._startMs) === slot);
  };

  await page.click('.tab[data-view="schedule"]');
  await page.waitForTimeout(200);

  // --- 0. Модалка: группа «Время», 6 слотов, все выбраны по умолчанию (неактивен)
  assert.ok(await dotHidden(), '0: по умолчанию фильтр неактивен');
  await clickFilter(); await page.waitForTimeout(200);
  assert.ok(await page.isVisible('#filterSlotBlock'), '0: блок «Время» есть в программе');
  const slotChips = await page.$$eval('#filterSlotChips .fchip', els => els.map(e => e.textContent.trim()));
  const slotOn = await page.$$eval('#filterSlotChips .fchip.on', els => els.length);
  assert.equal(slotChips.length, 6, '0: ровно 6 слотов: ' + JSON.stringify(slotChips));
  assert.equal(slotOn, 6, '0: все 6 слотов выбраны по умолчанию');
  assert.deepEqual(slotChips, Object.values(SLOT_LABEL), '0: подписи/порядок слотов, ночь последней');
  await page.click('#filterSheet .icon-btn[data-close]'); await page.waitForTimeout(150);
  console.log('✓ 0. группа «Время»: 6 слотов, все выбраны, порядок с ночью в хвосте');

  // --- 1. Слот 20:00–23:00 → только вечерние события выбранного фестдня.
  //   Берём день, где в 20-23 есть события И есть события в других слотах.
  const day1 = DAYS.find(d => (byDaySlot[d]['20-23'] || []).length > 0 &&
    dayEvents(d).length > (byDaySlot[d]['20-23'] || []).length);
  assert.ok(day1, 'нужен день с вечерними И невечерними событиями');
  await goDay(day1);
  const baseline1 = await eventCount();
  await selectOnlySlot('20-23');
  assert.ok(!(await dotHidden()), '1: индикатор активен при сужении слота');
  const c1 = await eventCount();
  assert.equal(c1, (byDaySlot[day1]['20-23'] || []).length, `1: вечерних событий ${day1} = ${c1}, ждём ${(byDaySlot[day1]['20-23'] || []).length}`);
  assert.ok(c1 < baseline1, '1: слот реально сузил список');
  assert.ok(await allInSlot('20-23'), '1: все видимые события в слоте 20-23 (по старту)');
  console.log(`✓ 1. слот 20-23 → только вечерние (${c1} из ${baseline1}), все в слоте`);

  // --- 6. Все слоты выбраны → показывается всё (фильтр неактивен)
  await clickFilter(); await page.waitForTimeout(150);
  await page.click('#slotSelectAll'); await page.waitForTimeout(80);
  await page.click('#filterApply'); await page.waitForTimeout(250);
  assert.ok(await dotHidden(), '6: все слоты → фильтр неактивен');
  assert.equal(await eventCount(), baseline1, '6: вернулось всё за день');
  console.log('✓ 6. все слоты выбраны → фильтр неактивен, показывается всё');

  // --- 2 + 5. Ночь: слот 23-08 ловит и вечер-за-полночь, и раннее утро; ночное
  //   событие живёт на вкладке ПРЕДЫДУЩЕГО фестдня (фестсутки не сломаны).
  const nightEv = withStart.find(e => { const h = core.mskOf(e._startMs).h; return h >= 0 && h < 6; });
  assert.ok(nightEv, 'в данных есть событие после полуночи (00:00–05:59)');
  // его фестдень = предыдущая КАЛЕНДАРНАЯ дата от старта
  const cal = core.mskOf(nightEv._startMs);
  const prevCal = new Date(Date.UTC(cal.y, cal.mo, cal.day - 1)).toISOString().slice(0, 10);
  assert.equal(nightEv._festDay, prevCal, `2: ночное ${nightEv.start} на вкладке пред. дня ${prevCal}, а не ${nightEv._festDay}`);
  await goDay(nightEv._festDay);
  await selectOnlySlot('23-08');
  const nightIds = await visIds();
  assert.ok(nightIds.includes(nightEv.id), '2: ночное событие 00:xx попало в слот 23-08 на вкладке пред. дня');
  assert.ok(await allInSlot('23-08'), '5: все видимые в слоте 23-08 (час ≥23 или <8)');
  // среди видимых есть и «до полуночи» (≥23) и «после» (<8), если такие есть в дне
  const hours = nightIds.map(id => core.mskOf(EVENTS.find(e => e.id === id)._startMs).h);
  assert.ok(hours.every(h => h >= 23 || h < 8), '5: часы всех событий в ночном хвосте');
  console.log(`✓ 2+5. ночной слот 23-08: ночное ${nightEv.start} на вкладке ${nightEv._festDay}; хвост через полночь целен`);

  // --- 3. Событие по СТАРТУ: 10:xx → слот 08-11 (по началу, не по концу).
  const morn = withStart.find(e => { const h = core.mskOf(e._startMs).h; return h >= 8 && h < 11; });
  assert.ok(morn, 'в данных есть утреннее событие 08:00–10:59');
  await goDay(morn._festDay);
  await selectOnlySlot('08-11');
  assert.ok((await visIds()).includes(morn.id), `3: событие ${morn.start} → слот 08-11 (по старту)`);
  assert.ok(await allInSlot('08-11'), '3: все видимые в слоте 08-11');
  console.log(`✓ 3. слот по началу: ${morn.start} → 08-11`);

  // --- 4. Время + ценз + площадка + день = пересечение по И.
  //   Возьмём слот 14-17 в день с максимумом таких событий, добавим ценз одного
  //   из них — на экране только события этого слота И этого ценза.
  const day4 = DAYS.reduce((best, d) => ((byDaySlot[d]['14-17'] || []).length > (byDaySlot[best] && byDaySlot[best]['14-17'] || []).length ? d : best), DAYS[0]);
  const pool4 = byDaySlot[day4]['14-17'] || [];
  const age4 = (pool4.map(e => (e.age || '').trim()).find(Boolean));
  assert.ok(age4, '4: у событий слота 14-17 есть ценз для пересечения');
  await goDay(day4);
  await selectOnlySlot('14-17');
  // добавим ценз: снимем все, оставим один
  await clickFilter(); await page.waitForTimeout(150);
  await page.click('#ageClear'); await page.waitForTimeout(60);
  await page.locator('#filterAgeChips .fchip', { hasText: reExact(age4) }).click();
  await page.click('#filterApply'); await page.waitForTimeout(250);
  const ids4 = await visIds();
  const expect4 = pool4.filter(e => (e.age || '').trim() === age4).map(e => e.id).sort();
  assert.deepEqual(ids4.slice().sort(), expect4, '4: пересечение слот∧ценз∧день по И');
  assert.ok(ids4.every(id => core.timeSlotKey(EVENTS.find(e => e.id === id)._startMs) === '14-17'), '4: все в слоте 14-17');
  assert.ok(ids4.every(id => (EVENTS.find(e => e.id === id).age || '').trim() === age4), `4: все ценза ${age4}`);
  console.log(`✓ 4. слот 14-17 ∧ ценз ${age4} ∧ день ${day4} = пересечение (${ids4.length})`);

  // --- 7. Пустой результат → сообщение + сброс. День с событиями, но выберем
  //   слот, которого в этом дне НЕТ.
  const day7 = DAYS.find(d => Object.keys(SLOT_LABEL).some(s => !(byDaySlot[d][s] || []).length) && dayEvents(d).length > 0);
  const emptySlot = Object.keys(SLOT_LABEL).find(s => !(byDaySlot[day7][s] || []).length);
  await goDay(day7);
  await selectOnlySlot(emptySlot);
  assert.equal(await eventCount(), 0, `7: слот ${emptySlot} в дне ${day7} пуст`);
  const txt7 = await page.$eval('#content', el => el.innerText);
  assert.ok(/Ничего не найдено/i.test(txt7), '7: сообщение о пустом фильтре: ' + txt7.slice(0, 60));
  assert.ok(await page.$('.empty button'), '7: есть кнопка сброса');
  await page.click('.empty button'); await page.waitForTimeout(250);
  assert.ok(await dotHidden(), '7: после сброса фильтр неактивен');
  assert.ok((await eventCount()) > 0, '7: после сброса события вернулись');
  console.log(`✓ 7. пустой слот ${emptySlot} → «Ничего не найдено» + сброс`);

  // --- 1b. «Сейчас» тоже уважает слот-фильтр (та же passesFilters)
  await page.click('.tab[data-view="now"]'); await page.waitForTimeout(200);
  await selectOnlySlot('23-08');
  const nowIds = await visIds();
  assert.ok(nowIds.length === 0 || nowIds.every(id => core.timeSlotKey(EVENTS.find(e => e.id === id)._startMs) === '23-08'),
    '1b: в «Сейчас» видимы только события ночного слота');
  await clickFilter(); await page.waitForTimeout(120);
  await page.click('#slotSelectAll'); await page.click('#filterApply'); await page.waitForTimeout(200);
  console.log('✓ 1b. «Сейчас» тоже фильтруется по слоту (passesFilters)');

  // --- 11. «Рядом»: группа «Время» скрыта (там только ценз)
  await page.click('.tab[data-view="nearby"]'); await page.waitForTimeout(300);
  await clickFilter(); await page.waitForTimeout(200);
  assert.ok(await page.isVisible('#filterAgeBlock'), '11: в «рядом» ценз есть');
  assert.ok(!(await page.isVisible('#filterSlotBlock')), '11: в «рядом» группа «Время» скрыта');
  await page.click('#filterSheet .icon-btn[data-close]'); await page.waitForTimeout(150);
  console.log('✓ 11. «рядом» → группа «Время» скрыта');

  await ctx.close();

  // --- 8. Офлайн: слот-фильтр работает без сети (из SW-кэша)
  const ctxOff = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC' });
  const pageOff = await ctxOff.newPage();
  await pageOff.clock.install({ time: T });
  pageOff.on('pageerror', e => { console.error('pageerror-off:', e.message); process.exitCode = 1; });
  await pageOff.goto(BASE + '/', { waitUntil: 'load' });
  await pageOff.evaluate(async () => { if (navigator.serviceWorker) await navigator.serviceWorker.ready; });
  await pageOff.waitForTimeout(1500); // прекэш SW
  try { srv.kill('SIGKILL'); } catch {} // РЕАЛЬНЫЙ офлайн (setOffline не покрывает SW-fetch)
  await pageOff.waitForTimeout(300);
  await pageOff.reload({ waitUntil: 'load' }).catch(() => {});
  await pageOff.waitForTimeout(700);
  await pageOff.click('.tab[data-view="schedule"]'); await pageOff.waitForTimeout(200);
  const iOff = DAYS.indexOf(day1);
  await pageOff.locator('#dayStrip .day-btn').nth(iOff).click(); await pageOff.waitForTimeout(200);
  await pageOff.locator('.filter-chip-btn:visible').first().click(); await pageOff.waitForTimeout(150);
  await pageOff.click('#slotClear'); await pageOff.waitForTimeout(80);
  await pageOff.locator('#filterSlotChips .fchip', { hasText: reExact(SLOT_LABEL['20-23']) }).click();
  await pageOff.click('#filterApply'); await pageOff.waitForTimeout(250);
  const cOff = await pageOff.$$eval('#content .event', els => els.length);
  assert.equal(cOff, (byDaySlot[day1]['20-23'] || []).length, '8: офлайн слот-фильтр даёт тот же счёт');
  console.log(`✓ 8. офлайн: слот-фильтр работает из SW-кэша (${cOff} событий)`);
  await ctxOff.close();

  await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  console.log('\n=== ФИЛЬТР ПО ВРЕМЕНИ СУТОК: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
