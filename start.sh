#!/usr/bin/env bash
# ---------------------------------------
#  Research Dashboard - Local Startup
# ---------------------------------------

cd "$(dirname "$0")" || exit 1

echo "---------------------------------------"
echo "  Research Dashboard - Local Startup"
echo "---------------------------------------"
echo

# 1) Virtuelle Umgebung prüfen oder anlegen
if [ ! -d ".venv" ]; then
  echo "[Setup] Erstelle virtuelle Umgebung ..."
  python3 -m venv .venv
fi

# 2) Virtuelle Umgebung aktivieren
# shellcheck source=/dev/null
source .venv/bin/activate

# 3) Dependencies aktualisieren
echo "[Setup] Aktualisiere Pip und Packages ..."
python3 -m pip install --upgrade pip >/dev/null
python3 -m pip install -r requirements.txt >/dev/null

# 4) Browser automatisch öffnen (macOS oder Linux)
URL="http://127.0.0.1:5000"
echo "[Info] Öffne Dashboard im Browser ..."
if command -v open >/dev/null; then
  open "$URL"        # macOS
elif command -v xdg-open >/dev/null; then
  xdg-open "$URL"    # Linux
fi

# 5) Flask-App starten
echo "[Run] Starte Flask Server ..."
python3 app.py

# 6) Versionen anzeigen
echo
echo "[Info] Python-Pakete:"
python3 -c "import yaml, flask; print('  PyYAML', yaml.__version__, '| Flask', flask.__version__)"
echo "---------------------------------------"
