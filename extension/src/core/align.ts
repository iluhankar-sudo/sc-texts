/**
 * Syncing ready lyrics (without timings, e.g. from Genius) to the recognized audio.
 *
 * Words of the ready lyrics are matched to recognized words (which have timings) with global
 * Needleman-Wunsch alignment: word order is kept, similar words ("щас" / "сейчас",
 * Latin / Cyrillic) count as a match. Each line gets its time from its matched
 * words; lines without matches get it from their neighbours, proportionally to word count.
 */
import type { CachedLine } from './cache.ts';
import { levRatio, normName } from './providers.ts';

interface Tok {
  n: string;
  start: number;
  end: number;
}

function recTokens(lines: { start: number; end: number; text: string; words?: { word: string; start: number; end: number }[] }[]): Tok[] {
  const out: Tok[] = [];
  for (const l of lines) {
    if (l.words?.length) {
      for (const w of l.words) {
        const n = normName(w.word);
        if (n) out.push({ n, start: w.start, end: w.end });
      }
      continue;
    }
    // No word timings - split the line's time evenly.
    const ws = l.text.split(/\s+/).map(normName).filter(Boolean);
    const step = (l.end - l.start) / Math.max(1, ws.length);
    ws.forEach((n, i) => out.push({ n, start: l.start + i * step, end: l.start + (i + 1) * step }));
  }
  return out;
}

function sim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length <= 2 || b.length <= 2) return 0;
  return levRatio(a, b);
}

export interface AlignResult {
  lines: CachedLine[];
  /** Share of the ready lyrics' words that found a pair in the recognition. */
  matched: number;
}

/**
 * Returns the ready lyrics' lines with timings, or null if there are too few matches
 * (the recognition is of a different song or almost empty).
 */
export function alignLyrics(
  refLines: string[],
  recognized: { start: number; end: number; text: string; words?: { word: string; start: number; end: number }[] }[],
  minMatched = 0.35,
): AlignResult | null {
  const ref: { n: string; raw: string; line: number }[] = [];
  refLines.forEach((text, line) => {
    for (const raw of text.split(/\s+/).filter(Boolean)) {
      const n = normName(raw);
      if (n) ref.push({ n, raw, line });
    }
  });
  const rec = recTokens(recognized);
  if (!ref.length || !rec.length) return null;

  // Needleman-Wunsch: match +2 (exact +3), substitution -1, gap -1.
  const R = ref.length;
  const C = rec.length;
  const W = C + 1;
  const score = new Float32Array((R + 1) * W);
  const move = new Uint8Array((R + 1) * W); // 1 - diagonal, 2 - up (skip a lyrics word), 3 - left
  for (let i = 1; i <= R; i++) {
    score[i * W] = -i;
    move[i * W] = 2;
  }
  for (let j = 1; j <= C; j++) {
    score[j] = -j;
    move[j] = 3;
  }
  for (let i = 1; i <= R; i++) {
    const a = ref[i - 1]!.n;
    for (let j = 1; j <= C; j++) {
      const s = sim(a, rec[j - 1]!.n);
      const diag = score[(i - 1) * W + j - 1]! + (s === 1 ? 3 : s >= 0.7 ? 2 : -1);
      const up = score[(i - 1) * W + j]! - 1;
      const left = score[i * W + j - 1]! - 1;
      let best = diag;
      let m = 1;
      if (up > best) {
        best = up;
        m = 2;
      }
      if (left > best) {
        best = left;
        m = 3;
      }
      score[i * W + j] = best;
      move[i * W + j] = m;
    }
  }
  const pair = new Int32Array(R).fill(-1);
  for (let i = R, j = C; i > 0 || j > 0; ) {
    const m = move[i * W + j];
    if (m === 1) {
      if (sim(ref[i - 1]!.n, rec[j - 1]!.n) >= 0.7) pair[i - 1] = j - 1;
      i--;
      j--;
    } else if (m === 2) i--;
    else j--;
  }
  const matchedCount = pair.reduce((n, p) => n + (p >= 0 ? 1 : 0), 0);
  const matched = matchedCount / R;
  // Few matches (or only a handful of words matched) - most likely a different song.
  if (matched < minMatched || matchedCount < Math.min(4, R)) return null;

  // Line times from the matched words.
  const nLines = refLines.length;
  const t: ({ start: number; end: number } | null)[] = new Array(nLines).fill(null);
  ref.forEach((w, k) => {
    const p = pair[k]!;
    if (p < 0) return;
    const r = rec[p]!;
    const cur = t[w.line];
    t[w.line] = cur ? { start: Math.min(cur.start, r.start), end: Math.max(cur.end, r.end) } : { start: r.start, end: r.end };
  });
  // Line order matters more than single outliers: time must not go backwards.
  let last = 0;
  for (let i = 0; i < nLines; i++) {
    const x = t[i];
    if (!x) continue;
    if (x.start < last) x.start = last;
    if (x.end < x.start + 0.3) x.end = x.start + 0.3;
    last = x.start;
  }
  // Lines without matches - between their neighbours, proportionally to word count.
  const wordsIn = (i: number) => Math.max(1, refLines[i]!.split(/\s+/).filter(Boolean).length);
  for (let i = 0; i < nLines; i++) {
    if (t[i] || !refLines[i]!.trim()) continue;
    let j = i;
    while (j < nLines && !t[j]) j++;
    const from = i > 0 && t[i - 1] ? t[i - 1]!.end : Math.max(0, (t[j]?.start ?? 0) - 2 * (j - i));
    const to = j < nLines && t[j] ? t[j]!.start : from + 2.5 * (j - i);
    const total = Array.from({ length: j - i }, (_, k) => wordsIn(i + k)).reduce((a, b) => a + b, 0);
    let cur = from;
    for (let k = i; k < j; k++) {
      const len = ((to - from) * wordsIn(k)) / total;
      t[k] = { start: cur, end: cur + Math.max(0.3, len) };
      cur += len;
    }
    i = j - 1;
  }

  // Word timings for word-level highlighting: matched ones from the recognition, the rest evenly within the line.
  const lines: CachedLine[] = [];
  for (let i = 0; i < nLines; i++) {
    const x = t[i];
    const text = refLines[i]!.trim();
    if (!x || !text) continue;
    const ws = ref.map((w, k) => ({ w, k })).filter(({ w }) => w.line === i);
    const words = ws.map(({ w, k }, idx) => {
      const p = pair[k]!;
      if (p >= 0) return { word: w.raw, start: Math.max(x.start, rec[p]!.start), end: Math.min(x.end, rec[p]!.end), prob: 1 };
      const step = (x.end - x.start) / Math.max(1, ws.length);
      return { word: w.raw, start: x.start + idx * step, end: x.start + (idx + 1) * step, prob: 0.5 };
    });
    lines.push({ start: x.start, end: x.end, text, words });
  }
  return { lines, matched };
}
