@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto :install_deps

if exist ".venv" (
    echo Replacing a virtual environment that is not usable on Windows...
    rmdir /s /q ".venv"
)

py -3.12 -c "import sys" >nul 2>&1
if not errorlevel 1 (
    py -3.12 -m venv .venv
    goto :install_deps
)
py -3.11 -c "import sys" >nul 2>&1
if not errorlevel 1 (
    py -3.11 -m venv .venv
    goto :install_deps
)
py -3.10 -c "import sys" >nul 2>&1
if not errorlevel 1 (
    py -3.10 -m venv .venv
    goto :install_deps
)
py -3.9 -c "import sys" >nul 2>&1
if not errorlevel 1 (
    py -3.9 -m venv .venv
    goto :install_deps
)
python -c "import sys" >nul 2>&1
if not errorlevel 1 (
    python -m venv .venv
    goto :install_deps
)

echo Could not create a virtual environment.
echo Install Python 3.10, 3.11, or 3.12 from https://www.python.org/downloads/
echo and tick "Add python.exe to PATH".
pause
exit /b 1

:install_deps
if not exist ".venv\Scripts\python.exe" (
    echo Virtual environment creation failed.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" -m pip install -U pip
if errorlevel 1 goto :fail
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :fail
echo.
echo Setup finished. Double-click "Start Drawing.bat" to run the app.
pause
exit /b 0

:fail
echo.
echo Dependency install failed. See the messages above.
pause
exit /b 1
