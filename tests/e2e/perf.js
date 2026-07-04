'use strict';
/* Ф5: первая отрисовка на 4x CPU throttle + утечки при навигации ×20 */
const { chromium, launchOpts, REPO, tmpProfile } = require('./_env');
const PORT = 8096;
(async () => {
  const { spawn } = require('child_process');
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });
  const b = await chromium.launch(launchOpts);
  const ctx = await b.newContext({ viewport: { width: 360, height: 740 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.clock.install({ time: Date.UTC(2026, 6, 10, 18, 0) });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'commit' });
  await page.waitForSelector('.event, .empty', { timeout: 15000 });
  const firstEvent = Date.now() - t0;
  const paintMetrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { fcp: fcp ? Math.round(fcp.startTime) : null,
             domInteractive: nav.domInteractive ? Math.round(nav.domInteractive) : null,
             loadEnd: nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null };
  });
  console.log('4x CPU: карточки событий через', firstEvent, 'мс; FCP', paintMetrics.fcp, 'мс; domInteractive', paintMetrics.domInteractive, 'мс');

  // утечки: навигация по вкладкам ×20, замер heap и активных watch/interval
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.send('Performance.enable');
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = metrics.find(x => x.name === 'JSHeapUsedSize');
    return Math.round((m ? m.value : 0) / 1024 / 1024 * 10) / 10;
  };
  // счётчики поверх геолокации: сколько watch живо
  await page.evaluate(() => {
    window.__watches = 0;
    const w = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    const c = navigator.geolocation.clearWatch.bind(navigator.geolocation);
    navigator.geolocation.watchPosition = (...a) => { window.__watches++; return w(...a); };
    navigator.geolocation.clearWatch = (id) => { window.__watches--; return c(id); };
  });
  const before = await heap();
  for (let i = 0; i < 20; i++) {
    for (const v of ['map', 'nearby', 'schedule', 'now', 'favorites']) {
      await page.click(`.tab[data-view="${v}"]`);
      await page.waitForTimeout(60);
    }
  }
  await page.waitForTimeout(500);
  const after = await heap();
  const watches = await page.evaluate(() => window.__watches);
  console.log(`heap: ${before} МБ -> ${after} МБ после 100 переключений вкладок; активных geo-watch: ${watches}`);
  if (after - before > 8) { console.log('FAIL: heap растёт'); process.exit(1); }
  if (watches > 0) { console.log('FAIL: geo-watch утёк (вкладка не «рядом»)'); process.exit(1); }
  console.log('Ф5 perf: OK');
  await b.close();
  try { srv.kill('SIGKILL'); } catch { /* уже мёртв */ }
  process.exit(0); // иначе живой http-server держит event loop и тест «висит»
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
