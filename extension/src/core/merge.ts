import { normalizeText } from './filter.ts';
import type { Line, Range } from './types.ts';

export interface MergeOpts {
  /** Отступ от краёв окна, которому не доверяем (обычно overlap/2). */
  edge: number;
  /** Первое окно после перемотки/старта: левому краю доверяем. */
  first: boolean;
  /** Последнее окно (пауза/конец): правому краю доверяем. */
  last: boolean;
}

export function trustedRange(win: Range, o: MergeOpts): Range {
  return {
    start: o.first ? win.start : win.start + o.edge,
    end: o.last ? win.end + 0.001 : win.end - o.edge,
  };
}

const mid = (l: Line) => (l.start + l.end) / 2;

function similarity(a: string, b: string): number {
  const ta = new Set(normalizeText(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Убирает дубли одной и той же строки, распознанной двумя соседними окнами. */
export function dedupeAdjacent(lines: Line[]): Line[] {
  const out: Line[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev) {
      const overlap = Math.min(prev.end, l.end) - Math.max(prev.start, l.start);
      const minDur = Math.min(prev.end - prev.start, l.end - l.start);
      if (overlap > 0.5 * minDur && similarity(prev.text, l.text) >= 0.6) {
        if (l.text.length > prev.text.length) out[out.length - 1] = l;
        continue;
      }
    }
    out.push(l);
  }
  return out;
}

/**
 * Вливает результаты нового окна в накопленные строки.
 * Строки в абсолютном времени трека. Заменяется только «доверенная» середина окна:
 * соседние окна с перекрытием 2*edge тогда стыкуются без дыр и дублей.
 */
export function mergeChunk(
  existing: Line[],
  incoming: Line[],
  win: Range,
  o: MergeOpts,
): { lines: Line[]; trusted: Range } {
  const trusted = trustedRange(win, o);
  if (trusted.end <= trusted.start) return { lines: existing, trusted };
  const inTrusted = (l: Line) => mid(l) >= trusted.start && mid(l) < trusted.end;
  const kept = existing.filter((l) => !inTrusted(l));
  const added = incoming.filter(inTrusted);
  const merged = [...kept, ...added].sort((a, b) => a.start - b.start);
  return { lines: dedupeAdjacent(merged), trusted };
}
