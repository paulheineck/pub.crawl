@echo off
title Pub.Crawl
cd /d "%~dp0"
cls
echo.
echo   🍺  Pub.Crawl wird gestartet ...
echo.

:: 1) Virtuelle Umgebung (einmalig)
if not exist ".venv\Scripts\activate" (
    echo      Richte Umgebung ein ^(einmalig, kann etwas dauern^) ...
    python -m venv .venv
)
call .venv\Scripts\activate

:: 2) Abhaengigkeiten (leise)
python -m pip install -q --upgrade pip >nul 2>&1
python -m pip install -q -r requirements.txt >nul 2>&1

:: 3) Server im Hintergrund starten
echo      Starte Server ...
start "" /b cmd /c "python app.py >nul 2>&1"

:: 4) Warten bis der Port bereit ist
:waitloop
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',5000);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 ( timeout /t 1 /nobreak >nul & goto waitloop )

:: 5) Browser oeffnen (Pub.Crawl zeigt dann selbst eine Lade-Animation)
echo.
echo   ✅  Pub.Crawl laeuft auf http://127.0.0.1:5000
start "" http://127.0.0.1:5000
echo.
echo   Dieses Fenster offen lassen - schliessen beendet Pub.Crawl.
pause >nul
