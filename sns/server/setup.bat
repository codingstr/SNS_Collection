@echo off
cd /d "%~dp0"

rem ---- find Python ----
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY goto nopython
%PY% --version >nul 2>nul || goto nopython

rem ---- virtual environment + packages ----
if not exist ".venv\Scripts\python.exe" (
  echo [1/2] Creating virtual environment...
  %PY% -m venv .venv || goto fail
)
echo [2/2] Installing packages...
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto fail
echo.
echo Setup complete. Run start.bat next.
pause
exit /b 0

:nopython
echo Python was not found.
echo Install Python 3.12 from https://www.python.org/downloads/
echo and check "Add python.exe to PATH" on the first install screen.
pause
exit /b 1

:fail
echo.
echo Setup failed. Copy the messages above and ask for help.
pause
exit /b 1
