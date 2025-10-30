@echo off
title Research Dashboard
cd /d "%~dp0"

echo ---------------------------------------
echo   Research Dashboard - Local Startup
echo ---------------------------------------
echo.

:: 1) Virtuelle Umgebung prüfen oder anlegen
if not exist ".venv\Scripts\activate" (
    echo [Setup] Erstelle virtuelle Umgebung ...
    py -m venv .venv
)
call .venv\Scripts\activate

:: 2) Dependencies aktualisieren
echo [Setup] Aktualisiere Pip und Packages ...
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt >nul

:: 3) Öffne Browser automatisch
echo [Info] Öffne Dashboard im Browser ...
start "" http://127.0.0.1:5000

:: 4) Starte Flask-App
echo [Run] Starte Flask Server ...
python app.py

:: 5) Ausgabe der wichtigsten Versionen
echo.
echo [Info] Python-Pakete:
py -c "import yaml, flask; print('  PyYAML', yaml.__version__, ' | Flask', flask.__version__)"
echo ---------------------------------------

pause
