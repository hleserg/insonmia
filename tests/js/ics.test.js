'use strict';
/* Экспорт в календарь (RFC 5545). Чистая логика core.js, без DOM. */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../core.js');

// фиксированный момент генерации — детерминизм DTSTAMP
const DTSTAMP = Date.UTC(2026, 6, 1, 12, 0, 0); // 20260701T120000Z
const opts = { dtstampMs: DTSTAMP };

function ev(over) {
  return Object.assign({
    id: 'abc123', type: 'program', title: 'Показ',
    startISO: '2026-07-11T17:00', endISO: '2026-07-11T18:30',
    venue: 'Экран №1', description: 'Ночная анимация',
  }, over || {});
}

// развернуть фолдинг (CRLF + пробел) обратно в логические строки
function unfold(ics) {
  return ics.replace(/\r\n[ \t]/g, '');
}
function lines(ics) { return unfold(ics).split('\r\n'); }

test('1. 11.07 17:00 МСК → DTSTART 14:00Z, VALARM по умолчанию -PT15M', () => {
  const ics = C.buildICS([ev()], opts);
  const L = lines(ics);
  assert.ok(L.includes('DTSTART:20260711T140000Z'), 'DTSTART должен быть 14:00Z (17:00 МСК − 3ч)');
  assert.ok(L.includes('DTEND:20260711T153000Z'), 'DTEND 15:30Z');
  assert.ok(L.includes('TRIGGER:-PT15M'), 'без opts.leadMin — 15 минут');
  assert.ok(L.includes('ACTION:DISPLAY'), 'VALARM DISPLAY');
  assert.ok(L.includes('BEGIN:VALARM') && L.includes('END:VALARM'));
});

test('withAlarm=false → НИ ОДНОГО VALARM (полная выгрузка программы)', () => {
  const many = [1, 2, 3, 4, 5].map(i => ev({ id: 'p' + i }));
  const ics = C.buildICS(many, { ...opts, withAlarm: false });
  const L = lines(ics);
  assert.equal(L.filter(l => l === 'BEGIN:VALARM').length, 0, 'без будильников');
  assert.equal(L.filter(l => l === 'BEGIN:VEVENT').length, 5, 'события на месте');
  assert.equal(L.filter(l => l.startsWith('TRIGGER:')).length, 0, 'нет TRIGGER');
  // UID стабильны и в режиме без будильника — повторный импорт не плодит дубли
  assert.ok(L.includes('UID:p1@insonmia') && L.includes('UID:p5@insonmia'));
});

test('withAlarm по умолчанию true (одиночное/избранное) — VALARM на месте', () => {
  const L = lines(C.buildICS([ev()], opts));
  assert.equal(L.filter(l => l === 'BEGIN:VALARM').length, 1, 'по умолчанию с будильником');
  // явный true — тоже
  assert.equal(lines(C.buildICS([ev()], { ...opts, withAlarm: true })).filter(l => l === 'BEGIN:VALARM').length, 1);
});

test('одинаковый UID в режимах с будильником и без (нет дублей при смешанном импорте)', () => {
  const withA = lines(C.buildICS([ev()], opts)).find(l => l.startsWith('UID:'));
  const noA = lines(C.buildICS([ev()], { ...opts, withAlarm: false })).find(l => l.startsWith('UID:'));
  assert.equal(withA, noA, 'UID совпадает: календарь видит одно событие');
  assert.equal(withA, 'UID:abc123@insonmia');
});

test('VALARM берёт выбранное пользователем время (opts.leadMin)', () => {
  assert.ok(lines(C.buildICS([ev()], { ...opts, leadMin: 30 })).includes('TRIGGER:-PT30M'), '30 мин');
  assert.ok(lines(C.buildICS([ev()], { ...opts, leadMin: 5 })).includes('TRIGGER:-PT5M'), '5 мин');
  assert.ok(lines(C.buildICS([ev()], { ...opts, leadMin: 60 })).includes('TRIGGER:-PT60M'), '60 мин');
  // мусор/некорректное → дефолт 15
  assert.ok(lines(C.buildICS([ev()], { ...opts, leadMin: 0 })).includes('TRIGGER:-PT15M'), '0 → 15');
  assert.ok(lines(C.buildICS([ev()], { ...opts, leadMin: NaN })).includes('TRIGGER:-PT15M'), 'NaN → 15');
});

test('2. структурная валидность: VCALENDAR/VERSION/парные BEGIN-END', () => {
  const ics = C.buildICS([ev()], opts);
  const L = lines(ics);
  assert.equal(L[0], 'BEGIN:VCALENDAR');
  assert.equal(L[L.length - 2], 'END:VCALENDAR'); // последняя — пустая после хвостового CRLF
  assert.ok(L.includes('VERSION:2.0'));
  assert.ok(L.some(l => l.startsWith('PRODID:')));
  const beg = L.filter(l => l === 'BEGIN:VEVENT').length;
  const end = L.filter(l => l === 'END:VEVENT').length;
  assert.equal(beg, 1); assert.equal(end, 1);
  assert.ok(L.some(l => l.startsWith('DTSTAMP:20260701T120000Z')), 'DTSTAMP момента генерации');
});

