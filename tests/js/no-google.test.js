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
// vendor/ не сканируем: внутренности чужих библиотек — не пользовательские ссылки.
// Для КОДА запрещено любое упоминание; для автообновляемых ДАННЫХ с сайта —
// только ссылочные паттерны: слово «Google» в описании события — не наша
// ссылка и не должно ронять CI после очередного cron-обновления program.json.
const CODE = [
  'index.html', 'mesh.html', 'app.js', 'map.js', 'core.js', 'sw.js',
  'styles.css', 'manifest.webmanifest',
];
const DATA = ['data/program.json', 'data/geo.json', 'data/basemap.json', 'data/place-aliases.json'];
const CODE_FORBIDDEN = /google|goo\.gl|gstatic|maps\.app/i;
const LINK_FORBIDDEN = /google\.[a-z.]+\/(maps|mymaps)|maps\.google|goo\.gl|maps\.app\.goo/i;

test('в рантайме и данных нет ссылок на Google-карты (гайд выпилен осознанно)', () => {
  const hits = [];
  const scan = (files, re) => {
    for (const rel of files) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) continue; // xlsx-импорт может собрать без части данных
      const src = fs.readFileSync(p, 'utf8');
      const m = src.match(re);
      if (m) hits.push(`${rel}: «…${src.slice(Math.max(0, m.index - 20), m.index + 30)}…»`);
    }
  };
  scan(CODE, CODE_FORBIDDEN);
  scan(DATA, LINK_FORBIDDEN);
  assert.deepEqual(hits, [], 'найдены Google-ссылки:\n' + hits.join('\n'));
});
