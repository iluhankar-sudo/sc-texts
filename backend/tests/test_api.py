"""API tests without loading the real model: recognition is replaced with a stub."""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402

client = TestClient(main.app)

FAKE = {
    "language": "ru",
    "language_probability": 0.99,
    "duration": 8.0,
    "segments": [{"start": 1.0, "end": 3.0, "text": "тест", "no_speech_prob": 0.0, "words": []}],
}


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_transcribe_ok(monkeypatch):
    seen = {}

    def fake(path, language, offset):
        seen["language"] = language
        seen["offset"] = offset
        return FAKE

    monkeypatch.setattr(main, "run_transcription", fake)
    r = client.post(
        "/transcribe",
        files={"file": ("chunk.wav", io.BytesIO(b"RIFFxxxx"), "audio/wav")},
        data={"language": "ru", "offset": "12.5"},
    )
    assert r.status_code == 200
    assert r.json()["segments"][0]["text"] == "тест"
    assert seen == {"language": "ru", "offset": 12.5}


def test_auto_language_becomes_none(monkeypatch):
    seen = {}
    monkeypatch.setattr(main, "run_transcription", lambda p, l, o: seen.setdefault("l", l) or FAKE)
    client.post(
        "/transcribe",
        files={"file": ("c.wav", io.BytesIO(b"x"), "audio/wav")},
        data={"language": "auto"},
    )
    assert seen["l"] is None


def test_rejects_bad_language():
    r = client.post(
        "/transcribe",
        files={"file": ("c.wav", io.BytesIO(b"x"), "audio/wav")},
        data={"language": "de"},
    )
    assert r.status_code == 400


def test_rejects_empty_file():
    r = client.post(
        "/transcribe",
        files={"file": ("c.wav", io.BytesIO(b""), "audio/wav")},
    )
    assert r.status_code == 400
