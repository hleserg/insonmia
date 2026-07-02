#!/usr/bin/env python3
"""Скачать OSM-тайлы фестивальной зоны для офлайн-карты.

BBox данных карты (lat 54.675–54.693, lon 35.057–35.097) + отступ 20%,
зумы 13–18 → ~1.9К тайлов, ~20МБ. Качаем ВЕЖЛИВО (правильный User-Agent,
пауза между запросами, докачка только отсутствующих) и один раз — тайлы
коммитятся в репозиторий и дальше раздаются с GitHub Pages.

Запускается в CI (workflow_dispatch): песочница разработки не имеет
доступа к tile.openstreetmap.org.

Выход: assets/tiles/{z}/{x}/{y}.png + assets/tiles/manifest.json
(список URL для прекэша сервис-воркером).
"""
import json
import math
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "tiles"

LAT0, LAT1 = 54.6753, 54.6928
LON0, LON1 = 35.0571, 35.0969
PAD = 0.20
ZOOMS = range(13, 19)

TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
HEADERS = {
    # честный UA с контактом — требование OSM tile usage policy
    "User-Agent": "insomnia-fest-offline-pwa/1.0 (+https://github.com/hleserg/insonmia; one-time build fetch)",
}
DELAY = 0.15  # сек между запросами


def deg2tile(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


def main():
    dlat = (LAT1 - LAT0) * PAD
    dlon = (LON1 - LON0) * PAD
    la0, la1 = LAT0 - dlat, LAT1 + dlat
    lo0, lo1 = LON0 - dlon, LON1 + dlon

    urls = []
    todo = []
    for z in ZOOMS:
        x0, y0 = deg2tile(la1, lo0, z)
        x1, y1 = deg2tile(la0, lo1, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                rel = f"{z}/{x}/{y}.png"
                urls.append(f"assets/tiles/{rel}")
                p = OUT / rel
                if not p.exists() or p.stat().st_size == 0:
                    todo.append((z, x, y, p))

    print(f"тайлов всего: {len(urls)}, докачать: {len(todo)}")
    fetched = failed = 0
    for z, x, y, p in todo:
        p.parent.mkdir(parents=True, exist_ok=True)
        url = TILE_URL.format(z=z, x=x, y=y)
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as r:
                p.write_bytes(r.read())
            fetched += 1
        except Exception as e:
            failed += 1
            print(f"  fail {url}: {e}", file=sys.stderr)
        time.sleep(DELAY)
        if fetched and fetched % 200 == 0:
            print(f"  …{fetched}/{len(todo)}")

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(urls), encoding="utf-8")
    total_mb = sum(f.stat().st_size for f in OUT.rglob("*.png")) / 1e6
    print(f"готово: +{fetched}, ошибок {failed}, всего на диске {total_mb:.1f} МБ")
    if failed > len(urls) * 0.05:
        sys.exit("слишком много ошибок — проверьте доступ к tile.openstreetmap.org")


if __name__ == "__main__":
    main()
