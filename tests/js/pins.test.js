'use strict';
/* Пользовательские метки: парсинг координат/текста, диплинк, upsert, bbox. */
const test = require('node:test');
const assert = require('assert');
const core = require('../../core.js');

test('координаты с русской запятой: «54,68712 35,07934» — одна пара', () => {
  const p = core.parseCoordPairs('54,68712 35,07934');
  assert.equal(p.length, 1);
  assert.ok(Math.abs(p[0].lat - 54.68712) < 1e-9);
  assert.ok(Math.abs(p[0].lng - 35.07934) < 1e-9);
});

test('4 числа попарно — две метки; целые числа координатами не считаются', () => {
  const p = core.parseCoordPairs('54.687 35.079 54.690 35.081');
  assert.equal(p.length, 2);
  assert.ok(Math.abs(p[1].lng - 35.081) < 1e-9);
  // «встретимся у сцены 5 в 19 часов» — не координаты
  assert.equal(core.parseCoordPairs('встретимся у сцены 5 в 19 часов').length, 0);
});

test('geo:-URI и русская запятая внутри geo: парсятся', () => {
  const pins = core.parsePinsFromText('geo:54.68712,35.07934\ngeo:54,690,35,081');
  assert.equal(pins.length, 2);
  assert.ok(Math.abs(pins[1].lat - 54.690) < 1e-9);
});

test('«добавить из текста»: имя берётся из соседней строки', () => {
  const pins = core.parsePinsFromText('Наш лагерь\n54,68712 35,07934\n\n54.690 35.081\nМашина');
  assert.equal(pins.length, 2);
  assert.equal(pins[0].name, 'Наш лагерь');
  assert.equal(pins[1].name, 'Машина'); // сверху координаты — имя нашлось снизу
});

test('диплинк: pinToHash/pinFromHash — roundtrip со спецсимволами и эмодзи', () => {
  const pin = { lat: 54.68712, lng: 35.07934, name: 'Лагерь «У ручья» #1, наш', emoji: '⛺' };
  const back = core.pinFromHash('https://x.dev/insonmia/' + core.pinToHash(pin));
  assert.equal(back.name, pin.name);
  assert.equal(back.emoji, '⛺');
  assert.ok(Math.abs(back.lat - pin.lat) < 1e-4 && Math.abs(back.lng - pin.lng) < 1e-4);
});

test('диплинк: мусор не роняет парсер', () => {
  assert.equal(core.pinFromHash('#pin=abc,def'), null);
  assert.equal(core.pinFromHash('#pin=999,35.07,x'), null); // lat за пределами
  assert.equal(core.pinFromHash('#nope'), null);
  assert.equal(core.pinFromHash(''), null);
  const half = core.pinFromHash('#pin=54.68,35.07'); // без имени/эмодзи — ок
  assert.ok(half && half.name === '' && half.emoji === '');
});

test('upsert: повторное имя (регистр/пробелы) обновляет, не дублирует', () => {
  let r = core.upsertPin([], { name: 'Лагерь', lat: 54.68, lng: 35.07, emoji: '⛺' });
  r = core.upsertPin(r.pins, { name: '  лагерь ', lat: 54.69, lng: 35.08, emoji: '🔥' });
  assert.equal(r.pins.length, 1);
  assert.ok(r.updated);
  assert.equal(r.pins[0].emoji, '🔥');
  assert.ok(Math.abs(r.pins[0].lat - 54.69) < 1e-9);
});

test('upsert: лимит 50 — 51-я метка отклоняется, обновление существующей — нет', () => {
  let pins = [];
  for (let i = 0; i < 50; i++) pins = core.upsertPin(pins, { name: 'p' + i, lat: 54.68, lng: 35.07 }).pins;
  const over = core.upsertPin(pins, { name: 'p50', lat: 54.68, lng: 35.07 });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'limit');
  assert.equal(over.pins.length, 50);
  const upd = core.upsertPin(pins, { name: 'p10', lat: 54.699, lng: 35.09 });
  assert.ok(upd.ok && upd.updated && upd.pins.length === 50);
});

test('bbox ±10 км: на поляне — тихо, в 20+ км — мягкое предупреждение', () => {
  assert.equal(core.pinOutsideFest({ lat: 54.685, lng: 35.075 }), false);
  assert.equal(core.pinOutsideFest({ lat: 54.62, lng: 35.075 }), false); // ~7 км юг — в запасе
  assert.equal(core.pinOutsideFest({ lat: 54.50, lng: 35.075 }), true);  // ~20 км
  assert.equal(core.pinOutsideFest({ lat: 54.685, lng: 35.40 }), true);  // ~20 км восток
});
