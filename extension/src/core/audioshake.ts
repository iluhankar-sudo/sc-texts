/**
 * Parsing AudioShake results (the alignment model): lines and words with timings.
 * The exact JSON schema is not documented, so parsing is "tolerant": we look in the reply for
 * arrays of objects with text and start/end times. Fallback: SRT (documented).
 */
import type { RawSegment, TranscribeResponse, Word } from './types.ts';

const TEXT_KEYS = ['text', 'word', 'line', 'lyrics', 'content', 'value'];
const START_KEYS = ['start', 'startTime', 'start_time', 'begin', 'from', 'startMs', 'start_ms'];
const END_KEYS = ['end', 'endTime', 'end_time', 'stop', 'to', 'endMs', 'end_ms'];
const CHILD_KEYS = ['words', 'tokens', 'syllables', 'items'];

interface Timed {
  text: string;
  start: number;
  end: number;
  children?: Timed[];
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (k in o) return o[k];
  return undefined;
}

/** "00:01:02.500" / "62.5" / 62500 (ms) → seconds. */
function toSec(v: unknown, msHint: boolean): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return msHint ? v / 1000 : v;
  if (typeof v === 'string') {
    const m = /^(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/.exec(v.trim());
    if (m) return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]!.replace(',', '.'));
    const n = Number(v);
    if (Number.isFinite(n)) return msHint ? n / 1000 : n;
  }
  return null;
}

function asTimed(o: unknown, msKeys: boolean): Timed | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const text = pick(r, TEXT_KEYS);
  const startKey = START_KEYS.find((k) => k in r);
  const endKey = END_KEYS.find((k) => k in r);
  if (!startKey) return null;
  const ms = msKeys || /ms$/i.test(startKey);
  const start = toSec(r[startKey], ms);
  const end = endKey ? toSec(r[endKey], ms) : null;
  if (start === null) return null;
  const childArr = pick(r, CHILD_KEYS);
  const children = Array.isArray(childArr) ? childArr.map((c) => asTimed(c, ms)).filter((c): c is Timed => !!c) : undefined;
  const t = typeof text === 'string' ? text.trim() : children?.map((c) => c.text).join(' ') ?? '';
  if (!t) return null;
  return { text: t, start, end: end ?? start, children: children?.length ? children : undefined };
}

/** Finds the "richest" array of timed objects (lines or words). */
function findTimedArrays(node: unknown, out: Timed[][], msKeys: boolean, depth = 0) {
  if (depth > 6 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    const items = node.map((x) => asTimed(x, msKeys)).filter((x): x is Timed => !!x);
    if (items.length >= 2 && items.length >= node.length * 0.6) out.push(items);
    node.forEach((x) => findTimedArrays(x, out, msKeys, depth + 1));
    return;
  }
  for (const v of Object.values(node as Record<string, unknown>)) findTimedArrays(v, out, msKeys, depth + 1);
}

/** Words without lines → lines split by pauses and sentence-ending punctuation. */
function groupWords(words: Word[]): RawSegment[] {
  const segs: RawSegment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    segs.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((w) => w.word).join(' '), no_speech_prob: 0, words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.7 || /[.!?…]$/.test(prev.word) || cur.length >= 10)) flush();
    cur.push(w);
  }
  flush();
  return segs;
}

export function fromAudioShakeJson(json: unknown, durationSec?: number): TranscribeResponse | null {
  // Times in milliseconds? If not marked explicitly, guess by magnitude.
  const probe: Timed[][] = [];
  findTimedArrays(json, probe, false);
  if (!probe.length) return null;
  const maxT = Math.max(...probe.flat().map((t) => t.end || t.start));
  const ms = durationSec ? maxT > durationSec * 5 : maxT > 3600;
  const arrays: Timed[][] = [];
  findTimedArrays(json, arrays, ms);
  if (!arrays.length) return null;
  // Lines are an array whose items contain words; otherwise the longest array (words or lines).
  const withChildren = arrays.find((a) => a.some((x) => x.children?.length));
  let segments: RawSegment[];
  if (withChildren) {
    segments = withChildren.map((l) => ({
      start: l.start,
      end: l.end > l.start ? l.end : (l.children?.[l.children.length - 1]?.end ?? l.start),
      text: l.text,
      no_speech_prob: 0,
      words: (l.children ?? []).map((w) => ({ word: w.text, start: w.start, end: w.end, prob: 1 })),
    }));
  } else {
    const best = arrays.reduce((a, b) => (b.length > a.length ? b : a));
    const avgWords = best.reduce((n, x) => n + x.text.split(/\s+/).length, 0) / best.length;
    segments =
      avgWords <= 1.5
        ? groupWords(best.map((w) => ({ word: w.text, start: w.start, end: w.end, prob: 1 })))
        : best.map((l) => ({ start: l.start, end: l.end, text: l.text, no_speech_prob: 0, words: [] }));
  }
  segments = segments.filter((s) => s.text && s.end >= s.start).sort((a, b) => a.start - b.start);
  if (!segments.length) return null;
  return { language: '', language_probability: 1, duration: segments[segments.length - 1]!.end, segments };
}

/** SRT → lines (line timings, no words). */
export function fromSrt(srt: string): TranscribeResponse | null {
  const segments: RawSegment[] = [];
  for (const block of srt.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti]!.split('-->').map((x) => x.trim());
    const start = toSec(a!.replace(',', '.'), false);
    const end = toSec(b!.split(' ')[0]!.replace(',', '.'), false);
    const text = lines.slice(ti + 1).join(' ').trim();
    if (start === null || end === null || !text) continue;
    segments.push({ start, end, text, no_speech_prob: 0, words: [] });
  }
  if (!segments.length) return null;
  return { language: '', language_probability: 1, duration: segments[segments.length - 1]!.end, segments };
}
