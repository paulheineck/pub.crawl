"""Erzeugt web/journals.json aus journals.yaml (Journal-Katalog der Browser-Version).

Aufruf aus dem Repo-Hauptordner:  python web/build_catalog.py
"""
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
catalog = yaml.safe_load((ROOT / "journals.yaml").read_text(encoding="utf-8")) or []
out = [{"name": j["name"], "url": j["url"], "category": j.get("category", "Sonstige")} for j in catalog]
(ROOT / "web" / "journals.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"{len(out)} Journals → web/journals.json")
