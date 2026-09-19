@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo Install the dependencies using README.md or double-click install.bat, then try again.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" -u hand_tracker.py %*
set "drawing_exit=%ERRORLEVEL%"
if not "%drawing_exit%"=="0" (
    echo.
    echo If Windows asked for camera access, click Allow and double-click this file again.
    pause
)
exit /b %drawing_exit%
