'use strict';
/* Гайд «офлайн гугл-карта» выпилен из планов: метки Google офлайн не живут,
   заменено встроенной картой (Leaflet + свои данные). Этот тест закрепляет,
   что в рантайме и данных НЕТ ссылок на Google-карты — чтобы они не
   вернулись случайно (например, с обновлением данных с сайта). */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// vendor/ не сканируем: внутренности чужих библиотек — не пользовательские ссылки
const RUNTIME = [
  'index.html', 'mesh.html', 'app.js', 'map.js', 'core.js', 'sw.js',
  'styles.css', 'manifest.webmanifest',
  'data/program.json', 'data/geo.json', 'data/basemap.json', 'data/place-aliases.json',
];
const FORBIDDEN = /google|goo\.gl|gstatic|maps\.app/i;

test('в рантайме и данных нет ссылок на Google-карты (гайд выпилен осознанно)', () => {
  const hits = [];
  for (const rel of RUNTIME) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue; // xlsx-импорт может собрать без части данных
    const src = fs.readFileSync(p, 'utf8');
    const m = src.match(FORBIDDEN);
    if (m) hits.push(`${rel}: «…${src.slice(Math.max(0, m.index - 20), m.index + 30)}…»`);
  }
  assert.deepEqual(hits, [], 'найдены Google-ссылки:\n' + hits.join('\n'));
});
