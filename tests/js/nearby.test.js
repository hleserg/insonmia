'use strict';
/* «Рядом»: дистанции, радиусы, события, стороны света, жизненный цикл. */
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../core.js');

const HERE = { lat: 54.681149, lng: 35.091007 }; // Экран полевой

test('distanceM: известные дистанции с допуском ±1%', () => {
  // 1 градус широты ≈ 111.19 км
  assert.ok(Math.abs(core.distanceM({ lat: 54, lng: 35 }, { lat: 55, lng: 35 }) - 111195) < 1112);
  // 0.001° широты ≈ 111.2 м
  const d = core.distanceM(HERE, { lat: HERE.lat + 0.001, lng: HERE.lng });
  assert.ok(Math.abs(d - 111) <= 2, `d=${d}`);
  // та же точка — 0 м
  assert.equal(core.distanceM(HERE, HERE), 0);
});

test('стороны света: точка строго севернее — «севернее»', () => {
  assert.equal(core.bearingLabel(HERE, { lat: HERE.lat + 0.001, lng: HERE.lng }), 'севернее');
  assert.equal(core.bearingLabel(HERE, { lat: HERE.lat, lng: HERE.lng + 0.001 }), 'восточнее');
  assert.equal(core.bearingLabel(HERE, { lat: HERE.lat - 0.001, lng: HERE.lng }), 'южнее');
  assert.equal(core.bearingLabel(HERE, { lat: HERE.lat, lng: HERE.lng - 0.001 }), 'западнее');
});

function fixture() {
  const points = [
    { id: 'p0', name: 'здесь', lat: HERE.lat, lng: HERE.lng, category: 'screen' },
    { id: 'p1', name: '~110м', lat: HERE.lat + 0.001, lng: HERE.lng, category: 'food' },
    { id: 'p2', name: '~440м', lat: HERE.lat + 0.004, lng: HERE.lng, category: 'wc' },
    { id: 'p3', name: '~1100м', lat: HERE.lat + 0.01, lng: HERE.lng, category: 'art' },
  ];
  const now = core.epochFromISO('2026-07-10T22:30');
  const events = core.decorateEvents([
    { startISO: '2026-07-10T22:00', endISO: '2026-07-10T23:15', venue: 'Здесь', title: 'идёт' },
    { startISO: '2026-07-10T23:00', endISO: '2026-07-11T00:00', venue: 'Здесь', title: 'скоро30' },
    { startISO: '2026-07-11T00:15', endISO: '2026-07-11T01:00', venue: 'Здесь', title: 'за105мин' },
    { startISO: '2026-07-10T23:20', endISO: '2026-07-11T00:00', venue: 'Дальняя', title: 'вне радиуса' },
  ]);
  const venuePoints = { 'Здесь': ['p0'], 'Дальняя': ['p3'] };
  return { points, events, now, venuePoints };
}

test('радиусы 150/300/600/всё — корректные наборы и сортировка', () => {
  const { points, events, now, venuePoints } = fixture();
  const r = (m) => core.getNearby(points, events, HERE, now, m, venuePoints).map(p => p.id);
  assert.deepEqual(r(150), ['p0', 'p1']);
  assert.deepEqual(r(300), ['p0', 'p1']);
  assert.deepEqual(r(600), ['p0', 'p1', 'p2']);
  assert.deepEqual(r(0), ['p0', 'p1', 'p2', 'p3']); // 0 = всё
  // сортировка по дистанции, метры в подписи
  const all = core.getNearby(points, events, HERE, now, 0, venuePoints);
  assert.ok(all[0].dist === 0 && all[1].dist > 0 && all[1].dist <= 150);
  for (let i = 1; i < all.length; i++) assert.ok(all[i].dist >= all[i - 1].dist);
});

test('события точки: «идёт» раньше «скоро», горизонт 60 мин', () => {
  const { points, events, now, venuePoints } = fixture();
  const here = core.getNearby(points, events, HERE, now, 150, venuePoints)[0];
  assert.deepEqual(here.events.map(e => e.title), ['идёт', 'скоро30']);
  // событие через 105 минут — за горизонтом
  assert.ok(!here.events.some(e => e.title === 'за105мин'));
});

test('площадки вне радиуса не просачиваются', () => {
  const { points, events, now, venuePoints } = fixture();
  const within = core.getNearby(points, events, HERE, now, 600, venuePoints);
  const titles = within.flatMap(p => p.events.map(e => e.title));
  assert.ok(!titles.includes('вне радиуса'));
});

test('пустой результат в глухом углу при R=150', () => {
  const { points, events, now, venuePoints } = fixture();
  const corner = { lat: 54.675, lng: 35.057 };
  const got = core.getNearby(points, events, corner, now, 150, venuePoints);
  assert.equal(got.length, 0);
});

test('watch-lifecycle: start/stop без утечек, clearWatch ровно один раз', () => {
  const calls = { watch: 0, clear: 0, cleared: [] };
  let nextId = 1;
  const fakeGeo = {
    watchPosition(cb) { calls.watch++; return nextId++; },
    clearWatch(id) { calls.clear++; calls.cleared.push(id); },
  };
  const fixes = [];
  const w = core.createGeoWatcher(fakeGeo, p => fixes.push(p), 0);
  // вход
  w.start();
  assert.equal(calls.watch, 1);
  assert.ok(w.active);
  // повторный start — без второй подписки
  w.start();
  assert.equal(calls.watch, 1);
  // выход
  w.stop();
  assert.equal(calls.clear, 1);
  assert.ok(!w.active);
  // повторный stop — clearWatch НЕ дёргается второй раз
  w.stop();
  assert.equal(calls.clear, 1);
  // повторный вход/выход — новая подписка и ровно одна очистка
  w.start();
  w.stop();
  assert.equal(calls.watch, 2);
  assert.equal(calls.clear, 2);
  assert.deepEqual(calls.cleared, [1, 2]);
});

test('watch-throttle: частые фиксы прореживаются', async () => {
  let handler;
  const fakeGeo = {
    watchPosition(cb) { handler = cb; return 7; },
    clearWatch() {},
  };
  const fixes = [];
  const w = core.createGeoWatcher(fakeGeo, p => fixes.push(p), 10000);
  w.start();
  const mk = (lat) => ({ coords: { latitude: lat, longitude: 35 } });
  handler(mk(54.1));
  handler(mk(54.2)); // в пределах троттла — отбрасывается
  handler(mk(54.3));
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].lat, 54.1);
});
