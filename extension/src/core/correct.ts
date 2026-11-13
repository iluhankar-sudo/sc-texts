/**
 * Исправление распознанного текста языковой моделью (DeepSeek, OpenAI-совместимый API).
 * Модель не слышит звук: она получает строки Whisper вместе с названием и исполнителем,
 * исправляет неверно услышанные слова и помечает явный мусор. Порядок и число строк сохраняются,
 * поэтому сохраняются и тайминги строк (пословные — только у неизменённых строк).
 */
import { lineSim } from './chorus.ts';
import { normalizeText } from './filter.ts';
import type { Line } from './types.ts';

export interface CorrectionMeta {
  title: string | null;
  artist: string | null;
  /** Независимый второй вариант распознавания того же трека (может быть разбит на строки иначе). */
  alternative?: string | null;
  /** Словарь (мат, сленг, свои слова): если неверно услышанное слово похоже на слово отсюда — скорее всего, это оно. */
  glossary?: string[];
}

export function buildCorrectionMessages(lines: { text: string }[], meta: CorrectionMeta) {
  const system =
    'You fix speech-recognition errors in song lyrics transcribed by Whisper from a music track. ' +
    'The user sends json: {"title", "artist", "lines": [...]} — the recognized lines in order. ' +
    'For each line: fix misheard words, spelling, punctuation and capitalization so the line makes sense, ' +
    'keeping the language, slang, profanity and style as sung. ' +
    'Never censor: write swear words (Russian mat and English profanity) in full, and restore censored forms ' +
    '(asterisks like "б***" or "f**k", beeps, swear words softened into similar-sounding clean words) when the context makes the real word clear. ' +
    'Also mark as drop a line that only announces the song title or artist ("Song lyrics: …", "Title — Artist", the title alone ' +
    'once at the very start or end) — but keep it if the title is actually sung, e.g. as a repeated chorus line. ' +
    'Mark a line as drop only if it is clearly not part of the song ' +
    '(recognition garbage, words in an unrelated language, credits or subtitles text). ' +
    'Never add, merge, split or reorder lines, and never write lyrics that are not in the input. ' +
    'Reply only with json: {"lines": [{"text": "...", "drop": false}, ...]} with exactly one item per input line, in the same order.' +
    (meta.alternative
      ? ' The json may also contain "alternative": an independent second transcription of the same song by another pass ' +
        '(split into lines differently). Use it to fix misheard words: where the two disagree, choose the variant that fits the song better.'
      : '') +
    (meta.glossary?.length
      ? ' The json also contains "glossary": slang, swear words and names that are often sung in songs. If a recognized word looks like a ' +
        'mishearing of a glossary word and the glossary word fits the line, use the glossary word. Do not insert glossary words otherwise.'
      : '');
  const payload: Record<string, unknown> = { title: meta.title ?? '', artist: meta.artist ?? '', lines: lines.map((l) => l.text) };
  if (meta.alternative) payload.alternative = meta.alternative;
  if (meta.glossary?.length) payload.glossary = meta.glossary.join(', ');
  const user = JSON.stringify(payload);
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

interface CorrectionItem {
  text?: unknown;
  drop?: unknown;
}

/**
 * Применяет ответ модели. Возвращает null, если ответ не подходит (другое число строк и т.п.) —
 * тогда остаётся исходный текст.
 */
export function applyCorrection(lines: Line[], raw: string | null | undefined): Line[] | null {
  if (!raw) return null;
  let parsed: { lines?: CorrectionItem[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const items = parsed.lines;
  if (!Array.isArray(items) || items.length !== lines.length) return null;
  const out: Line[] = [];
  let dropped = 0;
  items.forEach((it, i) => {
    const src = lines[i]!;
    if (it?.drop === true) {
      dropped++;
      return;
    }
    let text = typeof it?.text === 'string' && it.text.trim() ? it.text.trim() : src.text;
    // Модель переписала строку почти целиком — это уже не исправление ослышки, оставляем распознанное.
    if (lineSim(text, src.text) < 0.4) text = src.text;
    // Строка не изменилась по сути — оставляем пословные тайминги для караоке.
    const same = normalizeText(text) === normalizeText(src.text);
    out.push({ ...src, text, words: same ? src.words : [] });
  });
  // Защита от «модель выкинула почти всё»: такой ответ не принимаем.
  if (lines.length >= 4 && dropped > lines.length * 0.6) return null;
  return out;
}
