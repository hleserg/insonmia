#!/usr/bin/env python3
"""Fetch and convert the Бессонница 2026 programme from insomniafest.ru.

The site's programme page is a JS shell; the actual data lives at
PROGRAM_EXPORT_URL = https://insomniafest.ru/export/program/2026 — a JSON
document with two sections:

  places[]  : daytime venues; placeEvents[] carry eventTitle/eventDescription,
              eventAge, eventStart/eventEnd (unix, UTC), eventParticipants[]
  screens[] : night animation screens; screenPrograms[] carry programTitle,
              programAge, programStart/programEnd (unix, UTC) and
              programFilms[] with per-film synopses

Modes:
  build [--from FILE]  — fetch the export (or read FILE) and write
                         data/program.json in the app's schema.
  recon                — save the raw export + programApp.js to debug_html/
                         for parser development.

Runs on GitHub Actions (open egress, no CORS) on a schedule; commits the
regenerated data/program.json only when the content actually changed.
"""
import argparse
import html
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "program.json"

EXPORT_URL = "https://insomniafest.ru/export/program/2026"
MAP_KML_URL = ("https://www.google.com/maps/d/kml"
               "?mid=1ImxgvK4d6XoIuTXzKlhjGs2Cdv4MrNg&forcekml=1")
PROGRAM_APP_URL = "https://insomniafest.ru/?js=_js/programApp.v.1782814175"

YEAR = 2026
# Festival runs on Moscow time (UTC+3, no DST).
MSK = timezone(timedelta(hours=3))
# Times with an hour earlier than this belong to the previous festival day
# (a 00:30 screening is part of the preceding evening's night block).
NIGHT_ROLLOVER_HOUR = 9

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru,en;q=0.8",
}

RU_MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня",
                 "июля", "августа", "сентября", "октября", "ноября", "декабря"]


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
        enc = resp.headers.get_content_charset() or "utf-8"
        return raw.decode(enc, errors="replace"), resp.status


def clean_text(v):
    """Unescape HTML entities and normalize exotic whitespace."""
    if v is None:
        return ""
    s = html.unescape(str(v))
    s = s.replace("\xa0", " ").replace(" ", "\n").replace("\r\n", "\n")
    s = re.sub(r"[ \t]+", " ", s)
    return s.strip()


def normalize_venue(v):
    """The site names one stage with keyboard-mash placeholder text
    ('тстцтсттсцтс'); show a readable 'stage TBD' label instead. Mirrors
    convert_xlsx.py and app.js so event ids stay identical."""
    s = clean_text(v)
    letters = re.sub(r"[^а-яёa-z]", "", s.lower())
    if letters and set(letters) <= set("тсц"):
        return "Сцена (уточняется)"
    return s


def fnv1a(text):
    """FNV-1a 32-bit over UTF-8 — mirrored in app.js and convert_xlsx.py so
    favourites keep matching across data refreshes."""
    h = 2166136261
    for b in text.encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return format(h, "08x")


def ts_to_msk(ts):
    return datetime.fromtimestamp(int(ts), tz=MSK)


def fest_date(dt_msk):
    """Festival-day bucket: early-morning events belong to the previous day."""
    return (dt_msk - timedelta(hours=NIGHT_ROLLOVER_HOUR)).date()


def iso_local(dt_msk):
    return dt_msk.strftime("%Y-%m-%dT%H:%M:00")


def hhmm(dt_msk):
    return dt_msk.strftime("%H:%M")


def make_event(kind, title, venue, start_ts, end_ts, description="", age="",
               films=None, film_details=None, participants=None):
    title = clean_text(title)
    venue = clean_text(venue)
    if not title or not str(start_ts).strip().isdigit():
        return None
    start = ts_to_msk(start_ts)
    end = ts_to_msk(end_ts) if str(end_ts or "").strip().isdigit() else None
    if end:
        # The export's end dates are unreliable (midnight-crossing ends dated
        # to the start's day, or dates typo'd days ahead). The time-of-day is
        # trustworthy: re-anchor it to the start's date, rolling one day
        # forward for past-midnight ends — same rule as convert_xlsx.py.
        end = end.replace(year=start.year, month=start.month, day=start.day)
        if end <= start:
            end += timedelta(days=1)
        if end - start > timedelta(hours=16):
            end = None  # duration still implausible — treat as unknown
    date_iso = fest_date(start).isoformat()
    ev = {
        "id": fnv1a("|".join([kind, date_iso, hhmm(start), venue, title])),
        "type": kind,
        "date": date_iso,
        "start": hhmm(start),
        "end": hhmm(end) if end else None,
        "startISO": iso_local(start),
        "endISO": iso_local(end) if end else None,
        "venue": venue,
        "title": title,
        "description": clean_text(description),
        "films": films or [],
        "age": clean_text(age),
    }
    if film_details:
        ev["filmDetails"] = film_details
    if participants:
        ev["participants"] = participants
    return ev


