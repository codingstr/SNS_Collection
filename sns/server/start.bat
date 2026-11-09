@echo off
cd /d "%~dp0"

rem ---- settings ----
set "NGROK_URL=https://startle-convent-garland.ngrok-free.dev"
set "PORT=8080"
set "VENV=.venv-%COMPUTERNAME%"

if not exist "%VENV%\Scripts\python.exe" (
  echo This computer [%COMPUTERNAME%] is not set up yet. Run setup.bat first.
  pause
  exit /b 1
)

rem ---- ngrok in a separate window ----
where ngrok >nul 2>nul
if errorlevel 1 (
  echo ngrok not found. The server will run on localhost only.
) else (
  start "ngrok" ngrok http http://localhost:%PORT% --url %NGROK_URL%
  echo Public URL: %NGROK_URL%
)

rem ---- server in this window. Ctrl+C to stop ----
"%VENV%\Scripts\python.exe" main.py
pause
