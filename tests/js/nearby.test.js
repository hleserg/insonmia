'use strict';
/* «Рядом»: дистанции, радиусы, события, стороны света, жизненный цикл. */
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../core.js');

const HERE = { lat: 54.681149, lng: 35.091007 }; // Экран полевой

test('accuracyProfile: тиры радиусов по точности GPS', () => {
  const p = core.accuracyProfile;
  // ≤50 м — точный GPS: мелкие радиусы, дистанции точные
  assert.deepEqual(p(30).radii, [150, 300, 600, 0]);
  assert.equal(p(30).approx, false);
  assert.equal(p(30).unusable, false);
  assert.equal(p(50).tierKey, 'fine', 'ровно 50 — ещё точный');
  // 50–200 м — средний
  assert.deepEqual(p(120).radii, [300, 600, 1000, 0]);
  assert.equal(p(120).approx, false);
  assert.equal(p(200).tierKey, 'mid', 'ровно 200 — ещё средний');
  // >200 м — грубый: крупные радиусы, дистанции приблизительные (~)
  assert.deepEqual(p(500).radii, [500, 1000, 2000, 0]);
  assert.equal(p(500).approx, true, '>200 → дистанции с ~');
  assert.equal(p(201).approx, true, 'ровно за границей 200 → approx');
  assert.equal(p(500).unusable, false);
  // >1000 м — «рядом» не работает осмысленно
  assert.equal(p(1000).unusable, false, 'ровно 1000 — ещё юзабельно');
  assert.equal(p(1500).unusable, true, '>1000 → unusable');
  assert.equal(p(1500).approx, true);
});

test('accuracyProfile: null/0/некорректная точность → лучший тир (мок/десктоп)', () => {
  const p = core.accuracyProfile;
  for (const bad of [null, undefined, 0, -5, NaN]) {
    const r = p(bad);
    assert.deepEqual(r.radii, [150, 300, 600, 0], `acc=${bad} → мелкие радиусы`);
    assert.equal(r.approx, false, `acc=${bad} → не approx`);
    assert.equal(r.unusable, false, `acc=${bad} → не unusable`);
  }
  assert.equal(p(null).acc, null, 'acc сохраняется как null');
  assert.equal(p(30).acc, 30);
});

