@echo off
cd /d "%~dp0"
rem Virtual environment is kept per computer (.venv-COMPUTERNAME) so the same folder
rem on an external SSD works on several computers.
set "VENV=.venv-%COMPUTERNAME%"
echo Computer: %COMPUTERNAME%

rem ---- find Python ----
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY goto nopython
%PY% --version >nul 2>nul || goto nopython

rem ---- one-time move from the old layout (.venv, profiles\youtube ...) ----
rem The old .venv only runs on the computer that created it, so that computer
rem takes over the old Chrome profiles as its own.
if not exist "%VENV%\Scripts\python.exe" if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import fastapi" >nul 2>nul && call :migrate
)

rem ---- recreate a broken virtual environment ----
if exist "%VENV%\Scripts\python.exe" (
  "%VENV%\Scripts\python.exe" -c "import sys" >nul 2>nul || (
    echo Existing virtual environment does not work on this computer. Recreating...
    rmdir /s /q "%VENV%"
  )
)

rem ---- virtual environment + packages ----
if not exist "%VENV%\Scripts\python.exe" (
  echo [1/2] Creating virtual environment %VENV% ...
  %PY% -m venv "%VENV%" || goto fail
)
echo [2/2] Installing packages...
"%VENV%\Scripts\python.exe" -m pip install --upgrade pip >nul
"%VENV%\Scripts\python.exe" -m pip install -r requirements.txt || goto fail
echo.
echo Setup complete for %COMPUTERNAME%. Run start.bat next.
echo If this computer has no test account logins yet, run login_setup.bat first.
pause
exit /b 0

:migrate
if exist "profiles\%COMPUTERNAME%" exit /b 0
set "MOVED="
for %%p in (youtube x instagram) do (
  if exist "profiles\%%p" (
    if not exist "profiles\%COMPUTERNAME%" mkdir "profiles\%COMPUTERNAME%"
    move "profiles\%%p" "profiles\%COMPUTERNAME%\%%p" >nul && set "MOVED=1"
  )
)
if defined MOVED echo Moved existing Chrome profiles to profiles\%COMPUTERNAME%
echo The old .venv folder is no longer used. You can delete it.
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
