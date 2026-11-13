/**
 * Chorus: repeated sections of a song.
 *
 * Recognition hears the chorus several times and may make different mistakes each time. Here we
 * find repeats (lines similar to each other, where a section of several consecutive lines repeats,
 * not a single random phrase), merge all variants into one by word voting weighted by
 * model confidence, and put the corrected text into every repeat, keeping their timings.
 */
import type { Line } from './types.ts';
import { levRatio, normName } from './providers.ts';

const toks = (text: string) => text.split(/\s+/).filter(Boolean);
const norm = (w: string) => normName(w);

function wordSim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length <= 2 || b.length <= 2) return 0;
  return levRatio(a, b);
}

/** Word alignment of two lines (Needleman-Wunsch): index pairs [i from a, j from b]. */
function alignWords(a: string[], b: string[]): [number, number][] {
  const R = a.length;
  const C = b.length;
  const W = C + 1;
  const sc = new Float32Array((R + 1) * W);
  const mv = new Uint8Array((R + 1) * W);
  for (let i = 1; i <= R; i++) (sc[i * W] = -i), (mv[i * W] = 2);
  for (let j = 1; j <= C; j++) (sc[j] = -j), (mv[j] = 3);
  for (let i = 1; i <= R; i++) {
    for (let j = 1; j <= C; j++) {
      const s = wordSim(a[i - 1]!, b[j - 1]!);
      const d = sc[(i - 1) * W + j - 1]! + (s >= 0.6 ? 1 + s : -1);
      const u = sc[(i - 1) * W + j]! - 1;
      const l = sc[i * W + j - 1]! - 1;
      const best = Math.max(d, u, l);
      sc[i * W + j] = best;
      mv[i * W + j] = best === d ? 1 : best === u ? 2 : 3;
    }
  }
  const pairs: [number, number][] = [];
  for (let i = R, j = C; i > 0 && j > 0; ) {
    const m = mv[i * W + j];
    if (m === 1) {
      pairs.push([i - 1, j - 1]);
      i--, j--;
    } else if (m === 2) i--;
    else j--;
  }
  return pairs.reverse();
}

/** Line similarity 0...1: share of words that found a similar pair. */
export function lineSim(a: string, b: string): number {
  const x = toks(a).map(norm).filter(Boolean);
  const y = toks(b).map(norm).filter(Boolean);
  if (!x.length || !y.length) return 0;
  const pairs = alignWords(x, y).filter(([i, j]) => wordSim(x[i]!, y[j]!) >= 0.6);
  return (2 * pairs.length) / (x.length + y.length);
}

export interface ChorusResult {
  lines: Line[];
  /** Groups of repeated lines (line indices). */
  groups: number[][];
  /** How many lines were fixed using other repeats. */
  fixed: number;
}

const SIM = 0.6;
const MIN_WORDS = 2;

/** Finds repeated lines and merges their variants into one text. */
export function reconcileChorus(input: Line[]): ChorusResult {
  // Always vote on the original recognition (raw), not on already corrected text:
  // otherwise a previous step's fix would count as an extra "vote".
  const lines: Line[] = input.map((l) => {
    const { raw, chorus: _c, ...rest } = l;
    return raw !== undefined && raw !== l.text ? { ...rest, text: raw } : rest;
  });
  const n = lines.length;
  const words = lines.map((l) => toks(l.text).length);
  // Similar line pairs.
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    if (words[i]! < MIN_WORDS) continue;
    for (let j = i + 1; j < n; j++) {
      if (words[j]! < MIN_WORDS) continue;
      const s = lineSim(lines[i]!.text, lines[j]!.text);
      sim[i]![j] = sim[j]![i] = s;
    }
  }
  // A repeat counts as a chorus only if the neighbouring line repeats too (a section of 2+ lines).
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const near = (i: number, j: number) => (i >= 0 && j >= 0 && i < n && j < n ? sim[i]![j]! >= SIM : false);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sim[i]![j]! < SIM) continue;
      if (j - i < 2) continue; // identical adjacent lines are not a repeated section
      if (!near(i - 1, j - 1) && !near(i + 1, j + 1)) continue;
      parent[find(j)] = find(i);
    }
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    byRoot.set(r, [...(byRoot.get(r) ?? []), i]);
  }
  const groups = [...byRoot.values()].filter((g) => g.length >= 2);

  const out = lines.slice();
  let fixed = 0;
  for (const g of groups) {
    const slots = vote(g.map((i) => lines[i]!));
    for (const i of g) {
      const src = lines[i]!;
      const next = applyVotes(src, slots);
      if (next) fixed++;
      out[i] = { ...(next ?? src), raw: src.text, chorus: true };
    }
  }
  return { lines: out, groups, fixed };
}

