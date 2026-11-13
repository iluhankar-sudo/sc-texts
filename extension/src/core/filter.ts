import { isPromptEcho } from './vocab.ts';
import type { Line, RawSegment } from './types.ts';

/** Типичные «галлюцинации» Whisper на музыке/тишине (титры, прощания). */
const JUNK: RegExp[] = [
  /субтитры/i,
  /продолжение следует/i,
  /редактор субтитров/i,
  /thanks for watching/i,
  /subtitles by/i,
  /amara\.org/i,
];

/** Фразы-«объявления»: так модель повторяет подсказку или субтитры с названием песни. */
const ANNOUNCE = /текст песни|слова песни|song lyrics|lyrics by|lyrics:|слова и музыка|музыка и слова|исполняет|performed by/i;

/**
 * Строка — упоминание названия/исполнителя, а не спетый текст.
 * strict = false: только надёжные случаи («Текст песни…», название вместе с исполнителем, одно имя исполнителя).
 * strict = true: ещё и строка, равная одному названию (её убираем, только если она не повторяется — см. dropTitleEcho).
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
 * Убирает из готового текста упоминания названия песни и исполнителя.
 * Строку, равную одному названию, убираем, только если она встречается один раз:
 * повторяющаяся — скорее всего, настоящий припев.
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
 * Отсев «галлюцинаций» Whisper на музыке. Пороги — как в самом Whisper:
 * avg_logprob < −1 — модель не уверена; compression_ratio > 2.4 — зацикливание;
 * высокий no_speech_prob при низкой уверенности — тишина/проигрыш.
 */
export function isHallucination(s: RawSegment, text: string, maxNoSpeech = 0.6): boolean {
  const lp = s.avg_logprob;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (typeof lp === 'number') {
    if (lp < -1.0) return true;
    if (s.no_speech_prob > maxNoSpeech && lp < -0.5) return true;
    // Одно-два слова с невысокой уверенностью («Here!», «The») — почти всегда выдумка на проигрыше.
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
    if (isPromptEcho(text)) continue; // модель повторила подсказку со словарём
    const conf = typeof s.avg_logprob === 'number' ? Math.exp(s.avg_logprob) : undefined;
    out.push(tightenStart({ start: s.start, end: s.end, text, words: s.words ?? [], ...(conf !== undefined ? { conf } : {}) }));
  }
  return out;
}

/**
 * Whisper часто начинает строку с начала тишины или проигрыша: первое слово получает время
 * «от конца прошлой фразы» и тянется несколько секунд, а строка загорается до появления голоса.
 * Слишком длинное первое слово укорачиваем до правдоподобной длины, и строка начинается с него.
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

/** Удаляет серии из более чем maxRun одинаковых подряд строк (зацикливание модели). */
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
