'use strict';
/* Матрица геолокации (#29): granted / denied / unavailable / retry / офлайн.
   Denied и unavailable эмулируют поведение Яндекс Браузера (сам ЯБ в песочнице недоступен). */
const { chromium, launchOpts, REPO, tmpProfile } = require('./_env');
const { spawn, execSync } = require('child_process');
const assert = require('assert');

const PORT = 8100;
const BASE = `http://127.0.0.1:${PORT}`;
const GEO = { latitude: 54.681149, longitude: 35.091007 }; // Экран полевой
const T = Date.UTC(2026, 6, 9, 15, 0); // 18:00 МСК 9 июля

let server = null;
const serverOn = () => { if (!server) { server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' }); } return new Promise(r => setTimeout(r, 800)); };
const serverOff = () => { if (server) { server.kill('SIGKILL'); server = null; } return new Promise(r => setTimeout(r, 300)); };

async function launch(opts = {}, init = null, { deny = false } = {}) {
  const ctx = await chromium.launch(launchOpts)
    .then(b => b.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', ...opts }));
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  // геосьют НЕ блокирует SW (секция 5 проверяет реальный офлайн), поэтому
  // одноразовый тост «✓ офлайн готов» может прилететь от SW и перебить тост «я
  // где?» в секции 4 (общий #toast, последний побеждает). Он ортогонален гео —
  // глушим его флагом «уже показан», чтобы проверка тоста была детерминированной.
  await ctx.addInitScript(() => { try { localStorage.setItem('insomnia.offlineReadyShown', '1'); } catch {} });
  if (init) await ctx.addInitScript(init);
  if (deny) {
    // отказ на уровне API, который видит приложение — как ЯБ, режущий запрос
    // без диалога: permissions.query -> denied И error-колбэк с кодом 1
    await ctx.addInitScript(() => {
      const q = navigator.permissions && navigator.permissions.query
        ? navigator.permissions.query.bind(navigator.permissions) : null;
      if (q) navigator.permissions.query = d =>
        d && d.name === 'geolocation' ? Promise.resolve({ state: 'denied' }) : q(d);
      navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({ code: 1 }), 40); return 1; };
      navigator.geolocation.getCurrentPosition = (ok, err) => setTimeout(() => err({ code: 1 }), 40);
      navigator.geolocation.clearWatch = () => {};
    });
  }
  const page = await ctx.newPage();
  await page.clock.install({ time: T });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { ctx, page };
}
const tapNearby = async (page) => { await page.click('.tab[data-view="nearby"]'); await page.waitForTimeout(700); };
const results = [];

(async () => {
  try { execSync("pkill -f 'pw-profile' >/dev/null 2>&1 || true"); } catch {}
  await serverOn();

  // 1. granted + позиция -> список точек, подсказка geo-help присутствует
  {
    const { ctx, page } = await launch({ geolocation: GEO, permissions: ['geolocation'] });
    await tapNearby(page);
    const pts = await page.locator('#content .map-point').count();
    const help = await page.locator('#content details.geo-help summary').textContent();
    assert.ok(pts > 0, `granted: точек ${pts}`);
    assert.ok(/Не работает геолокация/.test(help));
    // подсказка раскрывается и упоминает ЯБ и офлайн-GPS
    await page.click('#content details.geo-help summary');
    const body = await page.locator('#content details.geo-help').textContent();
    assert.ok(/Яндекс Браузер/.test(body) && /без интернета/.test(body));
    const over = await page.evaluate(() => document.documentElement.scrollWidth > 362);
    assert.ok(!over, 'горизонтальный перелив на 360px');
    results.push(`1. granted: OK — ${pts} точек, geo-help на месте, 360px без перелива`);
    await ctx.close();
  }

  // 2. permission отклонён без диалога (как ЯБ в PWA)
  {
    const { ctx, page } = await launch({}, null, { deny: true });
    await tapNearby(page);
    await page.waitForTimeout(1500);
    const txt = await page.locator('#content .empty').textContent();
    assert.ok(/не дал доступ|настройки браузера/i.test(txt), 'нет человеческого текста PERMISSION_DENIED: ' + txt.slice(0, 120));
    const retry = await page.locator('#content .empty button:has-text("повторить")').count();
    assert.equal(retry, 1, 'нет кнопки «повторить»');
    results.push('2. denied без диалога: OK — человеческое сообщение + «повторить»');
    await ctx.close();
  }

  // 3. POSITION_UNAVAILABLE/TIMEOUT (код 2/3): доступ ЕСТЬ, спутников пока нет →
  //    НЕ ошибка «включите гео», а спиннер «поиск спутников»; повторные ошибки
  //    НЕ дёргают render (раскрытая подсказка живёт); ТОТ ЖЕ watch ловит фикс.
  {
    const { ctx, page } = await launch({ geolocation: GEO, permissions: ['geolocation'] }, () => {
      let calls = 0;
      window.__watchCalls = () => calls;
      navigator.geolocation.watchPosition = (ok, err) => {
        calls++;
        // одна подписка: сыпет ошибками «нет спутников/таймаут», затем ловит фикс —
        // как реальный watchPosition под крышей, выходящий под открытое небо
        setTimeout(() => err({ code: 2 }), 60);
        setTimeout(() => err({ code: 2 }), 700);  // дубль — не должен дёргать render
        setTimeout(() => err({ code: 3 }), 1400); // таймаут — тоже НЕ «включите гео»
        setTimeout(() => ok({ coords: { latitude: 54.681149, longitude: 35.091007 } }), 2100);
        return calls;
      };
      navigator.geolocation.clearWatch = () => {};
    });
    await tapNearby(page);
    await page.waitForTimeout(400);
    const txt = await page.locator('#content .empty').textContent();
    // код 2/3 → спиннер «поиск спутников» + дисклеймер; НЕ «включить геолокацию»
    assert.ok(/спутник/i.test(txt), 'нет текста про поиск спутников: ' + txt.slice(0, 120));
    assert.ok(!/включ/i.test(txt), 'код 2/3 ошибочно просит «включить геолокацию»: ' + txt.slice(0, 120));
    assert.ok(await page.locator('#content .geo-searching .gps-spinner').count() === 1, 'нет крутилки при коде 2/3');
    await page.click('#content details.geo-help summary'); // раскрыли подсказку
    await page.waitForTimeout(1600); // за это время прилетели err(2)-дубль и err(3)
    const stillOpen = await page.evaluate(() => document.querySelector('#content details.geo-help').open);
    assert.ok(stillOpen, 'раскрытая подсказка схлопнулась при повторных ошибках');
    await page.waitForTimeout(900); // тот же watch ловит фикс (~2100мс)
    const pts = await page.locator('#content .map-point').count();
    const calls = await page.evaluate(() => window.__watchCalls());
    assert.ok(pts > 0, `тот же watch поймал фикс, точек ${pts}`);
    assert.equal(calls, 1, `watch НЕ перезапускался на кодах 2/3 (вызван ${calls} раз)`);
    results.push(`3. код 2/3: OK — спиннер (не «включите гео»), подсказка жива, тот же watch поймал фикс (${pts} точек)`);
    await ctx.close();
  }

  // 4. вкладка «карта»: geo-help под картой; «я где?» при denied — человеческий тост
  {
    const { ctx, page } = await launch({}, null, { deny: true });
    await page.click('.tab[data-view="map"]');
    await page.waitForTimeout(900);
    const help = await page.locator('#mapWrap details.geo-help').count();
    assert.equal(help, 1, 'нет geo-help на карте');
    // кнопка 🎯 не должна лежать поверх подсказки (якорь — .map-stage, не .map-wrap)
    const boxes = await page.evaluate(() => {
      const b = document.querySelector('#btnLocate').getBoundingClientRect();
      const h = document.querySelector('#mapWrap details.geo-help').getBoundingClientRect();
      const m = document.querySelector('#leafletMap').getBoundingClientRect();
      return { b: { t: b.top, bo: b.bottom }, h: { t: h.top }, mapBottom: m.bottom };
    });
    assert.ok(boxes.b.bo <= boxes.h.t + 1, `кнопка 🎯 наезжает на подсказку (btn.bottom=${boxes.b.bo}, help.top=${boxes.h.t})`);
    assert.ok(boxes.b.bo <= boxes.mapBottom + 1, 'кнопка 🎯 уехала ниже карты');
    await page.click('#btnLocate');
    await page.waitForTimeout(1400);
    const toast = await page.evaluate(() => { const t = document.querySelector('#toast'); return t && !t.classList.contains('hidden') ? t.textContent : ''; });
    assert.ok(/не дал доступ|GPS/i.test(toast), 'тост «я где?» не человеческий: ' + toast.slice(0, 120));
    results.push('4. карта: OK — geo-help под картой, «я где?» отвечает человеческим тостом');
    await ctx.close();
  }

  // 5. офлайн (сервер убит, приложение из SW) + granted -> «рядом» живёт
  {
    const { ctx, page } = await launch({ geolocation: GEO, permissions: ['geolocation'] });
    await page.waitForTimeout(2500); // дождаться прекэша SW
    await serverOff();
    await page.reload({ waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(900);
    await tapNearby(page);
    const pts = await page.locator('#content .map-point').count();
    assert.ok(pts > 0, `офлайн: точек ${pts}`);
    results.push(`5. офлайн: OK — «рядом» работает без сети (${pts} точек)`);
    await ctx.close();
  }

  console.log(results.join('\n'));
  console.log('\nГЕО-МАТРИЦА: ВСЁ ЗЕЛЁНОЕ');
  await serverOff();
  process.exit(0);
})().catch(async (e) => { console.error('FAIL:', e.message); await serverOff(); process.exit(1); });
