#!/usr/bin/env bash
# Запуск бэкенда распознавания речи (Mac/Linux). Двойной клик или: bash start-backend.sh
set -e
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null; then
  echo "Python 3 не найден. Установите Python 3.10+ с https://www.python.org/downloads/"
  exit 1
fi
if [ ! -d .venv ]; then
  echo "Первый запуск: создаю окружение и ставлю библиотеки, это займёт несколько минут..."
  python3 -m venv .venv
fi
source .venv/bin/activate
python -m pip install -q -r requirements.txt
echo
echo "Бэкенд запускается на http://127.0.0.1:8000"
echo "При первом запуске скачивается модель Whisper (около 500 МБ). Окно не закрывайте."
echo
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
