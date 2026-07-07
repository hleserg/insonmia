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
  const freshControlled = async ({ denied = false, clock = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: 'UTC', serviceWorkers: 'block' });
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    await ctx.addInitScript((denied) => {
      window.__geoCbs = []; window.__geoErrs = []; window.__lastGeo = null; window.__watchOpts = null;
      window.__fireGeo = (lat, lng) => { window.__lastGeo = { lat, lng }; window.__geoCbs.forEach(cb => cb({ coords: { latitude: lat, longitude: lng, accuracy: 5 } })); };
      window.__fireGeoAcc = (lat, lng, acc) => { window.__geoCbs.forEach(cb => cb({ coords: { latitude: lat, longitude: lng, accuracy: acc } })); }; // фикс с заданной точностью
      window.__fireGeoErr = (code) => { window.__geoErrs.forEach(cb => cb({ code })); }; // код 1/2/3 руками
      navigator.geolocation.watchPosition = (ok, err, opts) => { window.__geoCbs.push(ok); if (err) window.__geoErrs.push(err); window.__watchOpts = opts || null; if (denied) setTimeout(() => err && err({ code: 1 }), 30); return window.__geoCbs.length; };
      navigator.geolocation.getCurrentPosition = (ok, err) => { if (denied) return err && err({ code: 1 }); if (window.__lastGeo) ok({ coords: { latitude: window.__lastGeo.lat, longitude: window.__lastGeo.lng, accuracy: 5 } }); else err && err({ code: 3 }); };
      navigator.geolocation.clearWatch = () => {};
      if (navigator.permissions && navigator.permissions.query) navigator.permissions.query = d => d && d.name === 'geolocation' ? Promise.resolve({ state: denied ? 'denied' : 'granted' }) : Promise.resolve({ state: 'prompt' });
    }, denied);
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.error('pageerror:', e.message); process.exitCode = 1; });
    if (clock) await page.clock.install({ time: new Date('2026-07-10T14:00:00Z') }); // мокаем таймеры для теста «протух через минуту»
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

  // --- 4b. РЕГРЕСС verify (раунд 2): отказ → доступ ВЕРНУЛИ, но фикса ещё нет
  //         (потеряшка под крышей). Приходит code 2/3 — экран НЕ должен стать
  //         тупиковым спиннером: дедлайн «долгого поиска» переармируется, через
  //         3 мин снова появляется «повторить» (иначе немой спиннер навсегда).
  {
    const { ctx, page } = await freshControlled({ denied: true, clock: true });
    await page.click('.tab[data-view="nearby"]'); await page.clock.runFor(100); await page.waitForTimeout(400);
    assert.match(await page.evaluate(() => document.querySelector('#content .empty').textContent), /не дал доступ|настройки/i, '4b: сначала отказ доступа');
    // доступ вернули в настройках (permissions → granted), но спутников ещё нет → code 2
    await page.evaluate(() => {
      navigator.permissions.query = d => d && d.name === 'geolocation' ? Promise.resolve({ state: 'granted' }) : Promise.resolve({ state: 'prompt' });
      window.__fireGeoErr(2);
    });
    await page.waitForTimeout(400);
    const emptyTxt = await page.evaluate(() => document.querySelector('#content .empty').textContent);
    assert.ok(/спутник/i.test(emptyTxt) && !/не дал доступ/i.test(emptyTxt), '4b: code 2 после отказа → спиннер «поиск», не отказ: ' + emptyTxt.slice(0, 50));
    assert.ok(!(await page.evaluate(() => [...document.querySelectorAll('.geo-searching .btn')].some(b => /повторить/.test(b.textContent)))), '4b: сразу после code 2 — обычный поиск, без «повторить»');
    await page.clock.runFor(181000); await page.waitForTimeout(400); // >SEARCH_MS без фикса
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.geo-searching .btn')].some(b => /повторить/.test(b.textContent))), '4b: через 3 мин «долгий поиск» + «повторить» (дедлайн переармирован на code1→code2)');
    console.log('✓ 4b. отказ→доступ вернули без фикса: спиннер не тупиковый, эскалация «долгого поиска» наступает');
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

  // --- 9. фикс протухает через минуту → гаснет к «поиск спутников» (строго для
  //        потеряшек: замороженную старую точку не показываем; ловит и «тихую»
  //        потерю сигнала без ошибки). Таймеры мокаем page.clock — не ждём 60с.
  {
    const { ctx, page } = await freshControlled({ clock: true });
    await page.evaluate(() => { window.__alive = 'festa'; });
    await page.click('.tab[data-view="map"]'); await page.clock.runFor(1000); await page.waitForTimeout(200);
    await fire(page, PT[0], PT[1]); await page.waitForTimeout(200);
    assert.match(await rowText(page), /📍\s*54\.680/, '9: фикс показал координаты');
    assert.ok(await hasSelf(page), '9: маркер есть при свежем фиксе');
    await page.clock.runFor(61000); await page.waitForTimeout(200); // >1 мин без нового фикса
    assert.ok(!/📍\s*54\.680/.test(await rowText(page)), '9: через минуту старая точка НЕ показывается');
    assert.match(await rowText(page), /поиск спутников/, '9: протухший фикс → снова «поиск спутников»');
    assert.ok(!(await hasSelf(page)), '9: маркер снят у протухшего фикса');
    console.log('✓ 9. фикс протухает через минуту → гаснет к «поиск спутников» (не замороженная точка)');
    await ctx.close();
  }

  // --- 10. КОРЕНЬ БАГА #69: код 2/3 (POSITION_UNAVAILABLE/TIMEOUT) — доступ ЕСТЬ,
  //         спутников пока нет → НЕ «включить геолокацию», продолжаем крутить спиннер.
  {
    const { ctx, page } = await freshControlled();
    await page.click('.tab[data-view="map"]'); await page.waitForTimeout(700);
    await page.evaluate(() => window.__fireGeoErr(2)); await page.waitForTimeout(200);
    assert.ok(!/включить геолокацию/.test(await rowText(page)), '10: код 2 НЕ показывает «включить геолокацию» (доступ есть)');
    assert.match(await rowText(page), /поиск спутников/, '10: код 2 → остаёмся в «поиск спутников»');
    assert.ok(await page.evaluate(() => !!document.querySelector('#myCoordText .gps-spinner')), '10: спиннер крутится при коде 2');
    await page.evaluate(() => window.__fireGeoErr(3)); await page.waitForTimeout(200); // таймаут — так же
    assert.match(await rowText(page), /поиск спутников/, '10: код 3 (таймаут) → тоже «поиск спутников», не «включите»');
    await fire(page, PT[0], PT[1]); await page.waitForTimeout(300); // фикс после ошибок всё равно ловится
    assert.match(await rowText(page), /📍\s*54\.680/, '10: фикс после ошибок 2/3 показывает координаты');
    console.log('✓ 10. код 2/3 (нет спутников/таймаут) → «поиск спутников», НЕ «включить геолокацию»; фикс потом ловится');
    await ctx.close();
  }

  // --- 11. Долгий поиск: прошло SEARCH_MS (3 мин) без фикса → это НЕ провал —
  //         спиннер продолжает крутиться, но текст «долго ищем» + кнопка «повторить».
  {
    const { ctx, page } = await freshControlled({ clock: true });
    await page.click('.tab[data-view="nearby"]'); await page.clock.runFor(1000); await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => !!document.querySelector('.geo-searching .gps-spinner')), '11: сначала обычный «поиск спутников»');
    await page.clock.runFor(181000); await page.waitForTimeout(300); // > SEARCH_MS (180000)
    assert.ok(await page.evaluate(() => !!document.querySelector('.geo-searching .gps-spinner')), '11: спиннер ВСЁ ЕЩЁ крутится (поиск не сдался)');
    const slow = await page.evaluate(() => document.querySelector('.geo-searching').textContent);
    assert.match(slow, /всё ещё не поймались|открытое место|попробуй заново/i, '11: текст сменился на «долгий поиск»: ' + slow.slice(0, 60));
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.geo-searching .btn')].some(b => /повторить/.test(b.textContent))), '11: кнопка «повторить» появилась при долгом поиске');
    await fire(page, PT[0], PT[1]); await page.waitForTimeout(300); // фикс всё равно ловится
    assert.ok(await page.evaluate(() => document.querySelectorAll('.map-point').length) > 0, '11: фикс после долгого поиска → события появились');
    console.log('✓ 11. долгий поиск (>3 мин): спиннер крутится, текст «долго» + «повторить»; фикс всё равно ловится');
    await ctx.close();
  }

  // --- 11b. РЕГРЕСС verify: фикс был → сигнал пропал под крышей (armGeoStale гасит
  //          точку) → «долгий поиск» должен наступить СНОВА (дедлайн переармирован),
  //          иначе спиннер крутится вечно без «повторить». Bug 1 из adversarial-verify.
  {
    const { ctx, page } = await freshControlled({ clock: true });
    await page.click('.tab[data-view="nearby"]'); await page.clock.runFor(1000); await page.waitForTimeout(200);
    await fire(page, PT[0], PT[1]); await page.waitForTimeout(300); // первый фикс поймали
    assert.ok(await page.evaluate(() => document.querySelectorAll('.map-point').length) > 0, '11b: первый фикс → события есть');
    await page.clock.runFor(61000); await page.waitForTimeout(300); // сигнал пропал → фикс протух (>60с)
    assert.ok(await page.evaluate(() => !!document.querySelector('.geo-searching .gps-spinner')), '11b: после потери фикса снова «поиск спутников»');
    assert.ok(!(await page.evaluate(() => [...document.querySelectorAll('.geo-searching .btn')].some(b => /повторить/.test(b.textContent)))), '11b: сразу после потери — ещё обычный поиск, без «повторить»');
    await page.clock.runFor(181000); await page.waitForTimeout(300); // ещё >3 мин без фикса
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.geo-searching .btn')].some(b => /повторить/.test(b.textContent))), '11b: «долгий поиск» наступил СНОВА после потери фикса (дедлайн переармирован)');
    console.log('✓ 11b. фикс→потеря сигнала под крышей→эскалация «долгого поиска» наступает снова (не вечный немой спиннер)');
    await ctx.close();
  }

  // --- 12. Опции watchPosition: длинный таймаут (≥3 мин, не 15с), maximumAge:0
  //         (никогда старый/кэшированный фикс), enableHighAccuracy (именно GPS).
  {
    const { ctx, page } = await freshControlled();
    await page.click('.tab[data-view="map"]'); await page.waitForTimeout(500);
    const opts = await page.evaluate(() => window.__watchOpts || {});
    assert.ok(opts.timeout >= 180000, '12: timeout watchPosition ≥180000 (не 15с): ' + opts.timeout);
    assert.equal(opts.maximumAge, 0, '12: maximumAge=0 (никогда старый/кэшированный фикс)');
    assert.equal(opts.enableHighAccuracy, true, '12: enableHighAccuracy=true (GPS, не сеть)');
    console.log('✓ 12. watchPosition: timeout ≥3 мин, maximumAge=0, enableHighAccuracy=true');
    await ctx.close();
  }

  // --- 13. КАРТА: круг точности = accuracy (L.circle radius в метрах). Фиксы
  //         принимаем любой точности (гейт снят) — честность в КРУГЕ погрешности,
  //         а не в сокрытии. Грубый фикс → большой круг, точный → маленький.
  {
    const { ctx, page } = await freshControlled({ clock: true });
    await page.click('.tab[data-view="map"]'); await page.waitForTimeout(600);
    const fireAcc = (la, ln, acc) => page.evaluate(([a, b, c]) => window.__fireGeoAcc(a, b, c), [la, ln, acc]);
    const accRadius = () => page.evaluate(() =>
      (typeof GEO !== 'undefined' && GEO.accCircle) ? Math.round(GEO.accCircle.getRadius()) : null);
    await fireAcc(PT[0], PT[1], 800); await page.waitForTimeout(300); // грубоватый фикс — принят
    assert.match(await rowText(page), /📍\s*54\.680/, '13: фикс показан (гейт снят, принимаем любой)');
    assert.ok(await hasSelf(page), '13: маркер «я тут» есть');
    assert.equal(await accRadius(), 800, '13: круг точности = accuracy 800 м');
    // ЧЕСТНОСТЬ: грубый фикс в строке помечен ±N (не выдаётся за точные координаты)
    assert.match(await rowText(page), /±800 м/, '13: строка карты помечает погрешность ±800 м');
    // и текст шаринга «я здесь» тоже честный (получатель не примет за точную точку)
    const shareText = await page.evaluate(async () => {
      let captured = null;
      navigator.share = (o) => { captured = o.text; return Promise.resolve(); };
      document.querySelector('#myCoordShare').click();
      await new Promise(r => setTimeout(r, 50));
      return captured;
    });
    assert.ok(shareText && /±800 м/.test(shareText) && /примерно/i.test(shareText), '13: шаринг помечает погрешность: ' + shareText);
    // точный фикс после троттла (10с) — круг сжался, ±N в строке НЕ пишем
    await page.clock.runFor(11000);
    await fireAcc(PT[0], PT[1], 15); await page.waitForTimeout(300);
    assert.equal(await accRadius(), 15, '13: круг точности сжался до accuracy 15 м');
    assert.ok(!/±\d/.test(await rowText(page)), '13: точный фикс (15 м) — голые координаты, без ±N');
    console.log('✓ 13. карта: круг точности + честная пометка ±N на грубом фиксе (800 м → 15 м)');
    await ctx.close();
  }

  // --- 8. офлайн: статус и фикс работают без сети (GPS без интернета). ПОСЛЕДНИМ —
  //        убивает http-сервер, дальше сетевые сценарии уже не поднять.
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
