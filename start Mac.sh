#!/usr/bin/env bash

# Titel (ersetzt das Windows-"title")
echo "---------------------------------------"
echo "  Research Dashboard - Local Startup"
echo "---------------------------------------"
echo

# In Script-Verzeichnis wechseln (Äquivalent zu cd /d "%~dp0")
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# 1) Virtuelle Umgebung prüfen oder anlegen
if [ ! -f ".venv/bin/activate" ]; then
    echo "[Setup] Erstelle virtuelle Umgebung ..."
    PYTHON_BIN="$(command -v python3 || command -v python)"

    if [ -z "$PYTHON_BIN" ]; then
        echo "[Fehler] Python nicht gefunden."
        exit 1
    fi

    "$PYTHON_BIN" -m venv .venv
fi

# Aktivieren
source .venv/bin/activate

# 2) Dependencies aktualisieren
echo "[Setup] Aktualisiere Pip und Packages ..."
python -m pip install --upgrade pip > /dev/null
if [ -f "requirements.txt" ]; then
    python -m pip install -r requirements.txt > /dev/null
fi

# 3) Browser öffnen
echo "[Info] Öffne Dashboard im Browser ..."
open http://127.0.0.1:5000

# 4) Flask-App starten
echo "[Run] Starte Flask Server ..."
python app.py

# 5) Ausgabe der wichtigsten Versionen
echo
echo "[Info] Python-Pakete:"
python - <<EOF
import yaml, flask
print("  PyYAML", yaml.__version__, "| Flask", flask.__version__)
EOF

echo "---------------------------------------"

# Pause-Äquivalent (optional)
read -p "Drücke Enter zum Beenden..."