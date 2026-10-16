@echo off
rem FollowUp Desk (Option B) - one-time setup. Double-click this file.
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% --version >nul 2>nul || (
  echo Python is not installed. Get it from https://www.python.org/downloads/windows/
  echo During install, tick "Add python.exe to PATH".
  pause & exit /b 1
)
echo Creating a private Python environment...
%PY% -m venv .venv || (echo Could not create the environment. & pause & exit /b 1)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt || (echo Install failed. Check your internet connection. & pause & exit /b 1)
echo.
echo Setup finished. FollowUp Desk uses your installed Google Chrome, so nothing else is needed.
echo Double-click run.bat to start.
pause
