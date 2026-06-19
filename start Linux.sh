#!/usr/bin/env bash
# ---------------------------------------
#  Research Dashboard - Local Startup
# ---------------------------------------

cd "$(dirname "$0")" || exit 1

echo "---------------------------------------"
echo "  Research Dashboard - Local Startup"
echo "---------------------------------------"
echo

# 0) Python prüfen
if ! command -v python3 >/dev/null 2>&1; then
  echo "[Error] python3 nicht gefunden. Bitte installieren."
  exit 1
fi

# 1) Virtuelle Umgebung prüfen oder anlegen
if [ ! -d ".venv" ]; then
  echo "[Setup] Erstelle virtuelle Umgebung ..."
  python3 -m venv .venv || {
    echo "[Error] venv konnte nicht erstellt werden (python3-venv installiert?)"
    exit 1
  }
fi

# 2) Aktivieren
# shellcheck source=/dev/null
source .venv/bin/activate

# 3) Dependencies nur einmal installieren
if [ ! -f ".venv/installed.flag" ]; then
  echo "[Setup] Installiere Dependencies ..."
  python3 -m pip install --upgrade pip
  python3 -m pip install -r requirements.txt
  touch .venv/installed.flag
fi

# 4) Browser öffnen
URL="http://127.0.0.1:5000"
echo "[Info] Öffne Dashboard im Browser ..."
if command -v open >/dev/null; then
  open "$URL"
elif command -v xdg-open >/dev/null; then
  xdg-open "$URL"
fi

# 5) Flask-App starten
echo "[Run] Starte Flask Server ..."
python3 app.py

# 6) Versionen anzeigen
echo
echo "[Info] Python-Pakete:"
python3 -c "import yaml, flask; print('  PyYAML', yaml.__version__, '| Flask', flask.__version__)"
echo "---------------------------------------"