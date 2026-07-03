'use strict';
/* Аудит подпути /insonmia/ (GitHub Pages project site): сервируем РОДИТЕЛЬСКИЙ
   каталог — приложение живёт под /insonmia/, как на Pages. Проверяем: ни одного
   запроса мимо подпути, ни одного 404, SW scope, офлайн-навигацию, #pin= поверх
   подпути (онлайн и офлайн), share-ссылки с полным origin+подпутём, /insonmia
   без слэша. */
const { chromium, launchOpts, REPO, tmpProfile } = require('./_env');
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = 8095;
const PARENT = path.dirname(REPO);                 // родитель репо
const SUB = '/' + path.basename(REPO) + '/';       // "/insonmia/"
const BASE = `http://127.0.0.1:${PORT}${SUB}`;
let server = null;
const serverOn = () => { server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: PARENT, stdio: 'ignore' }); return new Promise(r => setTimeout(r, 800)); };
const serverOff = () => { if (server) { server.kill('SIGKILL'); server = null; } return new Promise(r => setTimeout(r, 300)); };

(async () => {
  await serverOn();
  const PROFILE = tmpProfile('subpath');
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ...launchOpts,
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC',
    permissions: ['clipboard-read', 'clipboard-write'],
    serviceWorkers: 'allow',
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // сеть: всё же-ориджин строго под подпутём и без 404
  const badPath = [], notFound = [];
  page.on('request', req => {
    const u = new URL(req.url());
    if (u.origin === `http://127.0.0.1:${PORT}` && !u.pathname.startsWith(SUB) && u.pathname !== SUB.slice(0, -1)) {
      badPath.push(u.pathname);
    }
  });
  page.on('response', res => { if (res.status() === 404) notFound.push(new URL(res.url()).pathname); });

  // 1. чистый профиль: загрузка из подпути, SW со scope подпути, прекэш полон
  await page.goto(BASE, { waitUntil: 'load' });
  let sw = null;
  for (let i = 0; i < 40; i++) {
    sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || !reg.active) return null;
      const keys = await caches.keys();
      const name = keys.find(k => k.includes('insomnia'));
      if (!name) return null;
      const cached = await (await caches.open(name)).keys();
      return { scope: reg.scope, cached: cached.length };
    });
    if (sw) break;
    await page.waitForTimeout(500);
  }
  assert.ok(sw, 'SW не установился');
  assert.ok(sw.scope.endsWith(SUB), 'scope SW не подпуть: ' + sw.scope);
  assert.ok(sw.cached >= 16, 'прекэш неполон: ' + sw.cached);
  const manifest = await page.evaluate(async () => (await (await fetch('manifest.webmanifest')).json()));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.id, './');
  console.log(`1. подпуть онлайн: OK — scope ${sw.scope}, прекэш ${sw.cached}, манифест относительный`);

  // 2. /insonmia без слэша -> приложение открывается (редирект сервера)
  await page.goto(`http://127.0.0.1:${PORT}${SUB.slice(0, -1)}`, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  const tabs = await page.locator('.tab').count();
  assert.ok(tabs >= 5, 'без слэша приложение не открылось');
  console.log('2. /insonmia без слэша: OK');

  // 3. #pin= поверх подпути онлайн: шит виден, replaceState не съедает подпуть
  await page.goto(BASE + '#pin=54.6812,35.0911,' + encodeURIComponent('Тест подпути') + ',⛺', { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  const inTxt = await page.evaluate(() => document.querySelector('#pinIncomingBody').innerText);
  assert.ok(/Тест подпути/.test(inTxt), 'входящая метка не показана под подпутём');
  const pathNow = await page.evaluate(() => location.pathname + location.hash);
  assert.equal(pathNow, SUB, 'replaceState испортил путь: ' + pathNow);
  // добавим метку и проверим share-ссылку: полный origin + подпуть
  await page.click('#pinIncomingAdd');
  await page.waitForTimeout(900);
  await page.click('.tab[data-view="nearby"]').catch(() => {});
  await page.waitForTimeout(400);
  const shared = await page.evaluate(() => {
    const p = (JSON.parse(localStorage.getItem('insomnia.pins')) || [])[0];
    return location.origin + location.pathname + window.InsomniaCore.pinToHash(p);
  });
  assert.ok(shared.startsWith(BASE + '#pin='), 'share-ссылка не от полного подпути: ' + shared);
  console.log('3. #pin= онлайн: OK — шит, путь цел, share-ссылка ' + shared.slice(0, 52) + '…');

  // 4. офлайн: сервер убит — навигация на подпуть, mesh.html и #pin= живут
  await serverOff();
  await page.goto(BASE, { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(800);
  const offTabs = await page.locator('.tab').count();
  assert.ok(offTabs >= 5, 'офлайн-навигация на подпуть не отдала шелл');
  await page.goto(BASE + 'mesh.html', { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(500);
  const meshTxt = await page.evaluate(() => document.body.innerText);
  assert.ok(meshTxt.includes('Bitchat'), 'mesh.html офлайн не открылся под подпутём');
  await page.goto(BASE + '#pin=54.6820,35.0790,' + encodeURIComponent('Офлайн метка') + ',🔥', { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(1100);
  const offPin = await page.evaluate(() => document.querySelector('#pinIncomingBody').innerText);
  assert.ok(/Офлайн метка/.test(offPin), '#pin= офлайн не сработал');
  console.log('4. офлайн: OK — шелл, mesh.html и #pin= живут под подпутём без сети');

  // 5. итог по сети: ни одного запроса мимо подпути, ни одного 404
  assert.deepEqual([...new Set(badPath)], [], 'запросы мимо подпути: ' + badPath.join(', '));
  assert.deepEqual([...new Set(notFound)], [], '404: ' + notFound.join(', '));
  const real = errors.filter(e => !/favicon|icon from the Manifest|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_FAILED/i.test(e));
  assert.equal(real.length, 0, 'ошибки консоли: ' + real.join(' | '));
  console.log('5. сеть: OK — 0 запросов мимо /insonmia/, 0 × 404, консоль чистая');

  console.log('\nПОДПУТЬ: ВСЁ ЗЕЛЁНОЕ');
  await ctx.close();
  await serverOff();
  process.exit(0);
})().catch(async e => { console.error('FAIL:', e.message); await serverOff(); process.exit(1); });
