import type { Line, Word } from './types.ts';

/**
 * Индекс строки, которую показывать в момент t (секунды трека), либо -1.
 * Строка удерживается hold секунд после конца, чтобы не мигать между фразами.
 */
export function activeIndex(lines: Line[], t: number, hold = 1.5): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (lines[m]!.start <= t) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  if (ans < 0) return -1;
  return t < lines[ans]!.end + hold ? ans : -1;
}

/** Первая строка, которая начнётся после t. */
export function upcomingIndex(lines: Line[], t: number): number {
  for (let i = 0; i < lines.length; i++) if (lines[i]!.start > t) return i;
  return -1;
}

/** Индекс последнего слова, начавшегося к моменту t, либо -1. */
export function wordIndex(words: Word[], t: number): number {
  let ans = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.start <= t) ans = i;
    else break;
  }
  return ans;
}
