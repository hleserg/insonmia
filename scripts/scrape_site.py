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
# Фестивальные сутки: 06:00 -> 05:59 следующего дня. Всё до 06:00 утра
# относится к фестивальному дню предыдущей календарной даты.
NIGHT_ROLLOVER_HOUR = 6

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
    s = s.replace("\ufeff", "")
    s = s.replace("\xa0", " ").replace("\u2028", "\n").replace("\r\n", "\n")
    s = s.replace("\r", "\n").replace("\x85", "\n")
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
        "meta": {
            "version": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "insomniafest.ru",
        },
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
    # meta.version — время выгрузки; чтобы cron не коммитил только из-за неё,
    # не перезаписываем файл, если контент (без meta) не изменился
    if OUT.exists():
        try:
            prev = json.loads(OUT.read_text(encoding="utf-8"))
            prev_cmp = {k: v for k, v in prev.items() if k != "meta"}
            new_cmp = {k: v for k, v in payload.items() if k != "meta"}
            if "meta" in prev and prev_cmp == new_cmp:
                print(f"programme unchanged ({len(payload['events'])} events) — keeping "
                      f"existing {OUT} (version {prev.get('meta', {}).get('version')})")
                return
        except (json.JSONDecodeError, OSError):
            pass
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
                   encoding="utf-8")
    print(f"wrote {len(payload['events'])} events "
          f"({n_places} programme + {n_anim} animation) across "
          f"{len(payload['days'])} days -> {OUT}")


MAP_OUT = ROOT / "data" / "map.json"
MAP_VIEW_URL = "https://www.google.com/maps/d/viewer?mid=1ImxgvK4d6XoIuTXzKlhjGs2Cdv4MrNg"
# слои без точечной пользы в списке (линии дорог)
MAP_SKIP_LAYERS = {"Дороги"}
# ручные алиасы: имя площадки в программе -> имя точки на карте
VENUE_ALIASES = {
    "harmonystan": "гармонистан",
    "детский шатер запуска": "детский шатер",
}
_TS_RE = re.compile(r"^\s*\d{1,2}\.\d{1,2}\.\d{4}[ T]\d{1,2}:\d{2}(:\d{2})?\s*$")


def _norm_words(name):
    """(stems, full_words) for fuzzy venue<->placemark matching."""
    s = clean_text(name).lower().replace("ё", "е")
    s = re.sub(r"[«»\"()\u2018\u2019\u201c\u201d'’“”.,!?:;/·—–-]", " ", s)
    s = VENUE_ALIASES.get(s.strip(), s)
    full = [w for w in s.split() if w and w not in ("2026", "и", "у", "в")]
    return set(w[:5] for w in full), set(full)


def _clean_pm_desc(desc):
    """Placemark descriptions are mostly editor timestamps — drop those,
    keep real text; strip CDATA and tags, keep bare https links as text."""
    if not desc:
        return ""
    s = re.sub(r"^<!\[CDATA\[|\]\]>$", "", desc.strip())
    s = s.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n")
    s = re.sub(r"<[^>]+>", "", s)
    s = clean_text(s)
    lines = [ln for ln in s.split("\n") if ln.strip() and not _TS_RE.match(ln)]
    return "\n".join(lines).strip()


def parse_kml(kml_text):
    layers = []
    for chunk in re.split(r"<Folder>", kml_text)[1:]:
        m = re.search(r"<name>(.*?)</name>", chunk, re.S)
        lname = clean_text(re.sub(r"^<!\[CDATA\[|\]\]>$", "", m.group(1).strip())) if m else ""
        if not lname or lname in MAP_SKIP_LAYERS:
            continue
        points = []
        for pm in re.findall(r"<Placemark>(.*?)</Placemark>", chunk, re.S):
            if "<Point>" not in pm:
                continue  # линии/полигоны в списке не нужны
            nm = re.search(r"<name>(.*?)</name>", pm, re.S)
            name = clean_text(re.sub(r"^<!\[CDATA\[|\]\]>$", "", nm.group(1).strip())) if nm else ""
            if not name:
                continue
            dm = re.search(r"<description>(.*?)</description>", pm, re.S)
            desc = _clean_pm_desc(dm.group(1)) if dm else ""
            cm = re.search(r"<Point>.*?<coordinates>\s*([\d.,\s-]+?)\s*</coordinates>", pm, re.S)
            if not cm:
                continue
            lng, lat = cm.group(1).split(",")[:2]
            points.append({
                "name": normalize_venue(name),
                "desc": desc,
                "lat": round(float(lat), 6),
                "lng": round(float(lng), 6),
            })
        if points:
            layers.append({"name": lname, "points": points})
    return layers


