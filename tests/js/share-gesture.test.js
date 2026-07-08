'use strict';
/* Регресс-гард (в CI, npm test): navigator.share ДОЛЖЕН вызываться синхронно из
   обработчика клика — иначе теряется user-gesture (transient activation) и iOS/
   Android бросают NotAllowedError. Гарантируем на уровне ИСХОДНИКА map.js:
   - в shareLink первый await — ровно на navigator.share (никакого await раньше);
   - sharePin и shareMyCoord НЕ async и без await (зовут shareLink синхронно).
   Рантайм-поведение (жест, фолбэки) проверяет tests/e2e/share-gesture.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'map.js'), 'utf8');

// тело top-level функции: от заголовка до строки, начинающейся с «}» (закрытие).
// Комментарии вырезаем — иначе слово «await» в пояснении даёт ложное срабатывание.
function fnBody(header) {
  const i = SRC.indexOf(header);
  assert.ok(i !== -1, 'не найдена функция: ' + header);
  const end = SRC.indexOf('\n}', i);
  assert.ok(end !== -1, 'не найдено закрытие функции: ' + header);
  return SRC.slice(i, end)
    .replace(/\/\*[\s\S]*?\*\//g, '') // блочные комментарии
    .replace(/\/\/.*$/gm, '');        // строчные комментарии
}

test('shareLink: первый await — ровно на navigator.share (нет await раньше)', () => {
  const body = fnBody('async function shareLink(');
  assert.ok(/navigator\.share\(/.test(body), 'shareLink должна звать navigator.share');
  const firstAwait = body.indexOf('await ');
  assert.ok(firstAwait !== -1, 'в shareLink должен быть await (на share)');
  assert.ok(body.slice(firstAwait).startsWith('await navigator.share'),
    'ПЕРВЫЙ await в shareLink не на navigator.share — жест будет потерян: '
    + body.slice(firstAwait, firstAwait + 40));
});

test('sharePin: синхронный билдер (не async, без await) → зовёт shareLink', () => {
  assert.ok(!/async function sharePin\b/.test(SRC), 'sharePin не должна быть async');
  const body = fnBody('function sharePin(');
  assert.ok(!/\bawait\b/.test(body), 'в sharePin не должно быть await до shareLink');
  assert.ok(/shareLink\(/.test(body), 'sharePin должна звать общую shareLink');
});

test('shareMyCoord: синхронный билдер (не async, без await) → зовёт shareLink', () => {
  assert.ok(!/async function shareMyCoord\b/.test(SRC), 'shareMyCoord не должна быть async');
  const body = fnBody('function shareMyCoord(');
  assert.ok(!/\bawait\b/.test(body), 'в shareMyCoord не должно быть await (ждать GPS и т.п.) до share');
  assert.ok(/shareLink\(/.test(body), 'shareMyCoord должна звать общую shareLink');
});
