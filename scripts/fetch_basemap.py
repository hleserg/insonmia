#!/usr/bin/env python3
"""Скачать подложку карты как ДАННЫЕ (не тайлы) через Overpass API.

OSM tile-серверы блокируют массовое скачивание тайлов из датацентров
(проверено: 1811 заглушек «Access blocked»). Легальный путь — разовый
Overpass-запрос геоданных: вода, лес, луга, тропы. Из них рисуем свою
тематическую подложку Leaflet-полигонами — легче (сотни КБ), красивее
в тёмной теме и тривиально офлайн.

Выход: data/basemap.json
  { water: [[[lat,lng],...]], forest: [...], meadow: [...],
    paths: [[[lat,lng],...]], buildings: [...] }
"""
import json
import sys
import urllib.request
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "basemap.json"

# bbox фестиваля + запас 25%
LAT0, LAT1 = 54.6753, 54.6928
LON0, LON1 = 35.0571, 35.0969
dlat, dlon = (LAT1 - LAT0) * 0.25, (LON1 - LON0) * 0.25
BBOX = f"{LAT0-dlat},{LON0-dlon},{LAT1+dlat},{LON1+dlon}"

QUERY = f"""
[out:json][timeout:90];
(
  way["natural"="water"]({BBOX});
  way["waterway"="riverbank"]({BBOX});
  relation["natural"="water"]({BBOX});
  way["landuse"~"forest|meadow|farmland|grass|orchard"]({BBOX});
  way["natural"~"wood|scrub|grassland|wetland"]({BBOX});
  way["highway"~"path|track|footway|unclassified|service"]({BBOX});
  way["waterway"="river"]({BBOX});
  way["building"]({BBOX});
);
out geom;
"""

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def fetch_overpass():
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for url in ENDPOINTS:
        try:
            req = urllib.request.Request(url, data=data, headers={
                "User-Agent": "insomnia-fest-offline-pwa/1.0 "
                              "(+https://github.com/hleserg/insonmia; one-time basemap fetch)",
            })
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # пробуем следующее зеркало
            last = e
            print(f"  {url}: {e}", file=sys.stderr)
    sys.exit(f"Overpass недоступен: {last}")


def classify(tags):
    if tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
        return "water", True
    if tags.get("waterway") == "river":
        return "water_line", False
    if tags.get("landuse") in ("forest",) or tags.get("natural") in ("wood", "scrub"):
        return "forest", True
    if (tags.get("landuse") in ("meadow", "farmland", "grass", "orchard")
            or tags.get("natural") in ("grassland", "wetland")):
        return "meadow", True
    if tags.get("building"):
        return "building", True
    if tags.get("highway"):
        return "path", False
    return None, False


def simplify(coords, tolerance=1e-5):
    """Простое прореживание Дугласа-Пекера не нужно — хватает шага."""
    if len(coords) <= 40:
        return coords
    step = max(1, len(coords) // 200)
    out = coords[::step]
    if out[-1] != coords[-1]:
        out.append(coords[-1])
    return out


def main():
    raw = fetch_overpass()
    layers = {"water": [], "water_line": [], "forest": [], "meadow": [],
              "path": [], "building": []}
    for el in raw.get("elements", []):
        tags = el.get("tags", {})
        kind, is_area = classify(tags)
        if not kind:
            continue
        if el["type"] == "way" and el.get("geometry"):
            coords = [[round(g["lat"], 6), round(g["lon"], 6)] for g in el["geometry"]]
            layers[kind].append(simplify(coords))
        elif el["type"] == "relation" and el.get("members"):
            for m in el["members"]:
                if m.get("role") == "outer" and m.get("geometry"):
                    coords = [[round(g["lat"], 6), round(g["lon"], 6)] for g in m["geometry"]]
                    layers[kind].append(simplify(coords))

    total = sum(len(v) for v in layers.values())
    if total < 10:
        sys.exit(f"basemap sanity failed: всего {total} объектов")
    OUT.write_text(json.dumps(layers, ensure_ascii=False,
                              separators=(",", ":")) + "\n", encoding="utf-8")
    print("basemap:", {k: len(v) for k, v in layers.items()},
          f"-> {OUT} ({OUT.stat().st_size // 1024} КБ)")


if __name__ == "__main__":
    main()
