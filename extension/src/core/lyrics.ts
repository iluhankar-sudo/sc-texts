/**
 * Готовые тексты из LRCLIB (https://lrclib.net) — открытой базы текстов с таймингами строк.
 * Здесь только чистая логика: разбор LRC, угадывание «исполнитель — трек» по названию
 * на SoundCloud и выбор лучшего совпадения.
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

/** "[01:02.34] строка" → строки с временем начала; конец строки = начало следующей. */
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
    if (!it.text) return; // пустые строки в LRC — паузы
    const next = items[i + 1]?.start ?? (duration ?? it.start + 5);
    lines.push({ start: it.start, end: Math.max(it.start + 0.5, Math.min(next, it.start + 10)), text: it.text, words: [] });
  });
  return lines;
}

/** Текст без таймингов → строки (время условное, подсветка для них отключается). */
export function plainToLines(plain: string): CachedLine[] {
  return plain
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text, i) => ({ start: i, end: i + 1, text, words: [] }));
}

export const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Чистит название трека SoundCloud от «(prod. …)», «[Free DL]», «feat.» и т.п. */
export function cleanTitle(title: string): string {
  return title
    .replace(/[([][^)\]]*\b(prod|produced|feat|ft|official|video|audio|lyrics?|free|dl|download|premiere|out now|snippet)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+(feat\.?|ft\.?|prod\.?\s*by|prod\.)\s.+$/i, '')
    .replace(/[*~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Варианты «исполнитель + трек» для поиска: из «A - B» в названии и из имени загрузившего. */
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

/** Выбирает лучшую запись: совпадение названия и исполнителя, длительность, наличие таймингов. */
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
    else continue; // название должно совпадать хотя бы частично
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
