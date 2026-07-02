#!/usr/bin/env python3
"""Build data/geo.json from the festival's Google My Maps KML.

Источник: tests/fixtures/festival_map.kml (doc.kml той же карты; KMZ — это
zip с doc.kml внутри, поддерживается и он). Внутри 8 папок (Folder) с
Placemark трёх типов: Point / Polygon / LineString. Многие объекты
встречаются дважды (точка + полигон с одним именем) — дедупим в один
объект. <description> — таймстемпы правок редактора, игнорируются.

Категоризация: папка + правила по имени (см. CATEGORY_RULES). Всё
несмэтченное попадает в 'other' с warning в лог — молча не теряем.

Выход data/geo.json:
  { points: [{id, name, lat, lng, category}],
    zones:  [{id, name, category, polygon: [[lat,lng],...]}],
    roads:  [{name, type: "foot"|"auto", line: [[lat,lng],...]}] }

Плюс venuePoints: мэтчинг площадок программы к точкам (алиасы в
data/place-aliases.json; алиас может указывать на НЕСКОЛЬКО точек —
например «Психологическая беседка» → Полевая/Речная/Игры).
"""
import json
import re
import sys
import zipfile
import html as html_mod
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KML_FIXTURE = ROOT / "tests" / "fixtures" / "festival_map.kml"
OUT = ROOT / "data" / "geo.json"
ALIASES_FILE = ROOT / "data" / "place-aliases.json"
PROGRAM = ROOT / "data" / "program.json"


def clean(s):
    if s is None:
        return ""
    s = re.sub(r"^<!\[CDATA\[|\]\]>$", "", str(s).strip())
    s = html_mod.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def norm_key(s):
    """Нормализация имени для дедупа/мэтчинга: регистр, ё, кавычки, точки."""
    s = clean(s).lower().replace("ё", "е")
    s = re.sub(r"[«»\"'’‘“”.,!()‘’]|[\U0001F000-\U0001FAFF]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


# --- категоризация: (папка, [(regex по имени, категория)], категория по умолчанию)
SKIP = "__skip__"
CATEGORY_RULES = {
    "Аттракторы со звуком": ([
        (r"экран", "screen"),
        (r"цуэ", SKIP),           # служебные центры управления экранами
        (r"сцена|тстц", "stage"),  # включая площадку-плейсхолдер «Тстцтсттсцтс»
    ], "venue"),
    "Еда": ([], "food"),
    "Туалеты": ([], "wc"),
    "Дороги": ([
        (r"кирпич", SKIP),        # точки-«кирпичи» на дорогах
    ], "roads"),
    "Арт-объекты": ([], "art"),
    "Платные услуги": ([
        (r"душ", "shower"),
    ], "paid"),
    "Аттракторы без звука": ([
        (r"инфоцентр", "info"),
        (r"психологическая беседка|территория тела|шатер анимации|шатёр анимации|хатифнариум", "workshop"),
        (r"ярмарка|чудаукцион", "market"),
        (r"детск|крылья|крепость пуха", "kids"),
        (r"чайка", "landmark"),
        (r"чайн|кальян|баня|чиль", "chill"),
    ], "place"),
    "Административные объекты": ([
        (r"медпункт", "med"),
        (r"кпп", "kpp"),
        (r"парковка", "parking"),
    ], "service"),
}


def categorize(folder, name):
    rules, default = CATEGORY_RULES.get(folder, ([], None))
    low = norm_key(name)
    for pattern, cat in rules:
        if re.search(pattern, low):
            return cat
    if default is None:
        print(f"warning: объект '{name}' из неизвестной папки '{folder}' -> other",
              file=sys.stderr)
        return "other"
    return default


def read_kml(path):
    p = Path(path)
    if p.suffix.lower() == ".kmz" or zipfile.is_zipfile(p):
        with zipfile.ZipFile(p) as z:
            for n in z.namelist():
                if n.lower().endswith(".kml"):
                    return z.read(n).decode("utf-8", "replace")
        sys.exit(f"no .kml inside {p}")
    return p.read_text(encoding="utf-8")


def parse_coords(text):
    pts = []
    for triple in text.replace("\n", " ").split():
        parts = triple.split(",")
        if len(parts) >= 2:
            lng, lat = float(parts[0]), float(parts[1])
            pts.append([round(lat, 6), round(lng, 6)])
    return pts


def build(kml_path=KML_FIXTURE):
    kml = read_kml(kml_path)
    objects = {}   # norm_key -> {name, category, point?, zone?}
    roads = []
    stats = {}
    skipped = []

    for chunk in re.split(r"<Folder>", kml)[1:]:
        fm = re.search(r"<name>(.*?)</name>", chunk, re.S)
        folder = clean(fm.group(1)) if fm else ""
        for pm in re.findall(r"<Placemark>(.*?)</Placemark>", chunk, re.S):
            nm = re.search(r"<name>(.*?)</name>", pm, re.S)
            name = clean(nm.group(1)) if nm else ""
            if not name:
                continue
            cat = categorize(folder, name)
            if cat == SKIP:
                skipped.append(f"{folder}/{name}")
                continue

            line_m = re.search(r"<LineString>.*?<coordinates>\s*(.*?)\s*</coordinates>",
                               pm, re.S)
            if cat == "roads":
                if not line_m:
                    skipped.append(f"{folder}/{name} (точка в дорогах)")
                    continue
                rtype = "auto" if norm_key(name).startswith("авто") else "foot"
                roads.append({"name": name, "type": rtype,
                              "line": parse_coords(line_m.group(1))})
                stats["roads"] = stats.get("roads", 0) + 1
                continue

            key = norm_key(name)
            pt_m = re.search(r"<Point>.*?<coordinates>\s*(.*?)\s*</coordinates>",
                             pm, re.S)
            poly_m = re.search(
                r"<Polygon>.*?<outerBoundaryIs>.*?<coordinates>\s*(.*?)\s*</coordinates>",
                pm, re.S)
            # дедуп: сливаем ПАРУ точка+полигон с одним именем в один объект,
            # но одноимённые самостоятельные точки (18 «Туалетов») не склеиваем
            bucket = objects.setdefault(key, [])
            obj = None
            if pt_m:
                obj = next((o for o in bucket if "point" not in o), None)
            elif poly_m or line_m:
                obj = next((o for o in bucket if "zone" not in o), None)
            if obj is None:
                obj = {"name": name, "category": cat}
                bucket.append(obj)
            if pt_m:
                lat, lng = parse_coords(pt_m.group(1))[0]
                obj["point"] = {"lat": lat, "lng": lng}
            if poly_m:
                obj["zone"] = parse_coords(poly_m.group(1))
            if line_m and not pt_m and not poly_m:
                # не-дорожная линия (бывает у заборов) — считаем зоной-линией
                obj.setdefault("zone", parse_coords(line_m.group(1)))

    points, zones = [], []
    seq = 0
    flat = [o for bucket in objects.values() for o in bucket]
    for obj in flat:
        seq += 1
        oid = f"g{seq:03d}"
        cat = obj["category"]
        stats[cat] = stats.get(cat, 0) + 1
        if "point" in obj:
            points.append({"id": oid, "name": obj["name"], "category": cat,
                           "lat": obj["point"]["lat"], "lng": obj["point"]["lng"]})
        if "zone" in obj:
            zones.append({"id": oid, "name": obj["name"], "category": cat,
                          "polygon": obj["zone"]})
        if "point" not in obj and "zone" not in obj:
            print(f"warning: '{obj['name']}' без геометрии — пропущен", file=sys.stderr)

    # --- мэтчинг площадок программы (алиасы могут давать несколько точек) ---
    aliases = {}
    if ALIASES_FILE.exists():
        raw_aliases = json.loads(ALIASES_FILE.read_text(encoding="utf-8"))
        aliases = {norm_key(k): v for k, v in raw_aliases.items()}
    venue_points = {}
    unmatched = []
    if PROGRAM.exists():
        venues = json.loads(PROGRAM.read_text(encoding="utf-8")).get("venues", [])
        by_key = {}
        for p in points:
            by_key.setdefault(norm_key(p["name"]), []).append(p["id"])
        for venue in venues:
            ids = match_venue(venue, by_key, aliases)
            if ids:
                venue_points[venue] = ids
            else:
                unmatched.append(venue)

    if len(points) < 30:
        sys.exit(f"geo sanity check failed: только {len(points)} точек — "
                 "отказываюсь перезаписывать data/geo.json")
    payload = {"points": points, "zones": zones, "roads": roads,
               "venuePoints": venue_points}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
                   encoding="utf-8")

    print("=== geo.json: категории ===")
    for cat, n in sorted(stats.items(), key=lambda x: -x[1]):
        print(f"  {cat:10} {n}")
    print(f"итого: {len(points)} точек, {len(zones)} зон, {len(roads)} дорог -> {OUT}")
    print(f"пропущено осознанно ({len(skipped)}):", "; ".join(skipped[:10]),
          "…" if len(skipped) > 10 else "")
    print(f"=== мэтчинг площадок: {len(venue_points)} ok, {len(unmatched)} без точки ===")
    for v in unmatched:
        print(f"  ✗ {v}")
    for v, ids in list(venue_points.items()):
        if len(ids) > 1:
            print(f"  множественный: {v} -> {ids}")


