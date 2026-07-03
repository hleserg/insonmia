# E2E-сьюты (Playwright, без тест-раннера)

Самодостаточные скрипты: каждый сам поднимает `python3 -m http.server` из корня
репо и убивает его в конце. Запуск любого — просто node:

```bash
node tests/e2e/offline.js       # офлайн-паранойя: установка → офлайн навсегда → 4 дня, kill×5, чистый localStorage, битая подложка
node tests/e2e/pins.js          # метки: создание/лонгтап/рядом/шаринг/диплинк/импорт/экспорт (10 сценариев)
node tests/e2e/geo.js           # геолокация: granted / denied без диалога / unavailable→retry / карта / офлайн
node tests/e2e/ux.js            # UX-проход: тап-таргеты, 360px, пустые состояния, контраст
node tests/e2e/perf.js          # первая отрисовка при 4x CPU + утечки при навигации
node tests/e2e/xlsx-offline.js  # ленивый xlsx-вендор грузится офлайн из прекэша
node tests/e2e/mesh-guide.js    # гайд Bitchat: APK-ссылка, переход к импорту меток, авиарежим
node tests/e2e/install-flow.js  # плашка установки, отказ в диалоге не убивает кнопку, appinstalled
node tests/e2e/subpath.js       # подпуть /insonmia/: 0 запросов мимо, 0×404, #pin= офлайн, scope SW
```

Локально нужен Playwright: `npm i -D playwright && npx playwright install chromium`.
В облачной песочнице ничего ставить не надо (`_env.js` найдёт глобальный
Playwright и системный Chromium; свой путь к Chromium можно задать через
`PW_CHROMIUM`).

Почему не `?now=`: прод игнорирует симуляцию — время мокается через
`page.clock.install`. Почему свой kill-сервер, а не `setOffline`: Playwright
не режет fetch'и, инициированные service worker'ом, и офлайн-баги маскируются.
