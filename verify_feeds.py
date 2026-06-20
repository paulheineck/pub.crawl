"""Prüft alle Feeds im Katalog (journals.yaml) per Probe-Request auf Erreichbarkeit.

    python verify_feeds.py          # nur den Katalog
    python verify_feeds.py --all    # Katalog + abonnierte Feeds (config.yaml)

Listet tote/leere Feeds auf, damit der Katalog gepflegt werden kann.
"""
import sys
from concurrent.futures import ThreadPoolExecutor

import app


def _probe(item):
    name, url = item.get("name"), item.get("url")
    try:
        ok, cnt, info = app.probe_feed(url)
    except Exception as ex:
        ok, cnt, info = False, 0, str(ex)
    return (ok and cnt > 0, name, url, cnt, "" if ok else str(info)[:70])


def _run(items, label):
    with ThreadPoolExecutor(max_workers=12) as ex:
        res = list(ex.map(_probe, items))
    dead = [r for r in res if not r[0]]
    print(f"\n{label}: {len(res) - len(dead)}/{len(res)} ok")
    for _, name, url, _cnt, err in sorted(dead, key=lambda r: r[1].lower()):
        print(f"  TOT  {name}  ({err})\n       {url}")
    return dead


if __name__ == "__main__":
    _run(app.load_catalog(), "Katalog (journals.yaml)")
    if "--all" in sys.argv:
        _run(app.load_cfg().get("feeds") or [], "Abos (config.yaml)")