test('accuracyProfile: tierKey стабилен внутри категории (плавное обновление)', () => {
  const p = core.accuracyProfile;
  // джиттер внутри «fine» — ключ и радиусы не меняются (список не «дёргается»)
  assert.equal(p(20).tierKey, p(45).tierKey);
  assert.deepEqual(p(20).radii, p(45).radii);
  // пересечение границы — ключ меняется (радиусы адаптируются один раз)
  assert.notEqual(p(45).tierKey, p(120).tierKey);
});

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
  // порядок НАМЕРЕННО перемешан: сортировку по дистанции обязан делать getNearby
  const points = [
    { id: 'p2', name: '~440м', lat: HERE.lat + 0.004, lng: HERE.lng, category: 'wc' },
    { id: 'p0', name: 'здесь', lat: HERE.lat, lng: HERE.lng, category: 'screen' },
    { id: 'p3', name: '~1100м', lat: HERE.lat + 0.01, lng: HERE.lng, category: 'art' },
    { id: 'p1', name: '~110м', lat: HERE.lat + 0.001, lng: HERE.lng, category: 'food' },
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

test('границы: точка ровно на радиусе включается (<=), горизонт ровно 60 мин', () => {
  const now = core.epochFromISO('2026-07-10T22:30');
  // точка ровно в 300 м (0.0026978° ≈ 300.0 м — вычислим точно)
  const dLat = 300 / 111195;
  const pts = [{ id: 'edge', name: 'граница', lat: HERE.lat + dLat, lng: HERE.lng, category: 'art' }];
  const exact = core.distanceM(HERE, pts[0]);
  const got = core.getNearby(pts, [], HERE, now, exact, {});
  assert.equal(got.length, 1, `точка в ${exact} м обязана войти в радиус ${exact}`);
  // событие ровно через 60 минут — в горизонте; 61 — нет
  const evs = core.decorateEvents([
    { startISO: '2026-07-10T23:30', endISO: '2026-07-11T00:00', venue: 'V', title: 'ровно60' },
    { startISO: '2026-07-10T23:31', endISO: '2026-07-11T00:00', venue: 'V', title: '61мин' },
  ]);
  const here = core.getNearby(
    [{ id: 'v', name: 'v', lat: HERE.lat, lng: HERE.lng, category: 'venue' }],
    evs, HERE, now, 0, { V: ['v'] })[0];
  assert.deepEqual(here.events.map(e => e.title), ['ровно60']);
});

test('событие без конца не считается вечным «идёт» в getNearby', () => {
  const now = core.epochFromISO('2026-07-10T22:30');
  const evs = core.decorateEvents([
    { startISO: '2026-07-09T12:00', endISO: null, venue: 'V', title: 'вчера-без-конца' },
  ]);
  const here = core.getNearby(
    [{ id: 'v', name: 'v', lat: HERE.lat, lng: HERE.lng, category: 'venue' }],
    evs, HERE, now, 0, { V: ['v'] })[0];
  assert.equal(here.events.length, 0);
});

test('стороны света: диагонали', () => {
  // на этой широте 0.001° lat ≈ 111 м; чтобы азимут был ~45°, lng-шаг больше
  const dLng = 0.001 / Math.cos(HERE.lat * Math.PI / 180);
  assert.equal(core.bearingLabel(HERE, { lat: HERE.lat + 0.001, lng: HERE.lng + dLng }), 'северо-восточнее');
  assert.equal(core.bearingLabel(HERE, { lat: HERE.lat - 0.001, lng: HERE.lng + dLng }), 'юго-восточнее');
  assert.equal(core.bearingLabel(HERE, { lat: HERE.lat - 0.001, lng: HERE.lng - dLng }), 'юго-западнее');
  assert.equal(core.bearingLabel(HERE, { lat: HERE.lat + 0.001, lng: HERE.lng - dLng }), 'северо-западнее');
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

test('watch-throttle: прореживает внутри интервала и ПРИНИМАЕТ после', () => {
  let handler;
  const fakeGeo = {
    watchPosition(cb) { handler = cb; return 7; },
    clearWatch() {},
  };
  const fixes = [];
  let fakeNow = 1000000;
  const w = core.createGeoWatcher(fakeGeo, p => fixes.push(p), 10000, () => fakeNow);
  w.start();
  const mk = (lat) => ({ coords: { latitude: lat, longitude: 35 } });
  handler(mk(54.1));                    // t=0 — принят
  fakeNow += 3000; handler(mk(54.2));   // +3с — отброшен
  fakeNow += 3000; handler(mk(54.3));   // +6с — отброшен
  assert.deepEqual(fixes.map(f => f.lat), [54.1]);
  fakeNow += 5000; handler(mk(54.4));   // +11с — ПРИНЯТ (иначе позиция «замерзает»)
  assert.deepEqual(fixes.map(f => f.lat), [54.1, 54.4]);
  fakeNow += 10000; handler(mk(54.5));  // ещё интервал — принят
  assert.equal(fixes.length, 3);
});

test('watch-accuracy-гейт: грубый фикс (сетевой/сотовый) НЕ выдаётся за место', () => {
  let handler;
  const fakeGeo = { watchPosition(cb) { handler = cb; return 3; }, clearWatch() {} };
  const fixes = [];
  let fakeNow = 1000000;
  // порог 500 м: реальный GPS (метры) проходит, километровый фолбэк — нет
  const w = core.createGeoWatcher(fakeGeo, p => fixes.push(p), 10000, () => fakeNow, null, 500);
  w.start();
  const mk = (lat, acc) => ({ coords: { latitude: lat, longitude: 35, accuracy: acc } });
  handler(mk(54.9, 5000));   // 5 км — грубый фолбэк, ОТБРОШЕН (не «врём» точкой)
  assert.equal(fixes.length, 0, 'фикс с accuracy 5000 м не принят');
  // грубый фикс не должен был занять троттл-окно: следующий ТОЧНЫЙ идёт сразу
  handler(mk(54.68, 12));    // 12 м — реальный GPS, ПРИНЯТ немедленно
  assert.deepEqual(fixes.map(f => f.lat), [54.68]);
  assert.equal(fixes[0].acc, 12, 'accuracy прокинута в фикс');
  // граница: ровно порог — принимаем (не хуже), чуть хуже — нет
  fakeNow += 20000; handler(mk(54.60, 500));
  fakeNow += 20000; handler(mk(54.61, 500.1));
  assert.deepEqual(fixes.map(f => f.lat), [54.68, 54.60], 'accuracy==500 принят, >500 отброшен');
  // accuracy=0 (дефолт Playwright newContext({geolocation})) — валиден, проходит
  fakeNow += 20000; handler(mk(54.62, 0));
  assert.equal(fixes[fixes.length - 1].lat, 54.62, 'accuracy==0 принят (не путать с «нет фикса»)');
});

test('watch-accuracy: без порога (по умолчанию) точность игнорируется — обратная совместимость', () => {
  let handler;
  const fakeGeo = { watchPosition(cb) { handler = cb; return 4; }, clearWatch() {} };
  const fixes = [];
  const w = core.createGeoWatcher(fakeGeo, p => fixes.push(p), 0); // без accuracyLimitM
  w.start();
  handler({ coords: { latitude: 54.7, longitude: 35, accuracy: 99999 } });
  handler({ coords: { latitude: 54.7, longitude: 35 } }); // accuracy отсутствует
  assert.equal(fixes.length, 2, 'без порога любой фикс проходит (в т.ч. без accuracy)');
});

test('watch-ошибки: onError получает код, опции форсят GPS (ЯБ/офлайн)', () => {
  let errHandler = null, opts = null;
  const fakeGeo = {
    watchPosition(cb, err, o) { errHandler = err; opts = o; return 1; },
    clearWatch() {},
  };
  const errors = [];
  const w = core.createGeoWatcher(fakeGeo, () => {}, 0, Date.now, e => errors.push(e));
  w.start();
  // enableHighAccuracy: сетевое определение (дефолт Яндекс Браузера)
  // не работает без интернета — нужен именно GPS
  assert.equal(opts.enableHighAccuracy, true);
  assert.ok(opts.timeout >= 10000, 'timeout должен давать GPS время на захват');
  errHandler({ code: 2 });               // POSITION_UNAVAILABLE
  errHandler({ code: 1 });               // PERMISSION_DENIED
  assert.deepEqual(errors.map(e => e.code), [2, 1]);
  // без onError ошибка не роняет колбэк (обратная совместимость)
  const w2 = core.createGeoWatcher(fakeGeo, () => {}, 0);
  w2.start();
  assert.doesNotThrow(() => errHandler({ code: 3 }));
});
