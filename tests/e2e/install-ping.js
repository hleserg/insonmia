'use strict';
/* Пинг «установили» в телеграм при appinstalled: шлётся один раз через мусорный
   бот из window.APP_CONFIG (в проде подставляет CI из секретов), дедуп по
   localStorage, при ошибке сети флаг НЕ ставится, без APP_CONFIG — молча выключен. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8167;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'TESTBOTTOKEN', CHAT = '12345';

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });

  const browser = await chromium.launch(launchOpts);
  const flag = () => 'localStorage.getItem("insomnia.install_pinged")';

  // --- A. с APP_CONFIG: appinstalled → ровно один пинг, дедуп на повторе
  {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript(({ t, c }) => { window.APP_CONFIG = { tg: { token: t, chat: c } }; }, { t: TOKEN, c: CHAT });
    const page = await ctx.newPage();
    const reqs = [];
    await page.route('https://api.telegram.org/**', route => {
      reqs.push({ url: route.request().url(), body: route.request().postData() });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(900);
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await page.waitForTimeout(500);
    assert.equal(reqs.length, 1, 'ровно один запрос к telegram: ' + reqs.length);
    assert.ok(reqs[0].url.includes(`/bot${TOKEN}/sendMessage`), 'верный бот+метод: ' + reqs[0].url);
    assert.ok(reqs[0].body.includes(`"chat_id":"${CHAT}"`), 'chat_id в теле: ' + reqs[0].body);
    assert.ok(/установлена/.test(reqs[0].body), 'текст «установлена» в теле: ' + reqs[0].body);
    assert.equal(await page.evaluate(flag()), '1', 'флаг дедупа поставлен');
    // повторный appinstalled — второго пинга нет
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await page.waitForTimeout(400);
    assert.equal(reqs.length, 1, 'повторный appinstalled не шлёт второй пинг (дедуп): ' + reqs.length);
    console.log('✓ A. с конфигом: один пинг + дедуп на повторе');
    await ctx.close();
  }

  // --- B. без APP_CONFIG: пинг молча выключен (0 запросов)
  {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    let count = 0;
    await page.route('https://api.telegram.org/**', route => { count++; return route.fulfill({ status: 200, body: '{"ok":true}' }); });
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(900);
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await page.waitForTimeout(400);
    assert.equal(count, 0, 'без APP_CONFIG запросов нет: ' + count);
    assert.equal(await page.evaluate(flag()), null, 'флаг не ставится без конфига');
    console.log('✓ B. без конфига: пинг молча выключен, 0 запросов');
    await ctx.close();
  }

  // --- C. ошибка сети (офлайн): флаг НЕ ставим, чтобы не потерять пинг
  {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript(({ t, c }) => { window.APP_CONFIG = { tg: { token: t, chat: c } }; }, { t: TOKEN, c: CHAT });
    const page = await ctx.newPage();
    let attempts = 0;
    await page.route('https://api.telegram.org/**', route => { attempts++; return route.abort(); });
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(900);
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await page.waitForTimeout(500);
    assert.ok(attempts >= 1, 'попытка отправки была: ' + attempts);
    assert.equal(await page.evaluate(flag()), null, 'при ошибке сети флаг НЕ ставим (пинг не потерян)');
    console.log('✓ C. ошибка сети: пинг не отмечен доставленным (флаг пуст)');
    await ctx.close();
  }

  await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  console.log('\n=== ПИНГ УСТАНОВКИ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
