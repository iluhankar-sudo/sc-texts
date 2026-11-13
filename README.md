# sc texts

A Chrome extension (Manifest V3) that shows lyrics for SoundCloud tracks. Paste a track link (or open a track) and the extension:

1. looks for ready-made lyrics in public databases (LRCLIB, Genius, NetEase, Kugou);
2. if there are none, or they have no line timings, transcribes the track's audio with Whisper and syncs the text to it;
3. shows the lyrics with karaoke-style line highlighting, translation, copying, pinning, manual editing and click-to-seek.

How the audio is obtained, and why: [docs/AUDIO_RESEARCH.md](docs/AUDIO_RESEARCH.md). In short, the extension records what the tab is already playing to the user (`chrome.tabCapture` or a tab-sharing prompt). It never downloads the stream or bypasses any protection.

## Install the ready-made extension

1. Open [Releases](../../releases/latest) and download `sc-texts.zip`.
2. Unpack it into a folder.
3. In Chrome open `chrome://extensions`, turn on **Developer mode** → **Load unpacked** → choose that folder.

No key is needed: recognition goes through the owner's proxy (see below). If you have your own Groq key, paste it in the extension settings (⋮ → API key) and requests will go directly to Groq.

## Features

- **Ready lyrics first.** Title and artist come from SoundCloud's oEmbed (with fallbacks to the page and the URL). All sources are queried in parallel with a short deadline and strict title/artist matching. Timed lyrics are shown immediately; untimed ones are synced to the audio by recognition.
- **Recognition from audio.** The track plays muted and sped up (Auto: up to ×3, ×2.5 with AudioShake) while short chunks are transcribed for a live preview. At the end the whole recording is transcribed in one request for full song context.
- **Accuracy helpers.** Vocabulary prompt (artist, title, custom words, profanity and slang), high-pass filter and normalization, language lock per track, hallucination filters, line starts tightened to the first sung word, capture-latency compensation.
- **Chorus cross-check.** Repeated multi-line sections are detected during recognition; each word of a repeat is replaced by the variant heard most often across repeats (ties are broken by model confidence).
- **Gemini checks the lyrics live.** Right after Whisper recognizes a window, Gemini (through the proxy) listens to the same audio and writes the lyrics down; its lines are aligned onto Whisper's word timings for that window and replace Whisper's on screen while the track plays. With Gemini there is no whole-track final pass, so the lyrics are ready as soon as the track ends.
- **AI correction as a fallback.** If Gemini is unavailable (no key, quota, blocked reply), misheard words are fixed by an LLM that sees both transcriptions, the title and the artist: free via Groq (`llama-3.3-70b-versatile`), or DeepSeek with your own key. Lines the model rewrote almost entirely are kept as recognized.
- **Karaoke.** Appears once lyrics are ready; whole lines light up in time with the track. Lyrics without timings get approximate timings.
- **Click a line to seek.** Jumps the SoundCloud player to that line (pointer cursor on hover).
- **Pin and edit.** Pinned or hand-edited lyrics are kept for the track and never re-recognized.
- **Translation.** Chrome's built-in translator (Chrome 138+) or Groq.
- **Short links.** `on.soundcloud.com/…` links are resolved to the full track URL.

## Auto build and proxy

On every push to `master`, GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)):

1. runs the proxy tests and, if the secrets are set, deploys the proxy to Cloudflare Workers (it keeps the Groq key server-side);
2. runs the extension tests, builds it **without a key** but with the proxy address, and publishes `sc-texts.zip` to Releases.

One-time setup, in Settings → Secrets and variables → Actions: `GROQ_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (optionally `GEMINI_KEY` and `APP_TOKEN`). Details: [proxy/README.md](proxy/README.md).

To build a personal copy with an embedded key: `cd extension && npm install && DEFAULT_API_KEY=gsk_... node build.mjs` (do not publish such a build).

## Layout

```
extension/
  public/                manifest.json, popup, options, offscreen document, page hook, locales
  src/background.ts      service worker: capture, link queue, lyrics lookup, messaging
  src/offscreen.ts       audio pipeline: resampling, chunking, WAV, transcription requests
  src/popup.ts           the popup UI
  src/content/           SoundCloud player integration, recognition controller, page capture
  src/core/              pure logic without chrome.*: clock, merging, filters, alignment, chorus, i18n
  src/lyrics.ts, providers.ts   LRCLIB / Genius / NetEase / Kugou lookups
  tests/                 unit tests (node --test)
  build.mjs              esbuild build → dist/
proxy/                   Cloudflare Worker that forwards requests to Groq
backend/                 optional local FastAPI + faster-whisper server (prototype)
docs/AUDIO_RESEARCH.md
```

## Development

Requires Node 22+ and Chrome 116+.

```bash
cd extension
npm install
npm run build        # output in extension/dist
npm test             # unit tests, no extra dependencies
```

Load `extension/dist` via **Load unpacked**. Reload already open SoundCloud tabs after updating.

Optional local recognition server (Python 3.10+):

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Environment variables: `WHISPER_MODEL` (default `small`), `WHISPER_DEVICE` (`auto`/`cpu`/`cuda`), `WHISPER_COMPUTE` (`int8`, `float16` on GPU).

## Limitations

- The track has to play through (sped up) to be recognized; nothing is downloaded.
- SoundCloud's player selectors (`extension/src/content/player.ts`, `SELECTORS`) are undocumented and may change.
- Song recognition is hard for every model; the best public systems still get 16–20% of words wrong on the Jam-ALT benchmark.
- Chrome allows only one recorder per tab: if the tab is being shared in Meet, Zoom, etc., the track is recognized in a separate tab.

## Privacy

See [PRIVACY.md](PRIVACY.md).
