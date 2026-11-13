#!/usr/bin/env bash
# Start the speech recognition backend (Mac/Linux). Double-click or: bash start-backend.sh
set -e
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null; then
  echo "Python 3 not found. Install Python 3.10+ from https://www.python.org/downloads/"
  exit 1
fi
if [ ! -d .venv ]; then
  echo "First run: creating the environment and installing libraries, this takes a few minutes..."
  python3 -m venv .venv
fi
source .venv/bin/activate
python -m pip install -q -r requirements.txt
echo
echo "Starting the backend at http://127.0.0.1:8000"
echo "The first run downloads the Whisper model (about 500 MB). Keep this window open."
echo
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
