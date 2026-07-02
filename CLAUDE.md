# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Офлайн-PWA с программой фестиваля анимации «Бессонница 2026» (9–13 июля, ночные
показы + дневная программа). Пользователь ставит его на телефон, отмечает события
звёздочкой и получает напоминания за N минут до начала. Всё работает без сети.
UI и комментарии — на русском; общение с владельцем репозитория — тоже по-русски.

## Commands

```bash
# Unit tests (node:test, zero deps; CI runs this on every push via tests.yml):
npm test                                  # весь сьют в 4 таймзонах
node --test tests/js/time.test.js         # один файл
node --test --test-name-pattern='границы' tests/js/*.test.js   # один кейс

# Rebuild data/program.json from the site export (what CI does):
python3 scripts/scrape_site.py build
# Offline, from the committed fixture:
python3 scripts/scrape_site.py build --from tests/fixtures/export_program_2026.json
# Map data: KML fixture -> data/geo.json (категории, зоны, мэтчинг площадок):
python3 scripts/build_geo.py
# Fallback: rebuild from the Excel files in source_xlsx/ (needs openpyxl):
pip install -r requirements.txt && python3 scripts/convert_xlsx.py

# Serve the app locally (no build step — plain static files):
python3 -m http.server 8099
```

No bundler/linter. E2E is ad-hoc Playwright driving the served app (in the
cloud sandbox: `require('/opt/node22/lib/node_modules/playwright/index.js')`,
chromium at `/opt/pw-browsers/chromium`). Recipes that matter:
- mock time with `page.clock.install({time: ...})` — NOT `?now=` (prod ignores it);
- favourites need standalone mode: `ctx.addInitScript(() =>
  Object.defineProperty(navigator, 'standalone', {get: () => true}))`;
- prove timezone independence with `timezoneId: 'UTC'` contexts;
- geolocation via `newContext({geolocation, permissions: ['geolocation']})`;
- **real offline = kill the http server**: Playwright's `setOffline` does NOT
  apply to service-worker-initiated fetches and will mask offline bugs.
After regenerating data, sanity-check event count (~705) and id overlap vs the
previous file (favourites are keyed on ids).

## Architecture

Two independent halves share one contract — `data/program.json`:

