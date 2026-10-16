@echo off
rem Optional: builds dist\FollowUpDesk.exe so you can start it without the .bat files.
cd /d "%~dp0"
call .venv\Scripts\activate.bat || (echo Run install.bat first. & pause & exit /b 1)
python -m pip install pyinstaller
pyinstaller --noconfirm --onefile --windowed --name FollowUpDesk ^
  --add-data "..\extension\engine.js;." --collect-all playwright followup_desk.py
echo.
echo Done: desktop\dist\FollowUpDesk.exe
pause
