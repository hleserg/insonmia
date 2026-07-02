# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Офлайн-PWA с программой фестиваля анимации «Бессонница 2026» (9–13 июля, ночные
показы + дневная программа). Пользователь ставит его на телефон, отмечает события
звёздочкой и получает напоминания за N минут до начала. Всё работает без сети.
UI и комментарии — на русском; общение с владельцем репозитория — тоже по-русски.

## Commands

```bash
# Rebuild data/program.json from the site export (what CI does):
python3 scripts/scrape_site.py build
# Offline, from the committed fixture:
python3 scripts/scrape_site.py build --from tests/fixtures/export_program_2026.json
# Fallback: rebuild from the Excel files in source_xlsx/ (needs openpyxl):
pip install -r requirements.txt && python3 scripts/convert_xlsx.py

# Serve the app locally (no build step — plain static files):
python3 -m http.server 8099
# End-to-end smoke test via Playwright (module lives at /opt/node22/lib/node_modules
# in the cloud sandbox; chromium binary at /opt/pw-browsers/chromium):
node /tmp/drive.cjs   # see "Testing" below — drive scripts are written ad hoc
```

There is no bundler, linter, or test framework: vanilla JS + Python stdlib.
Verification is done by driving the served app with Playwright (mock the clock
with `page.clock.install({time: new Date('2026-07-09T23:20:00')})` to test the
festival-night "live" states) and by sanity-checking the regenerated JSON
(event count ~705, id overlap vs the previous data — see below).

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

2. **The app (vanilla JS PWA, no build).** `app.js` renders three views (Сейчас /
   Программа / Избранное) from the program JSON kept in `localStorage` (imported
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
- **Night rollover:** festival "days" run into the small hours. Times with hour
  `< 9` belong to the *previous* festival day (`NIGHT_ROLLOVER_HOUR = 9`): the
  `date` field is the festival-day bucket, while `startISO`/`endISO` are the real
  Moscow-time (`UTC+3`, no DST) datetimes used for sorting and the "now" view.
- **Venue placeholder:** the site names one stage with keyboard-mash text
  (`тстцтсттсцтс`); `normalize_venue` in all three converters maps any all-`тсц`
  string to `Сцена (уточняется)`.
- Text from the export is HTML-unescaped and `\xa0`-normalized (`clean_text`);
  the app HTML-escapes on render (`escapeHtml`) — don't inject raw strings.

### Data schema notes

`events[]`: `id, type(program|animation), date, start, end, startISO, endISO,
venue, title, description, films[], age` + optional `filmDetails[{title, plot}]`
and `participants[{name, bio}]` (export-only; xlsx import produces events without
them, so render code must tolerate absence). Top-level: `days[]`, `venues[]`,
`venueInfo{name→description}`.

## Deployment / operations

- Hosted as static files (GitHub Pages, relative paths — works from a subfolder).
- The GitHub MCP tools are the way to trigger/inspect workflows from the sandbox
  (`actions_run_trigger` with `update-program.yml`, then read job logs). CI commits
  regenerated data back to the branch — `git pull` before continuing local work.
- PR #1 (`claude/festa-insomnia-mobile-app-6rec4z` → `main`) is the base feature
  PR. The owner prefers **one branch per task** and stacked PRs on top.

## Владелец

Сергей (@skhlebnikov, tg), zen-programmer — терминальная эстетика (тёмные
console-окна, зелёный prompt, JetBrains-Mono-вайб, юмор вида `sudo sit → seat
acquired`). Дизайн приложения должен ненавязчиво отсылать к этому стилю, не
жертвуя читабельностью и юзабилити.