def convert_export(data):
    events = []
    venue_info = {}

    for place in data.get("places", []):
        pname = clean_text(place.get("placeName"))
        pdesc = clean_text(place.get("placeDescription"))
        if pname and pdesc:
            # key by the normalized name so lookups by event venue resolve
            venue_info[normalize_venue(pname)] = pdesc
        for e in place.get("placeEvents", []):
            loc = clean_text(e.get("eventLocationPlace"))
            base = normalize_venue(pname)
            venue = f"{base} / {loc}" if loc and loc.lower() != "none" else base
            participants = []
            plist = e.get("eventParticipants")
            if isinstance(plist, list):
                for p in plist:
                    name = clean_text(p.get("participantName"))
                    if name:
                        participants.append({
                            "name": name,
                            "bio": clean_text(p.get("participantBio")),
                        })
            ev = make_event(
                "program", e.get("eventTitle"), venue,
                e.get("eventStart"), e.get("eventEnd"),
                description=e.get("eventDescription"),
                age=e.get("eventAge"),
                participants=participants or None,
            )
            if ev:
                events.append(ev)

    for screen in data.get("screens", []):
        sname = normalize_venue(screen.get("screenName"))
        for pr in screen.get("screenPrograms", []):
            film_details = []
            films = []
            flist = pr.get("programFilms")
            if isinstance(flist, list):
                for f in flist:
                    ftitle = clean_text(f.get("title"))
                    if not ftitle:
                        continue
                    films.append(ftitle)
                    plot = clean_text(f.get("plot"))
                    film_details.append({"title": ftitle, "plot": plot})
            ev = make_event(
                "animation", pr.get("programTitle"), sname,
                pr.get("programStart"), pr.get("programEnd"),
                age=pr.get("programAge"),
                films=films,
                film_details=film_details or None,
            )
            if ev:
                events.append(ev)

    events.sort(key=lambda e: (e["startISO"] or "", e["venue"]))
    dates = sorted({e["date"] for e in events})
    days = []
    for d in dates:
        dt = datetime.fromisoformat(d)
        days.append({"date": d, "label": f"{dt.day} {RU_MONTHS_GEN[dt.month - 1]}"})
    return {
        # the export's title is a generic page title («Программа (2026)»)
        "festival": f"Бессонница {YEAR}",
        "year": YEAR,
        "source": EXPORT_URL,
        "version": 2,
        "days": days,
        "venues": sorted({e["venue"] for e in events if e["venue"]}),
        "venueInfo": venue_info,
        "events": events,
    }


def build(from_file=None):
    if from_file:
        raw = Path(from_file).read_text(encoding="utf-8")
        print(f"read export from {from_file}: {len(raw)} bytes")
    else:
        raw, status = fetch(EXPORT_URL)
        print(f"[{status}] {EXPORT_URL}: {len(raw)} bytes")
    data = json.loads(raw)
    payload = convert_export(data)
    n_places = sum(1 for e in payload["events"] if e["type"] == "program")
    n_anim = sum(1 for e in payload["events"] if e["type"] == "animation")
    if not payload["events"] or n_places < 50 or n_anim < 10:
        sys.exit(f"sanity check failed: {n_places} programme / {n_anim} animation "
                 "events — refusing to overwrite data/program.json")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
                   encoding="utf-8")
    print(f"wrote {len(payload['events'])} events "
          f"({n_places} programme + {n_anim} animation) across "
          f"{len(payload['days'])} days -> {OUT}")


def recon_map():
    """Fetch the festival's Google My Maps KML (layers, placemarks, coords,
    descriptions) so the offline map section can be built from it."""
    out = ROOT / "debug_html"
    out.mkdir(exist_ok=True)
    body, status = fetch(MAP_KML_URL)
    (out / "festival_map.kml").write_text(body, encoding="utf-8")
    print(f"[{status}] KML: {len(body)} bytes")
    print(body[:3000])


def recon():
    out = ROOT / "debug_html"
    out.mkdir(exist_ok=True)
    for fname, url in {"export_program_2026.txt": EXPORT_URL,
                       "programApp.js": PROGRAM_APP_URL}.items():
        try:
            body, status = fetch(url)
        except urllib.error.HTTPError as e:
            print(f"[HTTP {e.code}] {url}")
            continue
        (out / fname).write_text(body, encoding="utf-8")
        print(f"[{status}] {url} -> {fname}: {len(body)} bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["build", "recon", "map"], nargs="?", default="build")
    ap.add_argument("--from", dest="from_file", default=None,
                    help="read export JSON from a local file instead of the network")
    args = ap.parse_args()
    if args.mode == "build":
        build(args.from_file)
    elif args.mode == "map":
        recon_map()
    else:
        recon()
