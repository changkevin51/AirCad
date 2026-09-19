@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo Install the dependencies using README.md or double-click install.bat, then try again.
    pause
    exit /b 1
)
if not exist "web\dist\index.html" (
    echo The web UI is not built yet. Double-click install.bat, then try again.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" -u server.py %*
set "aircad_exit=%ERRORLEVEL%"
if not "%aircad_exit%"=="0" (
    echo.
    echo If Windows asked for camera access, click Allow and double-click this file again.
    echo Use --no-camera to sketch with the mouse only.
    pause
)
exit /b %aircad_exit%
