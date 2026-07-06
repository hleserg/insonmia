'use strict';
/* НАСТУПЛЕНИЕ и ход фестивальных дней в разделе «Сейчас».
   Проверяем на РЕАЛЬНЫХ данных program.json ровно ту логику, что живёт в
   renderNow (app.js): активный день полосы = getFestivalDay(now), если он в
   днях программы, иначе null; баннеры «до старта»/«завершён» по границам
   всей программы; live/upcoming — из core. Всё по эпохам → результаты обязаны
   совпадать в любой таймзоне процесса (npm test гоняет сьют в 4 TZ). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const core = require('../../core.js');

const program = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'program.json'), 'utf8'));
const events = core.decorateEvents(program.events.slice());
const withStart = events.filter(e => e._startMs != null);
// дни программы — как p._days в app.js (уникальные фест-дни, отсортированы)
const DAYS = [...new Set(withStart.map(e => e._festDay).filter(Boolean))].sort();
const FIRST = Math.min(...withStart.map(e => e._startMs));
const LAST = Math.max(...withStart.map(e => e._endMs || e._startMs));
const MSK = (iso) => core.epochFromISO(iso);

// зеркало логики renderNow: что показывает «Сейчас» в момент now
function nowView(nowMs) {
  const today = core.getFestivalDay(nowMs);
  const activeDay = DAYS.includes(today) ? today : null; // подсветка полосы
  const live = core.getCurrent(withStart, nowMs);
  const upcoming = core.getUpcoming(withStart, nowMs); // без горизонта — как «Далее»
  let banner = null;
  if (FIRST && nowMs < FIRST) banner = 'prestart';
  else if (LAST && nowMs > LAST) banner = 'ended';
  return { today, activeDay, live, upcoming, banner };
}

test('данные-предпосылки: фест 9–13 июля, первое событие 09.07 10:00', () => {
  assert.deepEqual(DAYS,
    ['2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13']);
  assert.equal(MSK('2026-07-09T10:00'), FIRST); // первое событие
});

/* 1. ДО феста (6–8 июля): предстартовое состояние, без ложного «идёт сейчас» */
test('1. до феста: баннер «до старта», нет live, полоса не подсвечена', () => {
  for (const iso of ['2026-07-06T12:00', '2026-07-07T09:00', '2026-07-08T23:00']) {
    const v = nowView(MSK(iso));
    assert.equal(v.banner, 'prestart', iso + ' → предстарт');
    assert.equal(v.live.length, 0, iso + ' → НЕ показывает идущие события');
    assert.equal(v.activeDay, null, iso + ' → полоса дней не подсвечена');
    assert.ok(v.upcoming.length > 0, iso + ' → есть «Далее» (вся программа впереди)');
    // первое в «Далее» — самое раннее событие феста
    assert.equal(v.upcoming[0]._startMs, FIRST);
  }
});

/* 2. НАСТУПЛЕНИЕ первого дня (переход 8→9). Вкладка «чт 9» активируется по
   фест-суточному рубежу 06:00; реальный контент (live) — с первого события 10:00. */
test('2. наступление 9-го: 00:00 ещё предстарт (день 08), 06:00 — активна «чт 9»', () => {
  const midnight = nowView(MSK('2026-07-09T00:00'));
  assert.equal(midnight.today, '2026-07-08'); // до 06:00 фест-сутки ещё 08-е
  assert.equal(midnight.activeDay, null);     // 08-го нет в программе → не подсвечено
  assert.equal(midnight.banner, 'prestart');

  const six = nowView(MSK('2026-07-09T06:00'));
  assert.equal(six.activeDay, '2026-07-09');   // вкладка «чт 9» активна САМА
  assert.equal(six.live.length, 0);            // но событий ещё нет (первое в 10:00)
  assert.equal(six.banner, 'prestart');        // до 10:00 честно «до старта»
});

test('2b. первое событие 09.07 10:00: старт — live появляется, баннер снят', () => {
  const before = nowView(MSK('2026-07-09T09:59'));
  assert.equal(before.live.length, 0);
  assert.equal(before.banner, 'prestart');

  const at = nowView(FIRST); // ровно 10:00
  assert.equal(at.activeDay, '2026-07-09');
  assert.ok(at.live.length > 0, 'в 10:00 хотя бы одно событие «идёт»');
  assert.equal(at.banner, null, 'на старте баннер «до старта» снят');
});

/* 3. ВНУТРИ феста: активный день двигается вместе с датой (днём каждого дня) */
test('3. каждый фестдень днём: активна своя вкладка, есть контент', () => {
  for (const d of DAYS) {
    const noon = nowView(MSK(d + 'T14:00'));
    assert.equal(noon.activeDay, d, d + ' 14:00 → активна вкладка этого дня');
    assert.equal(noon.banner, null, d + ' 14:00 → внутри феста, без баннеров');
    // днём в 14:00 у каждого дня что-то идёт или вот-вот начнётся
    assert.ok(noon.live.length + noon.upcoming.length > 0, d + ' → есть события');
  }
});

