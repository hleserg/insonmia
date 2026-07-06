'use strict';
/* Площадки берутся AS-IS: пайплайн НЕ переименовывает названия. Плейсхолдер
   оргов «тстцтсттсцтс» должен доезжать до данных дословно (а не как выдуманное
   «Сцена (уточняется)»), и мэтчиться со своей точкой на карте по имени.
   Гард от возврата любой «самовольной подмены» названий в конвертерах. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const program = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'program.json'), 'utf8'));
const geo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'geo.json'), 'utf8'));
const PLACEHOLDER = 'тстцтсттсцтс';

test('program.json: плейсхолдер площадки — дословно, без переименования', () => {
  const venues = new Set(program.events.map(e => (e.venue || '')));
  assert.ok([...venues].some(v => v === PLACEHOLDER),
    'нет события на площадке «тстцтсттсцтс» (значит переименовали): ' + JSON.stringify([...venues].filter(v => /тстц/i.test(v))));
});

test('program.json: НИГДЕ нет выдуманного «Сцена (уточняется)»', () => {
  const hit = program.events.filter(e => /уточня/i.test(e.venue || ''));
  assert.equal(hit.length, 0, 'осталась подмена в событиях: ' + hit.length);
  assert.ok(!(program.venues || []).some(v => /уточня/i.test(v)), 'подмена в venues[]');
  assert.ok(!Object.keys(program.venueInfo || {}).some(k => /уточня/i.test(k)), 'подмена в venueInfo');
});

test('geo.json: точка плейсхолдера есть, мэтчинг событие↔точка сходится по имени', () => {
  const pt = (geo.points || []).find(p => /тстц/i.test(p.name || ''));
  assert.ok(pt, 'нет точки «Тстцтсттсцтс» в geo.json');
  const vp = geo.venuePoints || {};
  // мэтчинг по норм-имени: ключ venuePoints — «тстцтсттсцтс», ведёт на id точки
  assert.ok(Array.isArray(vp[PLACEHOLDER]) && vp[PLACEHOLDER].includes(pt.id),
    'venuePoints не связал «тстцтсттсцтс» с точкой ' + pt.id + ': ' + JSON.stringify(vp[PLACEHOLDER]));
  assert.ok(!Object.keys(vp).some(k => /уточня/i.test(k)), 'в venuePoints остался ключ с «уточня»');
});

test('конвертеры не содержат правила переименования площадок (гард от регресса)', () => {
  for (const f of ['scripts/scrape_site.py', 'scripts/convert_xlsx.py', 'app.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/Сцена \(уточня/i.test(src), `${f}: вернулась подстановка «Сцена (уточняется)»`);
    assert.ok(!/normalize_?venue/i.test(src), `${f}: вернулась функция normalize_venue/normalizeVenue`);
  }
});
