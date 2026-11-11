/**
 * Разбор ответов дополнительных источников готовых текстов: Genius (текст без таймингов),
 * NetEase и Kugou (тексты LRC с таймингами строк). Только чистая логика — сеть в src/providers.ts.
 *
 * Извлечение текста со страницы Genius адаптировано из Riff (github.com/rootscripts/riff, MIT).
 */

/** Нормализация для сравнения: нижний регистр, ё→е, кириллица → латиница, без знаков и «feat …». */
export function normName(s: string | null | undefined): string {
  return translit(
    (s ?? '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[([][^)\]]*[)\]]/g, ' ')
      .replace(/\b(feat|ft|prod|with)\b\.?.*$/i, ' '),
  )
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

const TR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
function translit(s: string): string {
  return s.replace(/[а-я]/g, (c) => TR[c] ?? c);
}

/** Похожи ли две строки (одна содержит другую или почти совпадают). */
function similar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return true;
  return levRatio(a, b) >= 0.8;
}

export function levRatio(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

/**
 * Строгая сверка кандидата: название должно совпасть, исполнитель — тоже (или совпасть длительность).
 * Неправильный текст хуже никакого, поэтому сомнительные варианты отбрасываются.
 */
export function strictMatch(
  want: { title: string; artist: string | null; duration?: number | null },
  cand: { title?: string | null; artist?: string | null; duration?: number | null },
): number {
  const wt = normName(want.title);
  const ct = normName(cand.title);
  if (!similar(wt, ct)) return 0;
  let score = wt === ct ? 3 : 2;
  const wa = normName(want.artist);
  const ca = normName(cand.artist);
  const artistOk = !!wa && !!ca && (similar(wa, ca) || ca.includes(wa) || wa.includes(ca));
  const durOk = !!want.duration && !!cand.duration && Math.abs(want.duration - cand.duration) <= 4;
  if (artistOk) score += 2;
  if (durOk) score += 1;
  if (!artistOk && !durOk) return 0;
  return score;
}

// ---------------- Genius ----------------

export interface GeniusHit {
  url: string;
  title: string;
  artist: string;
}

/** Песни из ответа genius.com/api/search/multi (или /search/song). */
export function geniusHits(json: unknown): GeniusHit[] {
  const out: GeniusHit[] = [];
  const sections = (json as { response?: { sections?: { hits?: unknown[] }[]; hits?: unknown[] } })?.response;
  const lists = [...(sections?.sections ?? []).map((s) => s?.hits ?? []), sections?.hits ?? []];
  for (const hits of lists) {
    for (const h of hits as { type?: string; result?: { url?: string; title?: string; artist_names?: string; primary_artist?: { name?: string } } }[]) {
      const r = h?.result;
      if (!r?.url || !/-lyrics$/.test(r.url)) continue;
      if (out.some((x) => x.url === r.url)) continue;
      out.push({ url: r.url, title: r.title ?? '', artist: r.artist_names ?? r.primary_artist?.name ?? '' });
    }
  }
  return out;
}

/** Текст песни из HTML страницы Genius (блоки data-lyrics-container). */
export function extractGeniusLyrics(html: string): string {
  let lyrics = '';
  const marker = 'data-lyrics-container="true"';
  let pos = 0;
  for (;;) {
    const idx = html.indexOf(marker, pos);
    if (idx === -1) break;
    const contentStart = html.indexOf('>', idx) + 1;
    let depth = 1;
    let cur = contentStart;
    while (depth > 0 && cur < html.length) {
      const nextOpen = html.indexOf('<div', cur);
      const nextClose = html.indexOf('</div>', cur);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        cur = nextOpen + 4;
      } else {
        depth--;
        if (depth === 0) {
          lyrics += (lyrics ? '\n' : '') + html.substring(contentStart, nextClose);
          pos = nextClose + 6;
          break;
        }
        cur = nextClose + 6;
      }
    }
    if (depth > 0) break;
  }
  lyrics = lyrics.replace(/<div[^>]*data-exclude-from-selection="true"[^>]*>[\s\S]*?<\/div>/gi, '');
  let text = lyrics
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  // [Куплет 1], [Припев: …] — разметка Genius, не текст.
  text = text.replace(/\[[^\]]*\]/g, '').replace(/\n{3,}/g, '\n\n');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !/^\d*\s*Contributors/i.test(l) && !/(?:Lyrics|Текст песни)\s*$/i.test(l) && !/^You might also like$/i.test(l) && !/^\d*\s*Embed$/i.test(l));
  let clean = lines.join('\n').trim();
  const split = clean.split('\n');
  if (split.length >= 8) {
    const half = Math.floor(split.length / 2);
    if (split.slice(0, half).join('\n').trim() === split.slice(half).join('\n').trim()) clean = split.slice(0, half).join('\n').trim();
  }
  return clean;
}

