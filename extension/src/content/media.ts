/**
 * Связь со скриптом в контексте страницы (public/page-hook.js): точное время воспроизведения
 * и скорость. События обрабатываются синхронно, поэтому ответ приходит сразу.
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

/** Точное состояние играющего медиа-элемента или null, если его не видно. */
export function readMedia(): MediaInfo | null {
  if (typeof window === 'undefined') return null;
  last = null;
  window.dispatchEvent(new CustomEvent('sctexts:query'));
  return last && Number.isFinite(last.time) ? last : null;
}

/** Пауза + перемотка в начало (prepare), запуск (play) или перемотка на позицию (seek). */
export function controlMedia(action: 'prepare' | 'play' | 'seek', speed?: number, time?: number) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('sctexts:control', { detail: JSON.stringify({ action, speed, time }) }));
}

/** Скорость воспроизведения (1–16). */
export function setMediaSpeed(rate: number) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('sctexts:speed', { detail: rate }));
}
