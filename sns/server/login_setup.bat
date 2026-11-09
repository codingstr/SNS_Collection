@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run setup.bat first.
  pause
  exit /b 1
)
rem Opens normal Chrome windows with the collector profiles so you can log in to the test accounts.
rem Stop the server (start.bat) first.
".venv\Scripts\python.exe" login_setup.py %*
pause
