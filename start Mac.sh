#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
clear
printf "\n  📰  readr wird gestartet …\n\n"

# 1) Virtuelle Umgebung (einmalig)
if [ ! -f ".venv/bin/activate" ]; then
  echo "     Richte Umgebung ein (einmalig, kann etwas dauern) …"
  PY="$(command -v python3 || command -v python)"
  if [ -z "$PY" ]; then echo "  ❌ Python nicht gefunden."; read -r -p "  Enter zum Beenden"; exit 1; fi
  "$PY" -m venv .venv
fi
source .venv/bin/activate

# 2) Abhängigkeiten (leise)
python -m pip install -q --upgrade pip >/dev/null 2>&1
python -m pip install -q -r requirements.txt >/dev/null 2>&1

# 3) Server im Hintergrund starten
echo "     Starte Server …"
python app.py >/dev/null 2>&1 &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null" EXIT

# 4) Warten bis der Port bereit ist (max ~30 s)
for _ in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/5000) 2>/dev/null; then exec 3>&-; break; fi
  sleep 0.5
done

# 5) Browser öffnen (readr zeigt dann selbst eine Lade-Animation)
printf "\n  ✅  readr läuft auf http://127.0.0.1:5000\n\n"
open http://127.0.0.1:5000 2>/dev/null
echo "  Dieses Fenster offen lassen – schließen (oder Strg+C) beendet readr."
wait $SERVER_PID
