"""sc texts: optional local speech recognition backend (FastAPI + faster-whisper).

Accepts short audio fragments (WAV/MP3/WebM/OGG) and returns segments and words
with timestamps relative to the fragment start. Audio is not stored: the temporary file
is deleted right after recognition.
"""
from __future__ import annotations

import os
import tempfile
from functools import lru_cache
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "25")) * 1024 * 1024
SUPPORTED_LANGS = {"ru", "en"}

app = FastAPI(title="SoundCloud AI Lyrics backend", version="0.1.0")

# The extension calls from chrome-extension:// and https://soundcloud.com;
# the service listens on localhost only, so CORS is open.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@lru_cache(maxsize=1)
def get_model():
    from faster_whisper import WhisperModel

    return WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)


def run_transcription(path: str, language: Optional[str], offset: float) -> dict:
    model = get_model()
    segments_iter, info = model.transcribe(
        path,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        condition_on_previous_text=False,
        beam_size=5,
    )
    segments = []
    for seg in segments_iter:
        words = [
            {
                "word": w.word.strip(),
                "start": round(w.start + offset, 3),
                "end": round(w.end + offset, 3),
                "prob": round(float(w.probability), 3),
            }
            for w in (seg.words or [])
            if w.word.strip()
        ]
        text = seg.text.strip()
        if not text:
            continue
        segments.append(
            {
                "start": round(seg.start + offset, 3),
                "end": round(seg.end + offset, 3),
                "text": text,
                "no_speech_prob": round(float(seg.no_speech_prob), 3),
                "avg_logprob": round(float(seg.avg_logprob), 3),
                "compression_ratio": round(float(seg.compression_ratio), 3),
                "words": words,
            }
        )
    return {
        "language": info.language,
        "language_probability": round(float(info.language_probability), 3),
        "duration": round(float(info.duration), 3),
        "segments": segments,
    }


@app.on_event("startup")
def preload_model() -> None:
    """Load the model at startup so the first track does not wait for the download."""
    if os.environ.get("SKIP_MODEL_PRELOAD") == "1":
        return
    try:
        get_model()
        print(f"[ok] Whisper model '{MODEL_SIZE}' loaded, ready for tracks")
    except Exception as exc:  # noqa: BLE001
        print(f"[!] failed to load the model: {exc}")


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_SIZE}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    offset: float = Form(0.0),
):
    """Transcribe a fragment.

    language: "ru", "en" or empty (auto-detect).
    offset: shift in seconds added to all timestamps (the fragment's position in the track).
    """
    if language in ("", "auto"):
        language = None
    if language is not None and language not in SUPPORTED_LANGS:
        raise HTTPException(400, f"language must be one of {sorted(SUPPORTED_LANGS)} or empty")

    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "file too large")

    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(data)
        tmp.close()
        return run_transcription(tmp.name, language, offset)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"transcription failed: {exc}") from exc
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
