'use strict';
/* FAQ в настройках: свёрнут по умолчанию, раскрывается, 7 вопросов-ответов
   аккордеоном, ссылка на bitchat-гайд, контраст текста читаем, офлайн. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8163;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const external = [];
  page.on('request', r => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname)) external.push(r.url()); });
  page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(600);

  await page.click('#btnSettings');
  await page.waitForTimeout(200);

  // 1. свёрнут по умолчанию (details без open) — контент нативно скрыт
  const openAtStart = await page.$eval('.faq', el => el.open);
  assert.equal(openAtStart, false, 'FAQ свёрнут по умолчанию (details не open)');
  console.log('✓ FAQ свёрнут по умолчанию');

  // 2. раскрывается, 7 вопросов
  await page.click('.faq > summary');
  await page.waitForTimeout(150);
  const nQ = await page.$$eval('.faq-list > details', els => els.length);
  assert.equal(nQ, 7, `в FAQ 7 вопросов, а не ${nQ}`);
  const qVisible = await page.$eval('.faq-list summary', el => el.offsetParent !== null);
  assert.ok(qVisible, 'после раскрытия вопросы видны');
  console.log(`✓ раскрывается, ${nQ} вопросов`);

  // 3. вопрос раскрывает ответ; ссылка на bitchat-гайд есть
  await page.click('.faq-list details:nth-of-type(6) > summary'); // «поделиться местом лагеря»
  await page.waitForTimeout(120);
  const ansTxt = await page.$eval('.faq-list details:nth-of-type(6) p', el => el.innerText);
  assert.ok(ansTxt.length > 10, 'ответ раскрылся');
  const meshLink = await page.$('.faq-list a[href="mesh.html"]');
  assert.ok(meshLink, 'в FAQ есть ссылка на bitchat-гайд (mesh.html)');
  console.log('✓ вопрос раскрывает ответ, ссылка на гайд bitchat есть');

  // 4. контраст текста ответа и заголовков ≥4.5:1 (не серый нечитаемый)
  const contrast = await page.evaluate(() => {
    const lum = (r, g, b) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const parse = s => s.match(/\d+(\.\d+)?/g).map(Number);
    const contr = el => {
      let bg = parse(getComputedStyle(el).backgroundColor), node = el;
      while ((bg.length === 4 && bg[3] === 0) && node.parentElement) { node = node.parentElement; bg = parse(getComputedStyle(node).backgroundColor); }
      const fg = parse(getComputedStyle(el).color).slice(0, 3);
      const a = lum(...fg) + 0.05, b = lum(...bg.slice(0, 3)) + 0.05;
      return +(Math.max(a, b) / Math.min(a, b)).toFixed(2);
    };
    return {
      head: contr(document.querySelector('.faq > summary')),
      q: contr(document.querySelector('.faq-list summary')),
      a: contr(document.querySelector('.faq-list details:nth-of-type(6) p')),
    };
  });
  assert.ok(contrast.head >= 4.5, `контраст заголовка FAQ ${contrast.head} < 4.5`);
  assert.ok(contrast.q >= 4.5, `контраст вопроса ${contrast.q} < 4.5`);
  assert.ok(contrast.a >= 4.5, `контраст ответа ${contrast.a} < 4.5`);
  console.log(`✓ контраст: заголовок ${contrast.head}, вопрос ${contrast.q}, ответ ${contrast.a} (≥4.5)`);

  // 5. офлайн — ноль внешних запросов
  assert.equal(external.length, 0, 'внешних запросов не было: ' + JSON.stringify(external.slice(0, 3)));
  console.log('✓ офлайн — ноль внешних запросов');

  await ctx.close(); await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  console.log('\n=== FAQ В НАСТРОЙКАХ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