def match_venues(layers, venues):
    """Match programme venue names to map points; returns {venue: point}.

    Правила уверенного матча (score >= 1):
      - стемы точки полностью покрыты кандидатом (или наоборот, если у
        кандидата >= 2 слов);
      - однословный кандидат матчится только ПОЛНЫМ словом (иначе
        «Беседошная» прилипает к «беседке»).
    Бонус за совпадение целых слов разруливает ничьи.
    """
    all_points = [p for l in layers for p in l["points"]]
    result = {}
    for venue in venues:
        parts = [v.strip() for v in venue.split("/") if v.strip()]
        candidates = [venue] + parts[::-1]  # полное имя, затем суб-площадка, затем база
        best, best_score = None, 0.0
        for cand in candidates:
            cw, cfull = _norm_words(normalize_venue(cand))
            if not cw:
                continue
            for p in all_points:
                pw, pfull = _norm_words(p["name"])
                if not pw:
                    continue
                inter = len(cw & pw)
                if not inter:
                    continue
                confident = (
                    inter == len(pw)
                    or (inter == len(cw) and len(cw) >= 2)
                    or (len(cfull) == 1 and cfull & pfull)
                )
                score = (1.0 if confident else inter / max(len(cw), len(pw)))                     + inter * 0.01 + len(cfull & pfull) * 0.1
                if score > best_score:
                    best, best_score = p, score
            if best_score >= 1.0:
                break
        if best and best_score >= 1.0:
            result[venue] = {"lat": best["lat"], "lng": best["lng"], "point": best["name"]}
    return result


def build_map(from_file=None):
    if from_file:
        kml = Path(from_file).read_text(encoding="utf-8")
        print(f"read KML from {from_file}: {len(kml)} bytes")
    else:
        kml, status = fetch(MAP_KML_URL)
        print(f"[{status}] KML: {len(kml)} bytes")
    layers = parse_kml(kml)
    n_points = sum(len(l["points"]) for l in layers)
    if n_points < 30:
        sys.exit(f"map sanity check failed: only {n_points} points — refusing to overwrite")
    venues = []
    if OUT.exists():
        venues = json.loads(OUT.read_text(encoding="utf-8")).get("venues", [])
    venue_points = match_venues(layers, venues)
    payload = {
        "title": "Карта «Бессонницы—2026»",
        "mapUrl": MAP_VIEW_URL,
        "layers": layers,
        "venuePoints": venue_points,
    }
    MAP_OUT.parent.mkdir(parents=True, exist_ok=True)
    MAP_OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    matched = len(venue_points)
    print(f"wrote {n_points} points in {len(layers)} layers; venue match: {matched}/{len(venues)} -> {MAP_OUT}")
    unmatched = [v for v in venues if v not in venue_points]
    if unmatched:
        print("unmatched venues:", "; ".join(unmatched))


def recon_map():
    out = ROOT / "debug_html"
    out.mkdir(exist_ok=True)
    body, status = fetch(MAP_KML_URL)
    (out / "festival_map.kml").write_text(body, encoding="utf-8")
    print(f"[{status}] KML: {len(body)} bytes")


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
    ap.add_argument("mode", choices=["build", "recon", "map", "map-recon"], nargs="?", default="build")
    ap.add_argument("--from", dest="from_file", default=None,
                    help="read export JSON from a local file instead of the network")
    args = ap.parse_args()
    if args.mode == "build":
        build(args.from_file)
    elif args.mode == "map":
        build_map(args.from_file)
    elif args.mode == "map-recon":
        recon_map()
    else:
        recon()
