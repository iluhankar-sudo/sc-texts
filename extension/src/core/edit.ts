/**
 * Ручная правка распознанного текста: новые строки получают тайминги старых.
 *
 * Если число строк не изменилось — каждая строка сохраняет своё время (исправили слово-другое).
 * Иначе новый текст выравнивается по словам старого (у них есть время), а если совпадений мало —
 * строки раскладываются по прежнему отрезку пропорционально числу слов.
 */
import type { CachedLine } from './cache.ts';
import { alignLyrics } from './align.ts';

type Word = NonNullable<CachedLine['words']>[number];

function spreadWords(text: string, start: number, end: number, prob = 0.5): Word[] {
  const ws = text.split(/\s+/).filter(Boolean);
  const step = (end - start) / Math.max(1, ws.length);
  return ws.map((word, i) => ({ word, start: start + i * step, end: start + (i + 1) * step, prob }));
}

/** Текст из поля редактора → строки (пустые и пробелы по краям убираются). */
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
      // Слова, оставшиеся на месте, сохраняют своё время; остальные — равномерно внутри строки.
      const prev = o.words ?? [];
      const ws = text.split(/\s+/).filter(Boolean);
      const words =
        prev.length === ws.length ? ws.map((word, k) => ({ ...prev[k]!, word })) : spreadWords(text, o.start, o.end);
      return { start: o.start, end: o.end, text, words };
    });
  }
  const aligned = alignLyrics(texts, old, 0.25);
  if (aligned && aligned.lines.length === texts.length) return aligned.lines;
  // Пропорционально по прежнему отрезку.
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
