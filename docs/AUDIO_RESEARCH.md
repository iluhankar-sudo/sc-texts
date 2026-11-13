# Getting audio from SoundCloud: research and decision

## Conclusion

The main capture method is **`chrome.tabCapture` + an offscreen document** (Manifest V3, Chrome 116+), with a fallback to a tab-sharing prompt (`getDisplayMedia` for the current tab). The extension records what the SoundCloud tab is already playing to the user. There are no requests to private stream URLs, no HLS segment decryption and no bypassing of content protection.

## Options considered

| Option | Works in MV3 | Pros | Cons | Decision |
|---|---|---|---|---|
| `chrome.tabCapture.getMediaStreamId` + offscreen document | Yes (Chrome 116+) | Clean tab audio, no window picker, stable | Needs a user gesture (icon click), real-time capture | **Chosen** |
| `getDisplayMedia({audio:true})` for the current tab | Yes | No special permission | A sharing prompt every time | Fallback |
| `HTMLMediaElement.captureStream()` | Partly | No prompt | SoundCloud uses MSE/HLS; the element may be unavailable or silent; depends on markup | Not used |
| Downloading the stream via internal API/HLS | Technically yes | Faster than real time | Violates SoundCloud's terms (no copying content, no bypassing protection) | **Rejected** |
| Official SoundCloud API | Yes | Legal for streaming | API terms forbid capturing and copying user content | Not suitable for audio |

## Platform limits

- `tabCapture` requires an explicit user action (clicking the extension icon or a keyboard shortcut). It cannot start automatically when a track opens.
- Capture runs at playback speed. The extension plays the track sped up (with the captured audio resampled back) to shorten the wait, but recognition can never be instant.
- A captured stream mutes the tab by default, so the offscreen document must route it back to `AudioContext.destination` when sound is wanted.
- The MV3 service worker goes to sleep, so capture lives in the offscreen document and state is kept outside the service worker.
- Chrome closes an offscreen document without a valid reason, so `USER_MEDIA` must be set in `reasons`.

## Legal and ethical notes

- The extension does not extract or store files; it transcribes audio the user is listening to. This is not DRM circumvention.
- SoundCloud's terms forbid copying content and bypassing protection. Capturing tab audio is a grey area of the terms of use, so the project is intended for personal use.
- Audio chunks are sent only for speech recognition and are not stored.
- If the track's author restricted use, the extension must not work around it. The feature is not enabled for hidden/private tracks.

## What this means for the architecture

1. The service worker receives the click, requests a `streamId` and creates the offscreen document.
2. The offscreen document opens `getUserMedia` with `chromeMediaSource: "tab"` and cuts the stream into overlapping chunks.
3. Chunks are sent for recognition; Whisper returns segments with timestamps.
4. The content script maps segments to the SoundCloud player's position and builds the lyrics.
5. On seek or track change, the buffer is reset and chunks are re-anchored to the new position.

## Sources

- Chrome for Developers, Audio recording and screen capture: https://developer.chrome.com/docs/extensions/mv3/screen_capture
- SoundCloud Terms of Use: https://soundcloud.com/terms-of-use
- SoundCloud API Terms of Use: https://developers.soundcloud.com/docs/api/terms-of-use
