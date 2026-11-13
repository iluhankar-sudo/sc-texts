import { isPromptEcho } from './vocab.ts';
import type { Line, RawSegment } from './types.ts';

/** Typical Whisper "hallucinations" on music/silence (credits, goodbyes). */
const JUNK: RegExp[] = [
  /субтитры/i,
  /продолжение следует/i,
  /редактор субтитров/i,
  /thanks for watching/i,
  /subtitles by/i,
  /amara\.org/i,
];

/** "Announcement" phrases: the model repeating the prompt or subtitles with the song title. */
const ANNOUNCE = /текст песни|слова песни|song lyrics|lyrics by|lyrics:|слова и музыка|музыка и слова|исполняет|performed by/i;

/**
 * The line mentions the title/artist rather than being sung lyrics.
 * strict = false: only reliable cases ("Lyrics of...", title together with artist, the artist's name alone).
 * strict = true: also a line equal to the title alone (removed only if it doesn't repeat - see dropTitleEcho).
 */
export function isTitleEcho(text: string, hint: { title?: string | null; artist?: string | null } | null, strict = false): boolean {
  if (ANNOUNCE.test(text)) return true;
  const n = normalizeText(text);
  if (!n) return false;
  const title = normalizeText(hint?.title ?? '');
  const artist = normalizeText(hint?.artist ?? '');
  if (artist && n === artist) return true;
  if (title && artist && n.includes(title) && n.includes(artist)) return true;
  if (strict && title && n === title) return true;
  return false;
}

/**
 * Removes mentions of the song title and artist from ready lyrics.
 * A line equal to the title alone is removed only if it occurs once:
 * a repeating one is most likely the real chorus.
 */
export function dropTitleEcho<T extends { text: string }>(lines: T[], hint: { title?: string | null; artist?: string | null } | null): T[] {
  const title = normalizeText(hint?.title ?? '');
  const titleOnly = title ? lines.filter((l) => normalizeText(l.text) === title).length : 0;
  return lines.filter((l) => {
    if (isTitleEcho(l.text, hint, false)) return false;
    if (title && normalizeText(l.text) === title && titleOnly <= 1) return false;
    return true;
  });
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Filtering Whisper "hallucinations" on music. Thresholds as in Whisper itself:
 * avg_logprob < -1 - the model is unsure; compression_ratio > 2.4 - looping;
 * high no_speech_prob with low confidence - silence/instrumental.
 */
export function isHallucination(s: RawSegment, text: string, maxNoSpeech = 0.6): boolean {
  const lp = s.avg_logprob;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (typeof lp === 'number') {
    if (lp < -1.0) return true;
    if (s.no_speech_prob > maxNoSpeech && lp < -0.5) return true;
    // One or two words with low confidence ("Here!", "The") are almost always made up during an instrumental.
    if (words <= 2 && lp < -0.55) return true;
  } else if (s.no_speech_prob > maxNoSpeech) {
    return true;
  }
  if (typeof s.compression_ratio === 'number' && s.compression_ratio > 2.4) return true;
  return false;
}

export function cleanSegments(segs: RawSegment[], maxNoSpeech = 0.6): Line[] {
  const out: Line[] = [];
  for (const s of segs) {
    const text = s.text.trim();
    if (!text) continue;
    if (s.end <= s.start) continue;
    if (isHallucination(s, text, maxNoSpeech)) continue;
    if (JUNK.some((r) => r.test(text))) continue;
    if (isPromptEcho(text)) continue; // the model repeated the vocabulary prompt
    const conf = typeof s.avg_logprob === 'number' ? Math.exp(s.avg_logprob) : undefined;
    out.push(tightenStart({ start: s.start, end: s.end, text, words: s.words ?? [], ...(conf !== undefined ? { conf } : {}) }));
  }
  return out;
}

/**
 * Whisper often starts a line at the beginning of a silence or instrumental: the first word gets a time
 * "from the end of the previous phrase" and stretches for seconds, so the line lights up before the voice.
 * An over-long first word is shortened to a plausible length, and the line starts with it.
 */
export function tightenStart(l: Line): Line {
  const words = l.words ?? [];
  const w0 = words[0];
  if (!w0) return l;
  const maxDur = Math.min(1.4, 0.3 + 0.09 * w0.word.length);
  let start = w0.start;
  if (w0.end - w0.start > maxDur) start = w0.end - maxDur;
  start = Math.max(l.start, start);
  if (start <= l.start + 0.05) return l;
  return { ...l, start, words: [{ ...w0, start }, ...words.slice(1)] };
}

/** Removes runs of more than maxRun identical consecutive lines (model looping). */
export function dropRepeatedRuns(lines: Line[], maxRun = 3): Line[] {
  const out: Line[] = [];
  let i = 0;
  while (i < lines.length) {
    const key = normalizeText(lines[i]!.text);
    let j = i + 1;
    while (j < lines.length && normalizeText(lines[j]!.text) === key) j++;
    if (j - i <= maxRun) out.push(...lines.slice(i, j));
    i = j;
  }
  return out;
}
