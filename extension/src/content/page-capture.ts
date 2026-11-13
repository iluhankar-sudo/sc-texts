/**
 * Recording the tab's audio with the user's permission (Chrome's "Share this tab?" prompt).
 *
 * The usual way (chrome.tabCapture) requires clicking the extension icon. This one uses a button on
 * the page itself: getDisplayMedia with preferCurrentTab shows a prompt with a single tab (this one) and an
 * "Allow" button. The track is muted for the user (suppressLocalAudioPlayback), and the audio
 * goes in chunks to the extension's offscreen document - the same recognition pipeline.
 */

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let port: chrome.runtime.Port | null = null;

export type PageCaptureError = 'denied' | 'noAudio' | 'failed';

/** Ask for permission and get the tab audio. Call only from a click handler. */
export async function requestTabAudio(): Promise<MediaStreamTrack | PageCaptureError> {
  let s: MediaStream;
  try {
    s = await navigator.mediaDevices.getDisplayMedia({
      video: true, // Chrome won't show the prompt without video; the video track is stopped right away
      audio: { suppressLocalAudioPlayback: true },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
    } as DisplayMediaStreamOptions);
  } catch (err) {
    console.warn('[sc texts] getDisplayMedia:', (err as Error)?.name, (err as Error)?.message);
    return (err as DOMException)?.name === 'NotAllowedError' ? 'denied' : 'failed';
  }
  for (const v of s.getVideoTracks()) v.stop();
  const audio = s.getAudioTracks()[0];
  if (!audio) {
    for (const tr of s.getTracks()) tr.stop();
    return 'noAudio'; // "Share tab audio" was unchecked in Chrome's prompt
  }
  stream = s;
  return audio;
}

/** Stream audio to the extension (after the background script has prepared recognition). */
export function startStreaming(audio: MediaStreamTrack, onEnded: () => void) {
  ctx = new AudioContext();
  void ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(new MediaStream([audio]));
  // ScriptProcessor, not AudioWorklet: a worklet module on someone else's page may be blocked by its security policy.
  const sp = ctx.createScriptProcessor(4096, 2, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(sp);
  sp.connect(mute);
  mute.connect(ctx.destination);
  port = chrome.runtime.connect({ name: 'sctexts-pcm' });
  port.onDisconnect.addListener(() => {
    port = null;
  });
  const sr = ctx.sampleRate;
  // The block's audio played before onaudioprocess fired: ScriptProcessor holds one more
  // buffer, plus the tab capture's own latency. Without a correction, at x2.5-3 speed lines
  // got later timings than real (at speed every millisecond of latency is ~3 ms of the track).
  const lagMs = (4096 / sr) * 1000 + (ctx.baseLatency || 0) * 1000 + CAPTURE_LAG_MS;
  sp.onaudioprocess = (e) => {
    if (!port) return;
    const a = e.inputBuffer.getChannelData(0);
    const b = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : a;
    const pcm = new Int16Array(a.length);
    for (let i = 0; i < a.length; i++) {
      const v = Math.max(-1, Math.min(1, (a[i]! + b[i]!) / 2));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    try {
      port.postMessage({ sr, w: Date.now() - lagMs, d: toBase64(pcm) });
    } catch {
      port = null;
    }
  };
  // The user pressed "Stop" on Chrome's "You are sharing this tab" bar.
  audio.addEventListener('ended', onEnded);
}

export function stopPageCapture() {
  for (const tr of stream?.getTracks() ?? []) tr.stop();
  stream = null;
  void ctx?.close().catch(() => {});
  ctx = null;
  try {
    port?.disconnect();
  } catch {
    /* already closed */
  }
  port = null;
}

export function pageCaptureActive() {
  return !!stream;
}

function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Latency of tab audio capture (getDisplayMedia) until it reaches the page, ms - an estimate. */
const CAPTURE_LAG_MS = 60;
