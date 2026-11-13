"""Prototype: transcribe an audio file and print lines with timestamps.

Usage:
    python prototype_cli.py track.mp3 --language ru
    python prototype_cli.py track.mp3 --server http://127.0.0.1:8000   # via a running backend

Without --server the model runs locally (requires faster-whisper).
"""
from __future__ import annotations

import argparse
import json
import sys


def fmt(t: float) -> str:
    m, s = divmod(t, 60)
    return f"{int(m):02d}:{s:05.2f}"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("audio")
    p.add_argument("--language", default=None, help="ru, en or empty for auto-detect")
    p.add_argument("--server", default=None, help="backend URL, e.g. http://127.0.0.1:8000")
    p.add_argument("--json", action="store_true", help="print raw JSON")
    args = p.parse_args()

    if args.server:
        import httpx

        with open(args.audio, "rb") as f:
            r = httpx.post(
                args.server.rstrip("/") + "/transcribe",
                files={"file": (args.audio, f)},
                data={"language": args.language or ""},
                timeout=600,
            )
        r.raise_for_status()
        result = r.json()
    else:
        from app.main import run_transcription

        result = run_transcription(args.audio, args.language, 0.0)

    if args.json:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    print(f"language: {result['language']} ({result['language_probability']}), duration: {result['duration']} s")
    for seg in result["segments"]:
        print(f"[{fmt(seg['start'])} → {fmt(seg['end'])}] {seg['text']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
