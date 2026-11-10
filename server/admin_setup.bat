@echo off
cd /d "%~dp0"
set "VENV=.venv-%COMPUTERNAME%"
if not exist "%VENV%\Scripts\python.exe" (
  echo This computer [%COMPUTERNAME%] is not set up yet. Run setup.bat first.
  pause
  exit /b 1
)
rem Makes a web account an admin (shows the admin tab).
rem Usage: admin_setup.bat [id] [--password PW] [--revoke] [--list]
"%VENV%\Scripts\python.exe" admin_setup.py %*
pause
