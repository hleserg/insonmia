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
    """Round 2: the programme page is a JS shell; the data comes from
    PROGRAM_EXPORT_URL = https://insomniafest.ru/export/program/2026.
    Fetch that export (plus the programApp JS that consumes it) and commit
    both so the parser can be written against the real format."""
    out = ROOT / "debug_html"
    out.mkdir(exist_ok=True)
    targets = {
        "export_program_2026.txt": "https://insomniafest.ru/export/program/2026",
        "programApp.js": "https://insomniafest.ru/?js=_js/programApp.v.1782814175",
    }
    print("=== insomniafest.ru recon round 2 ===")
    for fname, url in targets.items():
        try:
            body, status = fetch(url)
        except urllib.error.HTTPError as e:
            print(f"[HTTP {e.code}] {url}")
            # Save the error body too — it may describe expected params.
            try:
                (out / fname).write_text(e.read().decode("utf-8", "replace"), encoding="utf-8")
            except Exception:
                pass
            continue
        except Exception as e:
            print(f"[ERR] {url}: {e}")
            continue
        (out / fname).write_text(body, encoding="utf-8")
        print(f"[{status}] {url} -> {fname}: {len(body)} bytes")
        print(f"--- first 2000 chars of {fname} ---")
        print(body[:2000])
        print("--- end ---")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "recon"
    if mode == "recon":
        recon()
    else:
        sys.exit(f"unknown mode: {mode}")
