@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python не найден. Установите Python 3.10+ с https://www.python.org/downloads/
  echo При установке отметьте галочку "Add python.exe to PATH".
  pause
  exit /b 1
)
if not exist .venv (
  echo Первый запуск: создаю окружение и ставлю библиотеки, это займёт несколько минут...
  python -m venv .venv || goto :fail
)
call .venv\Scripts\activate.bat
python -m pip install -q -r requirements.txt || goto :fail
echo.
echo Бэкенд запускается на http://127.0.0.1:8000
echo При первом запуске скачивается модель Whisper (около 500 МБ). Окно не закрывайте.
echo.
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
pause
exit /b 0
:fail
echo Не удалось установить зависимости. Проверьте интернет и повторите.
pause
exit /b 1
