/**
 * Manual editing of recognized lyrics: new lines get the old lines' timings.
 *
 * If the number of lines didn't change, each line keeps its time (a word or two were fixed).
 * Otherwise the new text is aligned to the old words (which have timings), and if there are few matches,
 * the lines are spread over the previous span proportionally to word count.
 */
import type { CachedLine } from './cache.ts';
import { alignLyrics } from './align.ts';

type Word = NonNullable<CachedLine['words']>[number];

function spreadWords(text: string, start: number, end: number, prob = 0.5): Word[] {
  const ws = text.split(/\s+/).filter(Boolean);
  const step = (end - start) / Math.max(1, ws.length);
  return ws.map((word, i) => ({ word, start: start + i * step, end: start + (i + 1) * step, prob }));
}

/** Editor text → lines (empty lines and surrounding spaces are removed). */
export function editorLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function retimeEdited(old: CachedLine[], texts: string[]): CachedLine[] {
  if (!texts.length) return [];
  if (!old.length) return texts.map((text, i) => ({ start: i * 3, end: i * 3 + 2.5, text, words: spreadWords(text, i * 3, i * 3 + 2.5) }));
  if (texts.length === old.length) {
    return texts.map((text, i) => {
      const o = old[i]!;
      if (text === o.text) return o;
      // Words that stayed in place keep their time; the rest are spread evenly within the line.
      const prev = o.words ?? [];
      const ws = text.split(/\s+/).filter(Boolean);
      const words =
        prev.length === ws.length ? ws.map((word, k) => ({ ...prev[k]!, word })) : spreadWords(text, o.start, o.end);
      return { start: o.start, end: o.end, text, words };
    });
  }
  const aligned = alignLyrics(texts, old, 0.25);
  if (aligned && aligned.lines.length === texts.length) return aligned.lines;
  // Proportionally over the previous span.
  const from = old[0]!.start;
  const to = old[old.length - 1]!.end;
  const weight = texts.map((t) => Math.max(1, t.split(/\s+/).length));
  const total = weight.reduce((a, b) => a + b, 0);
  let cur = from;
  return texts.map((text, i) => {
    const len = ((to - from) * weight[i]!) / total;
    const line = { start: cur, end: cur + Math.max(0.3, len * 0.92), text, words: spreadWords(text, cur, cur + Math.max(0.3, len * 0.92)) };
    cur += len;
    return line;
  });
}