1. **Data pipeline (Python, runs in GitHub Actions).**
   `scripts/scrape_site.py build` fetches `https://insomniafest.ru/export/program/2026`
   (the site's programme page is a JS shell; this JSON export is what feeds it) and
   normalizes `places[].placeEvents[]` (daytime, → `type: "program"`) and
   `screens[].screenPrograms[]` (night animation, → `type: "animation"`) into a flat
   `events[]` list. `.github/workflows/update-program.yml` runs it every 6 h and
   commits only on change. `scripts/convert_xlsx.py` is the legacy/fallback path from
   the Excel files in `source_xlsx/`. **The local sandbox cannot reach
   insomniafest.ru (egress policy)** — use the fixture, or run the workflow via
   `workflow_dispatch` and read what it commits/logs.

2. **The app (vanilla JS PWA, no build).** Load order: `core.js` (pure logic) →
   `vendor/*` → `map.js` (Leaflet map + «рядом») → `app.js` (five views: Сейчас /
   Программа / Избранное / Карта / Рядом) from the program JSON kept in `localStorage` (imported
   data) or fetched from `data/program.json` (bundled). `sw.js` caches the app shell
   cache-first and `program.json` network-first; bump the `CACHE` version string on
   any asset change or clients keep the stale shell. In-browser Excel import
   (`vendor/xlsx.full.min.js`) mirrors the Python converter's normalization.

### Invariants that must hold across BOTH halves

- **Event ids are FNV-1a 32-bit** over `kind|dateISO|HH:MM|venue|title` (UTF-8).
  The same function exists in `scripts/scrape_site.py`, `scripts/convert_xlsx.py`
  and `app.js` (`fnv1a`). Favourites are keyed on these ids — if you change id
  inputs in one place, change all three, and check the old→new id overlap
  (`≥90%` of ids should survive a data refresh; verify like the comparison in
  the repo history before overwriting `data/program.json`).
- **Festival day:** runs 06:00→05:59 MSK (`DAY_CUTOFF = 6` in app.js,
  `NIGHT_ROLLOVER_HOUR = 6` in both Python converters — keep in sync). The
  stored `date` field is the build-time bucket, but the app recomputes
  `_festDay` from `startISO` at load (`decorateProgram`).
- **Time model (app.js):** ALL comparisons via epoch ms — `e._startMs/_endMs`
  (from naive-MSK `startISO` via `epochFromISO`) vs `getNow()`. Never compare
  local Date objects/strings: device may be in any timezone. `getNow()` also
  serves the `?now=` time simulation — PROD-DISABLED behind `const DEV = false`
  in app.js (flip for debugging; prod silently ignores ?now=/?mockgeo= and
  clears their sessionStorage keys). Pure logic lives in `core.js` (loaded
  first; `window.InsomniaCore` in browser, `require('./core.js')` in tests) —
  change logic THERE, keep app.js wrappers thin. Display times via `mskOf(ms)`.
- **Venue placeholder:** the site names one stage with keyboard-mash text
  (`тстцтсттсцтс`); `normalize_venue` in all three converters maps any all-`тсц`
  string to `Сцена (уточняется)`.
- Text normalization (`clean_text` / `normalizeText`) folds NBSP, U+2028, bare
  `\r`, NEL (U+0085) and strips BOM identically in all three converters — any
  change must land in all of them or ids diverge.
- The app HTML-escapes on render (`escapeHtml`) — don't inject raw strings.
- Favourites are **never auto-pruned** on data refresh: orphaned ids show as a
  banner in «Избранное» with a manual cleanup button.
- SW protocol: `fetch('data/…?fresh=1')` = network-only (honest offline errors
  for the explicit «Обновить» button; Chromium hides `cache:'reload'` from SW).
  Plain data fetches are network-first with ~3.5s timeout, silent cache
  fallback. Bump `CACHE` in sw.js on ANY asset change. New SW versions wait
  for the in-app «обновить» banner (`SKIP_WAITING` message) — no auto-reload.
- `data/program.json` has `meta.version` (export timestamp); the build skips
  rewriting when content (minus meta) is unchanged — no cron commit churn.
  The app shows a quiet «Расписание обновлено» toast when the version changes.

### Notifications & install gate

- Reminder delivery is two-tier: OS-scheduled **Notification Triggers**
  (`swReg.showNotification({showTrigger})`) when the browser supports them,
  else the in-app poller `pollNotifications()` (runs on `tick()` every 30s
  while the app is open). Dedup ids live in localStorage `insomnia.notified`;
  during time simulation the poller uses an **in-memory** set instead, so sim
  never poisons real reminders. OS triggers always schedule against real
  event epochs regardless of simulation. Lead time 5–60 min (`leadSelect`).
- **Install gate**: in a browser tab (`!isStandalone()`), tapping ⭐ does NOT
  save — it opens the `#installGate` modal (deliberately on every tap, no
  "don't show again"), reusing the `beforeinstallprompt` deferred event or
  showing per-OS instructions. Favourites persist only in standalone mode.
  Playwright tests emulate standalone via the `navigator.standalone` init
  script (see Commands).

### Data sanity thresholds (build refuses to overwrite on breach)

- programme: ≥50 daytime AND ≥10 animation events (both `scrape_site.py`
  and the in-app direct-update button use the same gate);
- geo: ≥30 points; KML response must contain `<kml` and ≥50 `<Placemark>`
  before the fixture is even written (Google can serve consent HTML as 200);
- basemap: ≥10 objects.

### Map / geo

- `scripts/build_geo.py` converts the My Maps KML (fixture
  `tests/fixtures/festival_map.kml`, KMZ also accepted) into `data/geo.json`:
  points/zones/roads with category rules; point+polygon pairs dedup by name,
  same-named standalone points (18 «Туалет») stay separate; ЦУЭ and «Кирпич»
  intentionally skipped; KML `<description>` (editor timestamps) ignored.
- `data/place-aliases.json`: manual venue→point aliases; a value may be a LIST
  of point names (multi-point venues). Keys are normalized at load.
- `map.js` owns Leaflet (`vendor/leaflet.*`), the «карта» view and «рядом»;
  loaded before app.js, shares its globals. **No raster tiles**: OSM tile
  servers block bulk/datacenter fetches (verified: 1811 identical «Access
  blocked» stubs). The basemap is DATA — `data/basemap.json` (water/forest/
  meadow/paths/buildings) fetched once from Overpass by `fetch-tiles.yml`
  and drawn as themed Leaflet polygons; attribution «данные © OpenStreetMap»
  is kept. basemap.json rides the normal SW precache.
- Event cards link to the in-app map (`eventGeoPoints`) — no Google Maps
  links anywhere in runtime.

### Data schema notes

`events[]`: `id, type(program|animation), date, start, end, startISO, endISO,
venue, title, description, films[], age` + optional `filmDetails[{title, plot}]`
and `participants[{name, bio}]` (export-only; xlsx import produces events without
them, so render code must tolerate absence). Top-level: `days[]`, `venues[]`,
`venueInfo{name→description}`.

## Deployment / operations

- Hosted as static files (GitHub Pages, relative paths — works from a subfolder).
- Workflows: `tests.yml` (npm test on every push/PR), `update-program.yml`
  (cron 6h: программа + geo; runs from the DEFAULT branch only),
  `fetch-tiles.yml` (dispatch-only; historical name — fetches the Overpass
  basemap, not tiles). The GitHub MCP tools trigger/inspect them from the
  sandbox (`actions_run_trigger`, then job logs). CI commits data back to the
  branch — `git pull` before continuing local work; data-commit steps use a
  pull-rebase retry (races with human pushes are real).
- **workflow_dispatch quirk**: a new workflow file is only dispatchable once it
  exists on the repo's DEFAULT branch — cherry-pick the yml there first, then
  dispatch with `ref:` pointing at your feature branch.
- Process the owner expects: **one branch per task** → PR → orchestrated
  adversarial verify (multi-agent) → fix findings → merge → update README on
  task completion. Verify agents found real bugs in every round — don't skip it.
- History: PRs #1–#5 merged (пайплайн, тема+карта v1+гейт, модель времени,
  карта v2+рядом, автотесты). Owner still needs to flip Settings → default
  branch to `main` and enable GitHub Pages (main / root).

## Владелец

Сергей (@skhlebnikov, tg), zen-programmer — терминальная эстетика (тёмные
console-окна, зелёный prompt, JetBrains-Mono-вайб, юмор вида `sudo sit → seat
acquired`). Дизайн приложения должен ненавязчиво отсылать к этому стилю, не
жертвуя читабельностью и юзабилити.
