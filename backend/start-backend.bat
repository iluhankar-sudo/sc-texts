@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python not found. Install Python 3.10+ from https://www.python.org/downloads/
  echo During installation, check "Add python.exe to PATH".
  pause
  exit /b 1
)
if not exist .venv (
  echo First run: creating the environment and installing libraries, this takes a few minutes...
  python -m venv .venv || goto :fail
)
call .venv\Scripts\activate.bat
python -m pip install -q -r requirements.txt || goto :fail
echo.
echo Starting the backend at http://127.0.0.1:8000
echo The first run downloads the Whisper model (about 500 MB). Keep this window open.
echo.
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
pause
exit /b 0
:fail
echo Failed to install dependencies. Check your internet connection and try again.
pause
exit /b 1
