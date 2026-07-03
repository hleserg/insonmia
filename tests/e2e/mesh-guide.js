'use strict';
/* Гайд «Связь на поляне»: precache офлайн, APK-ссылка, переход к импорту меток, 360px. */
const { chromium, launchOpts, REPO, tmpProfile } = require('./_env');
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');

const PORT = 8100, BASE = `http://127.0.0.1:${PORT}`;
const APK = 'https://github.com/permissionlesstech/bitchat-android/releases/download/1.7.4/app-arm64-v8a-release.apk';
let server = null;
const serverOn = () => { server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' }); return new Promise(r => setTimeout(r, 800)); };
const serverOff = () => { if (server) { server.kill('SIGKILL'); server = null; } return new Promise(r => setTimeout(r, 300)); };

(async () => {
  await serverOn();
  const PROFILE = tmpProfile('mesh');
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ...launchOpts,
    viewport: { width: 360, height: 740 }, timezoneId: 'UTC',
    serviceWorkers: 'allow',
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // 1. онлайн: гайд открывается, ссылки точные, 360px без перелива
  await page.goto(BASE + '/mesh.html', { waitUntil: 'load' });
  const apk = await page.locator(`a[href="${APK}"]`).count();
  assert.equal(apk, 1, 'нет точной прямой APK-ссылки');
  const store = await page.evaluate(() => !!document.querySelector('a[href*="apps.apple.com"]'));
  assert.ok(store, 'нет ссылки на App Store');
  const txt = await page.evaluate(() => document.body.innerText);
  for (const need of ['#mesh', 'run in background', '[ЛО]', 'не к нам']) {
    assert.ok(txt.includes(need), 'в гайде нет: ' + need);
  }
  const over = await page.evaluate(() => document.documentElement.scrollWidth > 362);
  assert.ok(!over, 'горизонтальный перелив 360px');
  console.log('1. гайд онлайн: OK — APK-ссылка, App Store, #mesh/run in background/[ЛО], 360px');

  // 2. «Добавить метку из текста» -> приложение открывает форму с фокусом в поле
  await page.click('a[href="./#import-pins"]');
  await page.waitForTimeout(1200);
  const sheetOpen = await page.evaluate(() => !document.querySelector('#pinImport').classList.contains('hidden'));
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  const hash = await page.evaluate(() => location.hash);
  assert.ok(sheetOpen, 'форма импорта не открылась');
  assert.equal(focused, 'pinImportText', 'фокус не в поле: ' + focused);
  assert.equal(hash, '', 'hash не вычищен: ' + hash);
  console.log('2. переход к импорту: OK — шит открыт, фокус в поле, hash чист');

  // 3. дождаться прекэша SW и уйти в «авиарежим» (сервер убит)
  let cached = false;
  for (let i = 0; i < 40; i++) {
    cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const name = keys.find(k => k.includes('insomnia'));
      if (!name) return false;
      return !!(await (await caches.open(name)).match('mesh.html', { ignoreSearch: true }));
    });
    if (cached) break;
    await page.waitForTimeout(500);
  }
  assert.ok(cached, 'mesh.html не попал в прекэш SW');
  await serverOff();
  await page.goto(BASE + '/mesh.html', { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(600);
  const offTxt = await page.evaluate(() => document.body.innerText).catch(() => '');
  assert.ok(offTxt.includes('Bitchat'), 'гайд не открылся офлайн из прекэша');
  console.log('3. авиарежим: OK — гайд отдан из прекэша');

  const real = errors.filter(e => !/favicon|icon from the Manifest|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_FAILED/i.test(e));
  assert.equal(real.length, 0, 'ошибки консоли: ' + real.join(' | '));
  console.log('\nГАЙД MESH: ВСЁ ЗЕЛЁНОЕ');
  await ctx.close();
  await serverOff();
  process.exit(0);
})().catch(async e => { console.error('FAIL:', e.message); await serverOff(); process.exit(1); });