// ---------------- NetEase ----------------

export interface NeteaseSong {
  id: number;
  name: string;
  artist: string;
  duration: number | null;
}

export function neteaseSongs(json: unknown): NeteaseSong[] {
  const songs = (json as { result?: { songs?: unknown[] } })?.result?.songs ?? [];
  return (songs as { id?: number; name?: string; artists?: { name?: string }[]; ar?: { name?: string }[]; duration?: number; dt?: number }[])
    .filter((s) => s?.id && s.name)
    .map((s) => ({
      id: s.id!,
      name: s.name!,
      artist: (s.artists ?? s.ar ?? []).map((a) => a.name ?? '').join(' '),
      duration: s.duration || s.dt ? Math.round((s.duration || s.dt)! / 1000) : null,
    }));
}

/** LRC из ответа /api/song/lyric (пусто, если текста нет или это «纯音乐» — инструментал). */
export function neteaseLrc(json: unknown): string {
  const j = json as { lrc?: { lyric?: string }; nolyric?: boolean; uncollected?: boolean };
  if (j?.nolyric || j?.uncollected) return '';
  return stripLrcMeta(j?.lrc?.lyric ?? '');
}

// ---------------- Kugou ----------------

export interface KugouCandidate {
  id: string;
  accesskey: string;
  song: string;
  singer: string;
  duration: number | null;
}

export function kugouCandidates(json: unknown): KugouCandidate[] {
  const c = (json as { candidates?: unknown[] })?.candidates ?? [];
  return (c as { id?: string | number; accesskey?: string; song?: string; songname?: string; singer?: string; singername?: string; filename?: string; duration?: number }[])
    .filter((x) => x?.id && x.accesskey)
    .map((x) => {
      const [fa, ft] = (x.filename ?? '').split(/\s+-\s+/);
      return {
        id: String(x.id),
        accesskey: x.accesskey!,
        song: x.song ?? x.songname ?? ft ?? '',
        singer: x.singer ?? x.singername ?? fa ?? '',
        duration: x.duration ? Math.round(x.duration / 1000) : null,
      };
    });
}

/** Ответ /download: LRC в base64 (UTF-8). */
export function kugouLrc(json: unknown): string {
  const b64 = (json as { content?: string })?.content;
  if (!b64) return '';
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return stripLrcMeta(new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, ''));
  } catch {
    return '';
  }
}

/** Убирает служебные теги LRC ([ti:], [ar:], [by:] …) и строки «作词/作曲» (автор слов/музыки). */
export function stripLrcMeta(lrc: string): string {
  return lrc
    .split(/\r?\n/)
    .filter((l) => !/^\[(id|ti|ar|al|by|hash|sign|qq|total|offset|kana|language):[^\]]*\]\s*$/i.test(l.trim()))
    .filter((l) => !/^\[[\d:.]+\]\s*(作词|作曲|编曲|制作人|词|曲|Lyrics by|Composed by|Producer)\s*[:：]/i.test(l.trim()))
    .join('\n')
    .trim();
}

/** В LRC действительно есть тайминги (а не «[00:00.00] весь текст одной строкой»). */
export function hasTimings(lrc: string): boolean {
  const stamps = lrc.match(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g) ?? [];
  return new Set(stamps).size >= 3;
}
