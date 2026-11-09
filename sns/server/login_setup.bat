@echo off
cd /d "%~dp0"
set "VENV=.venv-%COMPUTERNAME%"
if not exist "%VENV%\Scripts\python.exe" (
  echo This computer [%COMPUTERNAME%] is not set up yet. Run setup.bat first.
  pause
  exit /b 1
)
rem Opens normal Chrome windows with this computer's collector profiles
rem (profiles\COMPUTERNAME\...) so you can log in to the test accounts.
rem Stop the server (start.bat) first.
"%VENV%\Scripts\python.exe" login_setup.py %*
pause
