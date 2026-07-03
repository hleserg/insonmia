'use strict';
/* Общее окружение e2e: работает и локально (npm i -D playwright),
   и в облачной песочнице (глобальный Playwright + системный Chromium).
   Скрипты самодостаточны: каждый поднимает свой http-сервер из корня репо. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch { /* локально не установлен как зависимость */ }
  try { return require('/opt/node22/lib/node_modules/playwright/index.js'); } catch { /* не песочница */ }
  throw new Error('Playwright не найден. Локально: npm i -D playwright && npx playwright install chromium');
}

const chromiumPath = [process.env.PW_CHROMIUM, '/opt/pw-browsers/chromium']
  .filter(Boolean).find(p => { try { return fs.existsSync(p); } catch { return false; } });

module.exports = {
  chromium: loadPlaywright().chromium,
  // локально executablePath не нужен — Playwright возьмёт свой chromium
  launchOpts: chromiumPath ? { executablePath: chromiumPath } : {},
  REPO: path.resolve(__dirname, '..', '..'),
  tmpProfile: (name) => path.join(os.tmpdir(), 'insomnia-e2e-' + name),
  serve(port) {
    const srv = spawn('python3', ['-m', 'http.server', String(port)],
      { cwd: path.resolve(__dirname, '..', '..'), stdio: 'ignore' });
    return { proc: srv, ready: new Promise(r => setTimeout(r, 800)) };
  },
};
