/**
 * Ready lyrics from LRCLIB (https://lrclib.net), an open lyrics database with line timings.
 * Pure logic only: LRC parsing, guessing "artist - track" from the SoundCloud
 * title and picking the best match.
 */
import type { CachedLine } from './cache.ts';

export interface LrcRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

/** "[01:02.34] line" → lines with start times; a line's end = the next line's start. */
export function parseLrc(lrc: string, duration?: number | null): CachedLine[] {
  const items: { start: number; text: string }[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) {
      const start = Number(m[1]) * 60 + Number(m[2]!.replace(':', '.'));
      if (Number.isFinite(start)) items.push({ start, text });
    }
  }
  items.sort((a, b) => a.start - b.start);
  const lines: CachedLine[] = [];
  items.forEach((it, i) => {
    if (!it.text) return; // empty lines in LRC are pauses
    const next = items[i + 1]?.start ?? (duration ?? it.start + 5);
    lines.push({ start: it.start, end: Math.max(it.start + 0.5, Math.min(next, it.start + 10)), text: it.text, words: [] });
  });
  return lines;
}

/** Lyrics without timings → lines (nominal times; highlighting is off for them). */
export function plainToLines(plain: string): CachedLine[] {
  return plain
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text, i) => ({ start: i, end: i + 1, text, words: [] }));
}

/**
 * Approximate timings for lyrics without timings (karaoke without recognition):
 * lines are spread over the track duration proportionally to length, with padding for the intro
 * and outro. Empty lines (verse boundaries) give a short pause.
 */
export function estimateTimings(texts: string[], duration: number): CachedLine[] {
  const lines = texts.map((t) => t.trim()).filter(Boolean);
  if (!lines.length || !(duration > 0)) return [];
  const pad = Math.min(15, Math.max(3, duration * 0.07));
  const from = pad;
  const to = Math.max(from + lines.length, duration - pad);
  const weight = (s: string) => 4 + s.length; // short lines still take noticeable time
  const total = lines.reduce((n, s) => n + weight(s), 0);
  const out: CachedLine[] = [];
  let cur = from;
  for (const text of lines) {
    const len = ((to - from) * weight(text)) / total;
    out.push({ start: cur, end: cur + len * 0.92, text, words: [] });
    cur += len;
  }
  return out;
}

export const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Cleans a SoundCloud track title of "(prod. ...)", "[Free DL]", "feat." and the like. */
export function cleanTitle(title: string): string {
  return title
    .replace(/[([][^)\]]*\b(prod|produced|feat|ft|official|video|audio|lyrics?|free|dl|download|premiere|out now|snippet)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+(feat\.?|ft\.?|prod\.?\s*by|prod\.)\s.+$/i, '')
    .replace(/[*~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Artist + track" variants for search: from "A - B" in the title and from the uploader name. */
export function guessArtistTrack(title: string, uploader: string | null): { artist: string; track: string }[] {
  const t = cleanTitle(title);
  const up = cleanTitle(uploader ?? '').replace(/\b(radio|records?|music|official|channel)\b/gi, '').trim();
  const out: { artist: string; track: string }[] = [];
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(t);
  if (m) out.push({ artist: m[1]!.trim(), track: m[2]!.trim() });
  if (up) out.push({ artist: up, track: m ? m[2]!.trim() : t });
  if (!m && !up) out.push({ artist: '', track: t });
  return out.filter((c, i, a) => c.track && a.findIndex((x) => x.artist === c.artist && x.track === c.track) === i);
}

/** Picks the best record: title and artist match, duration, presence of timings. */
export function pickBest(
  records: LrcRecord[],
  want: { artist: string; track: string; duration?: number | null },
): LrcRecord | null {
  const wt = norm(want.track);
  const wa = norm(want.artist);
  let best: LrcRecord | null = null;
  let bestScore = -Infinity;
  for (const r of records) {
    if (!r.instrumental && !r.syncedLyrics && !r.plainLyrics) continue;
    const rt = norm(r.trackName);
    const ra = norm(r.artistName);
    let score = 0;
    if (rt && rt === wt) score += 4;
    else if (rt && wt && (rt.includes(wt) || wt.includes(rt))) score += 2;
    else continue; // the title must match at least partially
    if (wa && ra) {
      if (ra === wa) score += 3;
      else if (ra.includes(wa) || wa.includes(ra)) score += 2;
      else score -= 2;
    }
    if (want.duration && r.duration) {
      const d = Math.abs(r.duration - want.duration);
      score += d <= 3 ? 3 : d <= 8 ? 1 : -4;
    }
    if (r.syncedLyrics) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 5 ? best : null;
}
