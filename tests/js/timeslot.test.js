'use strict';
/* Слоты по времени суток (фильтр «Время»). Слот определяется ТОЛЬКО по мск-часу
   НАЧАЛА события — значит результат не зависит от таймзоны процесса (сьют гоняет
   в UTC, Новосибирске, Нью-Йорке). Стык с фестивальными сутками: слот и фестдень —
   два независимых измерения (ночное 01:30 → слот «23-08» И фестдень пред. даты). */
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../core.js');

const MSK = (iso) => core.epochFromISO(iso);
const slot = (iso) => core.timeSlotKey(MSK(iso));

test('слот по времени НАЧАЛА: 10:45 → 08-11 (по старту, не по концу)', () => {
  assert.equal(slot('2026-07-10T10:45'), '08-11');
});

test('границы дневных слотов включительно снизу, исключительно сверху', () => {
  assert.equal(slot('2026-07-10T08:00'), '08-11');
  assert.equal(slot('2026-07-10T10:59'), '08-11');
  assert.equal(slot('2026-07-10T11:00'), '11-14');
  assert.equal(slot('2026-07-10T13:59'), '11-14');
  assert.equal(slot('2026-07-10T14:00'), '14-17');
  assert.equal(slot('2026-07-10T17:00'), '17-20');
  assert.equal(slot('2026-07-10T20:00'), '20-23');
  assert.equal(slot('2026-07-10T22:59'), '20-23');
});

test('ночной слот 23-08 ловит 23:00, 23:30, 02:00, 07:30, 07:59', () => {
  assert.equal(slot('2026-07-10T23:00'), '23-08');
  assert.equal(slot('2026-07-10T23:30'), '23-08');
  assert.equal(slot('2026-07-11T00:00'), '23-08');
  assert.equal(slot('2026-07-11T02:00'), '23-08');
  assert.equal(slot('2026-07-11T07:30'), '23-08');
  assert.equal(slot('2026-07-11T07:59'), '23-08');
});

test('08:00 — уже НЕ ночь (первый дневной слот)', () => {
  assert.equal(slot('2026-07-11T08:00'), '08-11');
});

test('стык с фестсутками: 01:30 → слот 23-08 И фестдень предыдущей даты', () => {
  const e = core.decorateEvents([{ startISO: '2026-07-13T01:30', endISO: '2026-07-13T02:30',
    venue: 'X', title: 'T' }])[0];
  assert.equal(core.timeSlotKey(e._startMs), '23-08');
  assert.equal(e._festDay, '2026-07-12'); // ночь на пн живёт на вкладке «вс 12»
});

test('вечернее 20:00–23:00: событие 20:30 → слот 20-23', () => {
  assert.equal(slot('2026-07-11T20:30'), '20-23');
});

test('нет времени старта → slotKey null (не падает)', () => {
  assert.equal(core.timeSlotKey(null), null);
});

test('все 24 часа покрыты (ни одного null для валидного времени)', () => {
  for (let h = 0; h < 24; h++) {
    const iso = `2026-07-10T${String(h).padStart(2, '0')}:00`;
    assert.notEqual(core.timeSlotKey(MSK(iso)), null, `час ${h} без слота`);
  }
});

test('TIME_SLOTS — ровно 6 слотов, ночь последней и помечена', () => {
  assert.equal(core.TIME_SLOTS.length, 6);
  const last = core.TIME_SLOTS[core.TIME_SLOTS.length - 1];
  assert.equal(last.key, '23-08');
  assert.equal(last.night, true);
});
