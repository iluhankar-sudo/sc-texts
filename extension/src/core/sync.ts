import type { Line, Word } from './types.ts';

/**
 * Index of the line to show at moment t (track seconds), or -1.
 * A line is held for hold seconds after its end so it doesn't blink between phrases.
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

/** The first line that starts after t. */
export function upcomingIndex(lines: Line[], t: number): number {
  for (let i = 0; i < lines.length; i++) if (lines[i]!.start > t) return i;
  return -1;
}

/** Index of the last word started by moment t, or -1. */
export function wordIndex(words: Word[], t: number): number {
  let ans = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.start <= t) ans = i;
    else break;
  }
  return ans;
}
