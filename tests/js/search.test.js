'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeSearch, matchesQuery } = require('../../core.js');

test('normalizeSearch: регистр, ё→е, кавычки, пробелы', () => {
  assert.equal(normalizeSearch('Ёлка'), 'елка');
  assert.equal(normalizeSearch('  МЁД  '), 'мед');
  assert.equal(normalizeSearch('«Кафе "Топь"»'), 'кафе топь');
  assert.equal(normalizeSearch('А  Б\tВ'), 'а б в');
  assert.equal(normalizeSearch(null), '');
  assert.equal(normalizeSearch(undefined), '');
});

test('matchesQuery: подстрока по любому полю, ё/регистронезависимо', () => {
  const q = normalizeSearch('Берёз');                          // подстрока
  assert.ok(matchesQuery(q, ['Роща', 'у берёзы', null]));      // ё в поле → «березы»
  assert.ok(matchesQuery(normalizeSearch('туалет'), ['Туалет №3']));
  assert.ok(!matchesQuery(normalizeSearch('баня'), ['Роща', 'Сцена']));
});

test('matchesQuery: пустой запрос совпадает со всем', () => {
  assert.ok(matchesQuery('', ['что угодно']));
  assert.ok(matchesQuery(normalizeSearch(''), []));
});

test('matchesQuery: кавычки в запросе игнорируются', () => {
  assert.ok(matchesQuery(normalizeSearch('"Детка"'), ['Кафе Глаз да глаз (бывш. Детка)']));
});