test('3. ночное 02:00 МСК → корректный UTC (23:00Z предыдущего дня, не съезжает)', () => {
  const ics = C.buildICS([ev({ startISO: '2026-07-12T02:00', endISO: '2026-07-12T03:00' })], opts);
  const L = lines(ics);
  // 02:00 МСК 12 июля == 23:00 UTC 11 июля — это ПРАВИЛЬНЫЙ момент
  assert.ok(L.includes('DTSTART:20260711T230000Z'), 'момент 02:00 МСК = 23:00Z пред. дня');
  assert.ok(L.includes('DTEND:20260712T000000Z'), '03:00 МСК = 00:00Z');
  // и точно НЕ наивная склейка 02:00Z
  assert.ok(!ics.includes('T020000Z'), 'не должно быть наивного 02:00Z');
});

test('4. повторный импорт того же события → стабильный UID (обновление, не дубль)', () => {
  const a = C.buildICS([ev()], opts);
  const b = C.buildICS([ev()], opts);
  assert.equal(a, b, 'один и тот же вход даёт идентичный ICS');
  assert.ok(lines(a).includes('UID:abc123@insonmia'), 'UID = id@insonmia');
  // разные события — разные UID
  const two = lines(C.buildICS([ev(), ev({ id: 'zzz999' })], opts));
  assert.ok(two.includes('UID:abc123@insonmia') && two.includes('UID:zzz999@insonmia'));
});

test('5. избранное из 5 событий → один VCALENDAR, 5 VEVENT', () => {
  const many = [1, 2, 3, 4, 5].map(i => ev({ id: 'id' + i, title: 'Событие ' + i }));
  const ics = C.buildICS(many, opts);
  const L = lines(ics);
  assert.equal(L.filter(l => l === 'BEGIN:VCALENDAR').length, 1);
  assert.equal(L.filter(l => l === 'END:VCALENDAR').length, 1);
  assert.equal(L.filter(l => l === 'BEGIN:VEVENT').length, 5);
  assert.equal(new Set(L.filter(l => l.startsWith('UID:'))).size, 5, '5 разных UID');
});

test('7. запятая/точка-с-запятой/перенос в названии → экранированы, ICS цел', () => {
  const ics = C.buildICS([ev({ title: 'Кино, ужин; и\nночь', description: 'a, b; c' })], opts);
  const L = lines(ics);
  const summary = L.find(l => l.startsWith('SUMMARY:'));
  assert.equal(summary, 'SUMMARY:Кино\\, ужин\\; и\\nночь', 'спецсимволы по RFC экранированы');
  // структура не сломалась
  assert.equal(L.filter(l => l === 'BEGIN:VEVENT').length, 1);
  assert.equal(L.filter(l => l === 'END:VEVENT').length, 1);
  assert.ok(L.find(l => l.startsWith('DESCRIPTION:')).includes('a\\, b\\; c'));
});

test('DTEND по умолчанию = старт + 1 час, если конца нет', () => {
  const ics = C.buildICS([ev({ endISO: null, end: null })], opts);
  const L = lines(ics);
  assert.ok(L.includes('DTSTART:20260711T140000Z'));
  assert.ok(L.includes('DTEND:20260711T150000Z'), 'без конца → +1 час');
});

test('DTEND ≤ старт (битые данные) → тоже старт + 1 час', () => {
  const ics = C.buildICS([ev({ endISO: '2026-07-11T16:00' })], opts); // конец раньше старта
  assert.ok(lines(ics).includes('DTEND:20260711T150000Z'));
});

test('CRLF повсюду и хвостовой CRLF', () => {
  const ics = C.buildICS([ev()], opts);
  assert.ok(ics.endsWith('\r\n'), 'файл кончается CRLF');
  assert.ok(!/[^\r]\n/.test(ics), 'нет одиночных LF без CR');
});

test('фолдинг длинной кириллической строки: каждая физическая строка ≤75 октетов', () => {
  const longTitle = 'Очень длинное название события на кириллице '.repeat(5).trim();
  const ics = C.buildICS([ev({ title: longTitle })], opts);
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `строка >75 октетов: "${line}"`);
  }
  // и после развёртки SUMMARY целостен
  const L = lines(ics);
  assert.ok(L.some(l => l.startsWith('SUMMARY:') && l.includes(longTitle)), 'развёрнутый SUMMARY цел');
});

test('фолдинг не рвёт многобайтный символ (валидный UTF-8 на стыке)', () => {
  const ics = C.buildICS([ev({ title: 'ё'.repeat(80) })], opts); // ё = 2 байта
  for (const line of ics.split('\r\n')) {
    // строка должна быть валидным UTF-8: round-trip через Buffer без замен
    const b = Buffer.from(line, 'utf8');
    assert.equal(b.toString('utf8'), line, 'символ разорван на границе фолдинга');
  }
});

test('событие без старта пропускается (нельзя запланировать)', () => {
  const ics = C.buildICS([ev({ startISO: null }), ev({ id: 'ok1' })], opts);
  const L = lines(ics);
  assert.equal(L.filter(l => l === 'BEGIN:VEVENT').length, 1, 'только валидное событие');
  assert.ok(L.includes('UID:ok1@insonmia'));
});

test('пустой список → валидный VCALENDAR без VEVENT', () => {
  const ics = C.buildICS([], opts);
  const L = lines(ics);
  assert.equal(L[0], 'BEGIN:VCALENDAR');
  assert.ok(L.includes('END:VCALENDAR'));
  assert.equal(L.filter(l => l === 'BEGIN:VEVENT').length, 0);
});

test('buildICS использует _startMs, если он уже посчитан (decorateEvents)', () => {
  const e = ev({ startISO: 'битая строка', endISO: null });
  e._startMs = C.epochFromISO('2026-07-11T17:00');
  e._endMs = null;
  const ics = C.buildICS([e], opts);
  assert.ok(lines(ics).includes('DTSTART:20260711T140000Z'), '_startMs имеет приоритет');
});
