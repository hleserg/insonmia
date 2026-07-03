
const { chromium, launchOpts, REPO, tmpProfile } = require('./_env');
const { spawn } = require('child_process');
const fs = require('fs');
(async () => {
  try { require('child_process').execSync("pkill -f 'pw-prof" + "ile' || true"); } catch {}
  const srv = spawn('python3', ['-m', 'http.server', '8100'], { cwd: REPO, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  const dir = tmpProfile('xlsx');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { ...launchOpts, serviceWorkers: 'allow' });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('http://127.0.0.1:8100/', { waitUntil: 'load' });
  await page.waitForFunction(async () => {
    const keys = await caches.keys();
    if (!keys.includes('insomnia-2026-v11')) return false;
    const c = await caches.open('insomnia-2026-v11');
    return (await c.keys()).length >= 15;
  }, null, { timeout: 20000 });
  console.log('SW v11 установлен, старые кэши:', (await page.evaluate(() => caches.keys())).join(','));
  const onlineXLSX = await page.evaluate(() => typeof window.XLSX);
  console.log('XLSX на старте (ожидаем undefined):', onlineXLSX);
  srv.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 300));
  await page.reload({ waitUntil: 'load' });
  const ok = await page.evaluate(async () => { await ensureXLSX(); return typeof window.XLSX === 'object' && !!XLSX.read; });
  console.log('ленивый XLSX ОФЛАЙН из прекэша:', ok ? 'OK' : 'FAIL');
  await ctx.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
