'use strict';
/* Фестивальные сутки / «сейчас». Все вычисления — по эпохам, поэтому
   результаты обязаны совпадать в любой таймзоне процесса (npm test
   гоняет сьют в UTC, Новосибирске и Нью-Йорке). */
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../core.js');

const MSK = (iso) => core.epochFromISO(iso);
const ev = (startISO, endISO, extra = {}) =>
  core.decorateEvents([{ startISO, endISO, venue: 'X', title: 'T', ...extra }])[0];

test('2026-07-13T02:00 МСК — ещё фестивальное «вс 12»', () => {
  assert.equal(core.getFestivalDay(MSK('2026-07-13T02:00')), '2026-07-12');
});

test('границы суток: 05:59 — вчера, 06:00 — новый день', () => {
  assert.equal(core.getFestivalDay(MSK('2026-07-11T05:59')), '2026-07-10');
  assert.equal(core.getFestivalDay(MSK('2026-07-11T06:00')), '2026-07-11');
});

test('мультпати ночи вс→пн «идёт» в 02:00', () => {
  const party = ev('2026-07-13T00:30', '2026-07-13T03:30');
  assert.equal(party._festDay, '2026-07-12'); // живёт на вкладке «вс»
  assert.equal(core.statusOf(party, MSK('2026-07-13T02:00')), 'live');
  assert.deepEqual(core.getCurrent([party], MSK('2026-07-13T02:00')), [party]);
});

test('«скоро» сквозь полночь: 23:40 видит событие 00:10', () => {
  const e = ev('2026-07-13T00:10', '2026-07-13T01:00');
  const soon = core.getUpcoming([e], MSK('2026-07-12T23:40'), 60);
  assert.equal(soon.length, 1);
  assert.equal(core.statusOf(e, MSK('2026-07-12T23:40')), 'soon');
});

test('событие 22:00–23:30: в 23:00 «идёт», в 23:31 — нет', () => {
  const e = ev('2026-07-11T22:00', '2026-07-11T23:30');
  assert.equal(core.statusOf(e, MSK('2026-07-11T23:00')), 'live');
  assert.equal(core.statusOf(e, MSK('2026-07-11T23:31')), 'past');
});

test('границы live: ровно в момент старта — «идёт», ровно в момент конца — «прошло»', () => {
  const e = ev('2026-07-11T22:00', '2026-07-11T23:30');
  assert.equal(core.statusOf(e, MSK('2026-07-11T22:00')), 'live');
  assert.equal(core.statusOf(e, MSK('2026-07-11T23:30')), 'past');
});

test('событие без времени конца не падает и даёт разумный статус', () => {
  const e = ev('2026-07-11T22:00', null);
  assert.equal(core.statusOf(e, MSK('2026-07-11T21:00')), 'upcoming');
  assert.equal(core.statusOf(e, MSK('2026-07-11T21:45')), 'soon');
  assert.equal(core.statusOf(e, MSK('2026-07-11T22:01')), 'past');
});

test('сортировка дня: дневные, затем ночные по фактическому времени', () => {
  const evs = core.decorateEvents([
    { startISO: '2026-07-12T02:00', venue: 'a', title: 'ночь2' },
    { startISO: '2026-07-11T12:00', venue: 'b', title: 'день1' },
    { startISO: '2026-07-12T00:30', venue: 'c', title: 'ночь1' },
    { startISO: '2026-07-11T22:00', venue: 'd', title: 'вечер' },
    { startISO: '2026-07-11T19:00', venue: 'e', title: 'день2' },
  ]);
  // все — один фестивальный день
  assert.ok(evs.every(e => e._festDay === '2026-07-11'));
  const order = evs.slice().sort(core.sortByStart).map(e => e.title);
  assert.deepEqual(order, ['день1', 'день2', 'вечер', 'ночь1', 'ночь2']);
});

test('ночной маркер: 01:30 календарной пт — «ночь на пт» на вкладке чт', () => {
  const e = ev('2026-07-10T01:30', '2026-07-10T02:30'); // пятница 01:30
  assert.equal(e._festDay, '2026-07-09'); // вкладка «чт 9»
  const night = core.nightInfo(e);
  assert.ok(night && night.marker.includes('ночь на пт'));
  const evening = ev('2026-07-09T22:00', '2026-07-09T23:00');
  assert.equal(core.nightInfo(evening), null);
  // граница суток: 05:59 — ночь, ровно 06:00 — уже не ночь
  assert.ok(core.nightInfo(ev('2026-07-10T05:59', null)));
  assert.equal(core.nightInfo(ev('2026-07-10T06:00', null)), null);
});

test('таймзона процесса не влияет: эпохи и фест-дни фиксированы', () => {
  // Смысловая проверка внутри любого TZ: сравниваем с заранее известной эпохой
  // 2026-07-11T17:00 МСК == 14:00 UTC
  assert.equal(MSK('2026-07-11T17:00'), Date.UTC(2026, 6, 11, 14, 0));
  const e = ev('2026-07-11T17:00', '2026-07-11T19:00'); // «карнавал»
  assert.equal(core.statusOf(e, Date.UTC(2026, 6, 11, 14, 30)), 'live');
  assert.equal(core.getFestivalDay(Date.UTC(2026, 6, 11, 14, 30)), '2026-07-11');
});

test('getUpcoming: горизонт включительный, прошедшие не попадают', () => {
  const near = ev('2026-07-11T12:30', null, { title: 'близко' });
  const edge = ev('2026-07-11T13:00', null, { title: 'ровно60' });
  const far = ev('2026-07-11T13:01', null, { title: '61мин' });
  const past = ev('2026-07-11T11:00', null, { title: 'прошло' });
  const got = core.getUpcoming([far, past, edge, near], MSK('2026-07-11T12:00'), 60);
  assert.deepEqual(got.map(e => e.title), ['близко', 'ровно60']);
  // без горизонта — все будущие по порядку (так живёт вкладка «Сейчас»)
  const all = core.getUpcoming([far, past, edge, near], MSK('2026-07-11T12:00'));
  assert.deepEqual(all.map(e => e.title), ['близко', 'ровно60', '61мин']);
});
