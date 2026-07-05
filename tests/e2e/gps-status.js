'use strict';
/* Статус связи со спутниками (карта + «рядом»): пока фикса нет — крутилка
   «🛰 поиск спутников…» (видно, что не зависло) + дисклеймер про долгий захват в
   поле; координаты/местоположение и события «рядом» показываем ТОЛЬКО при текущем
   фиксе; «последнее известное» не показываем — уход из гео-раздела чистит фикс,
   при возврате снова «поиск спутников», а не старая точка. Работает офлайн. */
const { chromium, launchOpts, REPO } = require('./_env');
const assert = require('assert');

const PORT = 8183;
const BASE = `http://127.0.0.1:${PORT}`;
const PT = [54.68025, 35.08971];

(async () => {
  const { spawn } = require('child_process');
  let srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const killSrv = () => { try { srv.kill('SIGKILL'); } catch {} };
  process.on('exit', killSrv);

  const browser = await chromium.launch(launchOpts);

  // контекст с УПРАВЛЯЕМОЙ геолокацией: watchPosition копит колбэки, фикс шлём
  // руками через window.__fireGeo(lat,lng) — так детерминированно ловим состояния
  // «поиск» → «есть фикс» и проверяем, что «последнее известное» не всплывает.
  const freshControlled = async ({ denied = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    await ctx.addInitScript((denied) => {
      window.__geoCbs = []; window.__geoErrs = []; window.__lastGeo = null;
      window.__fireGeo = (lat, lng) => { window.__lastGeo = { lat, lng }; window.__geoCbs.forEach(cb => cb({ coords: { latitude: lat, longitude: lng, accuracy: 5 } })); };
      navigator.geolocation.watchPosition = (ok, err) => { window.__geoCbs.push(ok); if (err) window.__geoErrs.push(err); if (denied) setTimeout(() => err && err({ code: 1 }), 30); return window.__geoCbs.length; };
      navigator.geolocation.getCurrentPosition = (ok, err) => { if (denied) return err && err({ code: 1 }); if (window.__lastGeo) ok({ coords: { latitude: window.__lastGeo.lat, longitude: window.__lastGeo.lng, accuracy: 5 } }); else err && err({ code: 3 }); };
      navigator.geolocation.clearWatch = () => {};
      if (navigator.permissions && navigator.permissions.query) navigator.permissions.query = d => d && d.name === 'geolocation' ? Promise.resolve({ state: denied ? 'denied' : 'granted' }) : Promise.resolve({ state: 'prompt' });
    }, denied);
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
    await page.goto(BASE + '/', { waitUntil: 'load' }); await page.waitForTimeout(600);
    return { ctx, page };
  };
  const fire = (page, lat, lng) => page.evaluate(([la, ln]) => window.__fireGeo(la, ln), [lat, lng]);
  const rowHtml = (page) => page.evaluate(() => document.querySelector('#myCoordText').innerHTML);
  const rowText = (page) => page.textContent('#myCoordText');
  const shareDisabled = (page) => page.evaluate(() => document.querySelector('#myCoordShare').disabled);
  const hasSelf = (page) => page.evaluate(() => !!document.querySelector('.geo-self'));

  // --- 1. КАРТА: нет фикса → крутилка «поиск спутников», без координат/маркера, 🔗 неактивна
  {
    const { ctx, page } = await freshControlled();
    await page.click('.tab[data-view="map"]'); await page.waitForTimeout(900);
    const html = await rowHtml(page);
    assert.ok(/gps-spinner/.test(html), '1: в строке есть крутилка (.gps-spinner): ' + html.slice(0, 60));
    assert.match(await rowText(page), /поиск спутников/, '1: текст «поиск спутников…»');
    assert.ok(await shareDisabled(page), '1: 🔗 неактивна без фикса');
    assert.ok(!(await hasSelf(page)), '1: маркер «я тут» НЕ показан без фикса');
    // --- 2. фикс пришёл → координаты + маркер + 🔗 активна
    await fire(page, PT[0], PT[1]); await page.waitForTimeout(300);
    assert.match(await rowText(page), /📍\s*54\.680\d+,\s*35\.089\d+/, '2: фикс → координаты в строке');
    assert.ok(!(await shareDisabled(page)), '2: 🔗 активна при фиксе');
    assert.ok(await hasSelf(page), '2: маркер «я тут» показан при фиксе');
    console.log('✓ 1–2. карта: «поиск спутников» (крутилка, без координат) → фикс → координаты + маркер');

    // --- 3. НЕ показываем «последнее известное»: ушёл с карты → вернулся → снова «поиск»
    await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(300);
    await page.click('.tab[data-view="map"]'); await page.waitForTimeout(200);
    assert.ok(!/📍\s*54\.680/.test(await rowText(page)), '3: при возврате НЕ показываем старую точку');
    assert.match(await rowText(page), /поиск спутников/, '3: при возврате снова «поиск спутников» (только текущее)');
    assert.ok(!(await hasSelf(page)), '3: старый маркер снят при возврате');
    console.log('✓ 3. карта: «последнее известное» не показываем — при возврате снова поиск (не старая точка)');
    await ctx.close();
  }

  // --- 3b. РЕГРЕСС verify: «рядом» (есть фикс) → «Карта» рисует маркер СРАЗУ,
  //         не ждёт следующего (задушенного троттлом) onFix ~10с
  {
    const { ctx, page } = await freshControlled();
    await page.click('.tab[data-view="nearby"]'); await page.waitForTimeout(500);
    await fire(page, PT[0], PT[1]); await page.waitForTimeout(300); // фикс есть (в «рядом»)
    await page.click('.tab[data-view="map"]'); await page.waitForTimeout(600); // переход, watch НЕ гасится
    assert.match(await rowText(page), /📍\s*54\.680/, '3b: на карте сразу координаты (фикс перенесён с «рядом»)');
    assert.ok(await hasSelf(page), '3b: маркер «я тут» нарисован СРАЗУ при заходе на карту (без ожидания onFix)');
    console.log('✓ 3b. «рядом»→«карта»: маркер «я тут» рисуется сразу по существующему фиксу (не ждёт троттл)');
    await ctx.close();
  }

  // --- 4. КАРТА denied → «включить геолокацию», 🔗 неактивна
  {
    const { ctx, page } = await freshControlled({ denied: true });
    await page.click('.tab[data-view="map"]'); await page.waitForTimeout(700);
    assert.match(await rowText(page), /включить геолокацию/, '4: denied → «включить геолокацию»');
    assert.ok(await shareDisabled(page), '4: 🔗 неактивна при denied');
    console.log('✓ 4. карта denied → «включить геолокацию», 🔗 неактивна');
    await ctx.close();
  }

  // --- 5. РЯДОМ: нет фикса → крутилка + «поиск спутников» + дисклеймер, без событий
  {
    const { ctx, page } = await freshControlled();
    await page.click('.tab[data-view="nearby"]'); await page.waitForTimeout(800);
    assert.ok(await page.evaluate(() => !!document.querySelector('.geo-searching .gps-spinner')), '5: крутилка в «рядом»');
    const search = await page.evaluate(() => document.querySelector('.geo-searching').textContent);
    assert.match(search, /поиск спутников/, '5: «поиск спутников…»');
    assert.match(search, /может занять пару минут|не зависла/, '5: дисклеймер про долгий захват в поле');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.map-point').length), 0, '5: событий/точек нет без фикса');
    // --- 6. фикс → события рядом появляются
    await fire(page, PT[0], PT[1]); await page.waitForTimeout(400);
    assert.ok(!(await page.evaluate(() => !!document.querySelector('.geo-searching'))), '6: после фикса «поиск» ушёл');
    assert.ok(await page.evaluate(() => document.querySelectorAll('.map-point').length) > 0, '6: события/точки рядом появились при фиксе');
    console.log('✓ 5–6. рядом: «поиск спутников» (крутилка + дисклеймер, без событий) → фикс → события');

    // --- 7. рядом: возврат не показывает старое — снова «поиск»
    await page.click('.tab[data-view="schedule"]'); await page.waitForTimeout(300);
    await page.click('.tab[data-view="nearby"]'); await page.waitForTimeout(250);
    assert.ok(await page.evaluate(() => !!document.querySelector('.geo-searching')), '7: при возврате в «рядом» снова «поиск спутников» (не старые события)');
    console.log('✓ 7. рядом: при возврате снова «поиск спутников» (только текущее местоположение)');
    await ctx.close();
  }

  // --- 8. офлайн: статус и фикс работают без сети (GPS без интернета)
  {
    const { ctx, page } = await freshControlled();
    await page.click('.tab[data-view="map"]'); await page.waitForTimeout(500);
    killSrv(); await page.waitForTimeout(300); // РЕАЛЬНЫЙ офлайн
    assert.match(await rowText(page), /поиск спутников/, '8: офлайн — «поиск спутников…»');
    await fire(page, PT[0], PT[1]); await page.waitForTimeout(300);
    assert.match(await rowText(page), /📍\s*54\.680/, '8: офлайн — фикс показал координаты (GPS без сети)');
    console.log('✓ 8. офлайн: статус «поиск» и фикс координат работают без сети');
    await ctx.close();
  }

  await browser.close();
  killSrv();
  console.log('\n=== СТАТУС СВЯЗИ СО СПУТНИКАМИ: ВСЁ ОК ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