def _stem_set(s):
    return set(w[:5] for w in norm_key(s).split()
               if w not in ("2026", "и", "у", "в", "на"))


def match_venue(venue, by_key, aliases):
    """Вернуть список id точек для площадки программы."""
    nk = norm_key(venue)
    # 1) явный алиас (значение: имя точки или список имён)
    if nk in aliases:
        val = aliases[nk]
        names = val if isinstance(val, list) else [val]
        ids = []
        for n in names:
            ids += by_key.get(norm_key(n), [])
        return ids
    # 2) точное совпадение нормализованного имени
    if nk in by_key:
        return by_key[nk]
    # 3) точное совпадение суб-части: «Чайный терем / Чайная Пагода» ->
    #    точка «Чайная Пагода» приоритетнее базовой
    parts = [p.strip() for p in re.split(r"[/.]", venue) if p.strip()]
    for part in parts[::-1]:
        pk = norm_key(part)
        if pk in by_key:
            return by_key[pk]
    # 4) fuzzy по стемам
    candidates = [venue] + parts[::-1]
    best, best_score = None, 0.0
    for cand in candidates:
        cw = _stem_set(cand)
        cfull = set(norm_key(cand).split())
        if not cw:
            continue
        for key, ids in by_key.items():
            pw = _stem_set(key)
            pfull = set(key.split())
            inter = len(cw & pw)
            if not inter:
                continue
            confident = (inter == len(pw)
                         or (inter == len(cw) and len(cw) >= 2)
                         or (len(cfull) == 1 and cfull & pfull))
            score = (1.0 if confident else inter / max(len(cw), len(pw))) \
                + inter * 0.01 + len(cfull & pfull) * 0.1
            if score > best_score:
                best, best_score = ids, score
        if best_score >= 1.0:
            break
    return best if best and best_score >= 1.0 else []


if __name__ == "__main__":
    build(Path(sys.argv[1]) if len(sys.argv) > 1 else KML_FIXTURE)
