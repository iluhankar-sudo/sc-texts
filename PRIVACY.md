# sc texts — Privacy Policy

_Last updated: November 13, 2026_

sc texts is a Chrome extension that shows lyrics for SoundCloud tracks. This policy explains what data the extension handles and where it goes.

## What the extension does NOT do

- It does not collect personal information (name, email, account data, browsing history).
- It does not use analytics, tracking, advertising or cookies of its own.
- It does not sell or transfer user data to third parties for any purpose other than the features described below.

## Data handled to provide the features

**Track information.** To find ready lyrics, the track's title, artist and duration are sent to public lyrics services: LRCLIB (lrclib.net), Genius (genius.com), NetEase Cloud Music (music.163.com) and Kugou (lyrics.kugou.com).

**Tab audio (only when the user starts recognition).** If no ready lyrics are found and the user clicks to start recognition, the audio of the SoundCloud tab is captured and sent in short chunks for speech-to-text transcription:
- by default — through the extension's own proxy (a Cloudflare Worker) to Groq (groq.com), which returns the recognized text;
- if the user enters their own API key in settings — directly to the chosen service (Groq, OpenAI, ElevenLabs or AudioShake).

Audio is used only to produce the lyrics and is not stored by the extension or its proxy. Capture stops when the user stops recognition or the track ends.

**Translation and text correction (optional).** When the user asks to translate lyrics (or to correct them with DeepSeek using their own key), the lyrics text is sent to Groq or DeepSeek to return the translation or correction.

**Local storage.** Settings, API keys entered by the user, and lyrics already found, recognized, pinned or edited are stored only in the browser (chrome.storage) on the user's device. They can be removed at any time by removing the extension.

## Third-party services

Requests to the services listed above are subject to their own privacy policies. The proxy runs on Cloudflare, which may keep standard technical request logs as described in Cloudflare's privacy policy.

## Contact

Questions about this policy: open an issue at https://github.com/iluhankar-sudo/sc-texts/issues

---

# sc texts — Политика конфиденциальности (кратко)

Расширение не собирает личные данные, не использует аналитику и рекламу. Название и исполнитель трека отправляются в базы текстов песен (LRCLIB, Genius, NetEase, Kugou). Звук вкладки — только после нажатия пользователем — отправляется на распознавание (через прокси расширения в Groq или напрямую в выбранный сервис, если указан свой ключ) и не сохраняется. Настройки и тексты хранятся только в браузере пользователя.
