#!/usr/bin/env python3
"""Fetch the Бессонница 2026 programme pages from insomniafest.ru.

Runs on a GitHub Actions runner (which has open internet access and no CORS
restriction). Two modes:

  recon  — save raw HTML for every day/section into debug_html/ so the parser
           can be written against the real markup, and print a summary.
  build  — (added once the markup is known) parse the pages into
           data/program.json.

Usage: python3 scripts/scrape_site.py recon
"""
import sys
import os
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BASE = "https://insomniafest.ru/program-2026.html"
# Festival days -> Unix timestamp used by the site's ?day= parameter
# (verified: 1783666800 == 2026-07-10 10:00 MSK).
DAYS = {
    "2026-07-09": 1783580400,
    "2026-07-10": 1783666800,
    "2026-07-11": 1783753200,
    "2026-07-12": 1783839600,
    "2026-07-13": 1783926000,
}
SECTIONS = ["non-animation", "animation"]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru,en;q=0.8",
}


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=45) as resp:
        raw = resp.read()
        enc = resp.headers.get_content_charset() or "utf-8"
        return raw.decode(enc, errors="replace"), resp.status


def recon():
    out = ROOT / "debug_html"
    out.mkdir(exist_ok=True)
    markers = ["Время", "Экран", "Площадка", "Программа", "–", "21:", "22:"]
    print("=== insomniafest.ru recon ===")
    for section in SECTIONS:
        for date, ts in DAYS.items():
            url = f"{BASE}?section={section}&day={ts}"
            try:
                html, status = fetch(url)
            except urllib.error.HTTPError as e:
                print(f"[HTTP {e.code}] {section} {date} -> {url}")
                continue
            except Exception as e:
                print(f"[ERR] {section} {date}: {e}")
                continue
            fp = out / f"{section}_{date}.html"
            fp.write_text(html, encoding="utf-8")
            hits = [m for m in markers if m in html]
            print(f"[{status}] {section} {date}: {len(html):>7} bytes, markers={hits}")
    # Save one full page to stdout tail so we can eyeball structure from logs too.
    sample = out / f"non-animation_2026-07-09.html"
    if sample.exists():
        txt = sample.read_text(encoding="utf-8")
        print("\n=== SAMPLE (first 4000 chars of non-animation day 1) ===")
        print(txt[:4000])


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "recon"
    if mode == "recon":
        recon()
    else:
        sys.exit(f"unknown mode: {mode}")
