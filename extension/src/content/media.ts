/**
 * Link to the script in the page context (public/page-hook.js): exact playback time
 * and speed. Events are handled synchronously, so the reply comes immediately.
 */
export interface MediaInfo {
  time: number;
  paused: boolean;
  rate: number;
  duration: number;
}

let last: MediaInfo | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('sctexts:time', (e) => {
    const d = (e as CustomEvent<string>).detail;
    try {
      last = d ? (JSON.parse(d) as MediaInfo) : null;
    } catch {
      last = null;
    }
  });
}

/** Exact state of the playing media element, or null if it isn't visible. */
export function readMedia(): MediaInfo | null {
  if (typeof window === 'undefined') return null;
  last = null;
  window.dispatchEvent(new CustomEvent('sctexts:query'));
  return last && Number.isFinite(last.time) ? last : null;
}

/** Pause + seek to start (prepare), play (play) or seek to a position (seek). */
export function controlMedia(action: 'prepare' | 'play' | 'seek', speed?: number, time?: number) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('sctexts:control', { detail: JSON.stringify({ action, speed, time }) }));
}

/** Playback rate (1-16). */
export function setMediaSpeed(rate: number) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('sctexts:speed', { detail: rate }));
}