const avgProb = (l: Line) => (l.words.length ? l.words.reduce((a, w) => a + (w.prob ?? 1), 0) / l.words.length : 1);
/** A word's vote weight: the model's own confidence in it, or, if absent (Groq), the whole line's confidence. */
const weightOf = (l: Line, k: number) => {
  const p = l.words[k]?.prob;
  return p !== undefined && p < 1 ? p : (l.conf ?? 1);
};

interface Slots {
  base: string[];
  votes: Map<string, { raw: string; weight: number }>[];
}

/**
 * Word voting: the most "typical" variant of the line is the base (the one most similar to the
 * others), every repeat is aligned to it, and for each position we count which word was
 * heard more often (a vote weighs as much as the model's confidence in the word).
 */
function vote(variants: Line[]): Slots {
  let base = variants[0]!;
  let bestScore = -1;
  for (const v of variants) {
    const s = variants.reduce((a, o) => a + (o === v ? 0 : lineSim(v.text, o.text)), 0) + avgProb(v) * 0.01;
    if (s > bestScore) (bestScore = s), (base = v);
  }
  const bn = toks(base.text).map(norm);
  const votes = bn.map(() => new Map<string, { raw: string; weight: number }>());
  for (const v of variants) {
    const vw = toks(v.text);
    const vn = vw.map(norm);
    for (const [i, j] of alignWords(bn, vn)) {
      if (wordSim(bn[i]!, vn[j]!) < 0.5 || !vn[j]) continue;
      const cur = votes[i]!.get(vn[j]!) ?? { raw: vw[j]!, weight: 0 };
      cur.weight += weightOf(v, j);
      votes[i]!.set(vn[j]!, cur);
    }
  }
  return { base: bn, votes };
}

/**
 * Words of a repeat that only a minority voted for are replaced with the majority word.
 * On a tie (e.g. the chorus was heard twice with different variants) nothing changes:
 * we can't know which one is right. The word count doesn't change, so word timings stay the same.
 */
function applyVotes(l: Line, slots: Slots): Line | null {
  const ws = toks(l.text);
  const wn = ws.map(norm);
  let changed = false;
  for (const [i, j] of alignWords(slots.base, wn)) {
    const m = slots.votes[i]!;
    const own = m.get(wn[j]!)?.weight ?? 0;
    let best: { key: string; raw: string; weight: number } | null = null;
    for (const [key, c] of m) if (!best || c.weight > best.weight) best = { key, ...c };
    if (!best || best.key === wn[j] || best.weight <= own + 0.02) continue;
    ws[j] = keepPunct(ws[j]!, best.raw);
    changed = true;
  }
  if (!changed) return null;
  const text = ws.join(' ');
  const words = ws.length === l.words.length ? l.words.map((w, k) => ({ ...w, word: ws[k]! })) : l.words;
  return { ...l, text, words };
}

/** The new word with the original's first-letter case and surrounding punctuation. */
function keepPunct(orig: string, next: string): string {
  const core = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const pre = orig.match(/^[^\p{L}\p{N}]*/u)![0];
  const post = orig.match(/[^\p{L}\p{N}]*$/u)![0];
  let c = core(next) || core(orig);
  const o = core(orig);
  if (o && c) c = (o[0] === o[0]!.toUpperCase() ? c[0]!.toUpperCase() : c[0]!.toLowerCase()) + c.slice(1);
  return pre + c + post;
}