/* 4. ФЕСТИВАЛЬНЫЕ СУТКИ (cutoff 06:00) — критично */
test('4a. ночь вс→пн, 13.07 02:00 → активен фестдень «вс 12», не пустой 13-й', () => {
  const v = nowView(MSK('2026-07-13T02:00'));
  assert.equal(v.activeDay, '2026-07-12', 'в 02:00 ещё фестдень 12-го');
  assert.notEqual(v.activeDay, '2026-07-13', 'НЕ перескочил на 13-й раньше 06:00');
  // ночная программа 12-го реально идёт (события с бакетом 12, старт после полуночи)
  assert.ok(v.live.every(e => e._festDay === '2026-07-12' || e._startMs <= MSK('2026-07-13T02:00')));
});

test('4b. переход 06:00 утра 13.07 → активный день сдвигается на 13-й', () => {
  assert.equal(nowView(MSK('2026-07-13T05:59')).activeDay, '2026-07-12');
  assert.equal(nowView(MSK('2026-07-13T06:00')).activeDay, '2026-07-13');
});

test('4c. последний день в ночи (14.07 02:00) → ещё фестдень 13, без выхода за диапазон', () => {
  const v = nowView(MSK('2026-07-14T02:00'));
  assert.equal(v.today, '2026-07-13');       // фест-сутки последнего дня тянутся до 06:00 14-го
  assert.equal(v.activeDay, '2026-07-13');    // подсветка на последнем дне, не за диапазоном
  // 13-е — только дневная программа (до 18:00), ночью live нет
  assert.equal(v.live.length, 0);
});

/* 4d. ОСОЗНАННАЯ нестыковка (D1): после конца последнего события и до рубежа
   06:00 14-го баннер «завершён» сосуществует с подсветкой активного дня «пн 13».
   Это НЕ баг: фест реально окончен (событий больше нет — сценарий 5 владельца),
   а тег дня — текущие фест-сутки. Фиксируем поведение явно, чтобы регресс был
   виден, а не «молча благословлён». Рубежи разные намеренно: баннер по концу
   ПОСЛЕДНЕГО события (max _endMs), день — по фест-суткам (cutoff 06:00). */
test('4d. финальная ночь: «завершён» + активный день 13 сосуществуют осознанно', () => {
  // конец последнего события — 13.07 (LAST), дальше событий нет
  assert.equal(core.getFestivalDay(LAST), '2026-07-13');
  for (const iso of ['2026-07-13T20:00', '2026-07-14T02:00', '2026-07-14T05:59']) {
    const v = nowView(MSK(iso));
    assert.equal(v.banner, 'ended', iso + ' → баннер «завершён» (событий больше нет)');
    assert.equal(v.activeDay, '2026-07-13', iso + ' → активны ещё фест-сутки 13-го');
    assert.equal(v.live.length, 0, iso + ' → ничего не идёт');
  }
  // ровно в 06:00 14-го фест-сутки закончились → подсветки нет, баннер остаётся
  const past = nowView(MSK('2026-07-14T06:00'));
  assert.equal(past.activeDay, null);
  assert.equal(past.banner, 'ended');
});

/* 5. ПОСЛЕ феста (14 июля 06:00+): разумное «завершено», без падений/пустот-ошибок */
test('5. после феста: баннер «завершён», нет live/upcoming, полоса не подсвечена', () => {
  for (const iso of ['2026-07-14T08:00', '2026-07-15T12:00', '2026-08-01T00:00']) {
    const v = nowView(MSK(iso));
    assert.equal(v.banner, 'ended', iso + ' → «фестиваль завершён»');
    assert.equal(v.live.length, 0, iso + ' → ничего не «идёт»');
    assert.equal(v.upcoming.length, 0, iso + ' → впереди ничего нет');
    assert.equal(v.activeDay, null, iso + ' → полоса дней не подсвечена');
  }
});

/* 6. ГРАНИЦЫ и таймзона */
test('6a. ровно 09.07 00:00 и конец программы — на стыках не ломается', () => {
  // ровно полночь входа: фест-сутки ещё 08-е, предстарт (первое в 10:00)
  const enter = nowView(MSK('2026-07-09T00:00'));
  assert.equal(enter.banner, 'prestart');
  assert.equal(enter.activeDay, null);
  // ровно в конце последнего события: n == LAST → ещё НЕ «завершён» (n > LAST ложно)
  const atLast = nowView(LAST);
  assert.equal(atLast.banner, null, 'ровно в момент конца — ещё не «завершён»');
  // на миллисекунду позже — «завершён»
  assert.equal(nowView(LAST + 1).banner, 'ended');
});

test('6b. таймзона процесса не влияет: сценарии по фиксированным эпохам', () => {
  // 2026-07-13T02:00 МСК == 2026-07-12T23:00 UTC
  assert.equal(MSK('2026-07-13T02:00'), Date.UTC(2026, 6, 12, 23, 0));
  assert.equal(core.getFestivalDay(Date.UTC(2026, 6, 12, 23, 0)), '2026-07-12');
  // предстарт по прямой эпохе UTC
  assert.equal(nowView(Date.UTC(2026, 6, 6, 9, 0)).banner, 'prestart');
});
