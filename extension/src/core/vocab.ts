/**
 * Vocabularies for prompting recognition: profanity and slang (Russian and English) + the user's own words.
 *
 * Whisper was trained on subtitles where profanity is often cut and slang is rare, so on songs it
 * skips such words or substitutes similar "dictionary" ones. If the words are in the prompt,
 * the model is more willing to write them as they are.
 *
 * Limitation: Whisper only uses the last ~224 prompt tokens (≈ 400 Cyrillic characters),
 * so it gets a short selection of the most frequent words, while the AI correction gets the full vocabularies.
 */

export const PROFANITY_RU = [
  'блять', 'бля', 'сука', 'нахуй', 'хуй', 'хуйня', 'похуй', 'пиздец', 'пизда', 'нахуя',
  'ебать', 'ебал', 'ёбаный', 'заебал', 'уебан', 'ебёт', 'охуел', 'охуенно', 'мудак', 'говно',
  'хуёво', 'пиздато', 'въебал', 'шлюха', 'пидор', 'ебало', 'съебал', 'отъебись', 'долбоёб', 'пиздёж',
  'хуесос', 'ебанутый', 'наебал', 'распиздяй', 'сучка', 'блядь', 'залупа', 'дерьмо', 'жопа', 'срать',
];

export const PROFANITY_EN = [
  'fuck', 'fucking', 'fuckin', 'motherfucker', 'shit', 'bullshit', 'bitch', 'damn', 'goddamn',
  'ass', 'asshole', 'dick', 'pussy', 'hoe', 'cock', 'bastard', 'piss',
];

/** Slang often heard in songs (rap, pop, club music). Most frequent first. */
export const SLANG_RU = [
  'флекс', 'вайб', 'движ', 'хайп', 'кринж', 'бро', 'братан', 'тачка', 'хата', 'бабки',
  'лавэ', 'кэш', 'шмот', 'тусить', 'кайф', 'чилить', 'флоу', 'биф', 'фит', 'трэп',
  'краш', 'рофл', 'жиза', 'изи', 'рил', 'имба', 'зашквар', 'флексить', 'хейтер', 'тру',
  'дрип', 'свэг', 'бэнгер', 'панчлайн', 'дисс', 'кореш', 'кент', 'мутить', 'палево', 'спалился',
  'сорян', 'чел', 'челик', 'тян', 'лох', 'фейк', 'хайпануть', 'тусовка', 'туса', 'мусора',
  'менты', 'бит', 'трек', 'фристайл', 'лейбл', 'фанбаза', 'стафф', 'барыга', 'кидалово', 'гангста',
  'стрит', 'блок', 'район', 'бенз', 'гелик', 'мерин', 'бэха', 'айфон', 'ролекс', 'гуччи',
  'дорого-богато', 'капец', 'жесть', 'кринжово', 'вписка', 'отжигать', 'зажигать', 'залипать', 'на чиле', 'пушка',
];

export const SLANG_EN = [
  'drip', 'flex', 'ice', 'opps', 'cap', 'no cap', 'lit', 'finna', 'gonna', 'wanna',
  'gotta', "ain't", "y'all", 'lowkey', 'bruh', 'homie', 'dawg', 'shawty', 'bands', 'racks',
  'guap', 'whip', 'plug', 'trap', 'lean', 'molly', 'perc', 'glock', 'stick', 'opp',
  'bussin', 'deadass', 'slime', 'goat', 'sauce', 'vibe', 'hella', 'bae', 'savage', 'ballin',
  'bando', 'thot', 'drill', 'skrrt', 'woah', 'yeah', 'swag', 'bling', 'hustle', 'grind',
];

export interface VocabOptions {
  uncensored?: boolean;
  slang?: boolean;
  /** The user's own words (names, nicknames, rare slang) - comma- or newline-separated. */
  custom?: string;
}

/** The user's own words: separated by commas, semicolons or newlines. */
export function parseCustomWords(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/[,;\n]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && w.length <= 40)
    .slice(0, 100);
}

const BUDGET = 360; // characters for the vocabulary: together with the track title this fits into Whisper's ~224 tokens

/**
 * The vocabulary part of the Whisper prompt: custom words (most important), then slang and profanity mixed
 * by frequency - as much as fits the budget.
 */
export function vocabPrompt(lang: string, opts: VocabOptions, budget = BUDGET): string {
  const custom = parseCustomWords(opts.custom);
  const ru = lang !== 'en';
  const en = lang !== 'ru';
  const slang = opts.slang ? [...(ru ? SLANG_RU : []), ...(en ? SLANG_EN : [])] : [];
  const mat = opts.uncensored ? [...(ru ? PROFANITY_RU : []), ...(en ? PROFANITY_EN : [])] : [];
  const pool = [...custom, ...interleave(mat, slang)];
  const out: string[] = [];
  let len = 0;
  const seen = new Set<string>();
  for (const w of pool) {
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    if (len + w.length + 2 > budget) break;
    seen.add(k);
    out.push(w);
    len += w.length + 2;
  }
  return out.length ? `${out.join(', ')}.` : '';
}

/** Interleaves two lists: two profanity words per slang word (Whisper loses profanity more often). */
function interleave(a: string[], b: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length) out.push(a[i++]!);
    if (i < a.length) out.push(a[i++]!);
    if (j < b.length) out.push(b[j++]!);
  }
  return out;
}

/** Full vocabulary for the AI correction (it has no strict prompt length limit). */
export function glossaryFor(opts: VocabOptions): string[] {
  return [
    ...parseCustomWords(opts.custom),
    ...(opts.slang ? [...SLANG_RU, ...SLANG_EN] : []),
    ...(opts.uncensored ? [...PROFANITY_RU, ...PROFANITY_EN] : []),
  ];
}

const norm = (w: string) => w.toLowerCase().replace(/ё/g, 'е');
const VOCAB = new Set([...PROFANITY_RU, ...PROFANITY_EN, ...SLANG_RU, ...SLANG_EN].map(norm));

/**
 * The model sometimes "repeats" the prompt during an instrumental: a line made almost entirely of comma-separated vocabulary words.
 * Such a line is dropped (in a real song words don't come as a comma-separated list).
 */
export function isPromptEcho(text: string, custom: string[] = []): boolean {
  if (/без цензуры|uncensored/i.test(text)) return true;
  const words = norm(text).split(/[^a-zа-я']+/).filter(Boolean);
  if (words.length < 4) return false;
  const extra = new Set(custom.map(norm));
  const hits = words.filter((w) => VOCAB.has(w) || extra.has(w)).length;
  const commas = (text.match(/,/g) ?? []).length;
  return hits / words.length >= 0.7 && commas >= Math.min(3, words.length - 1);
}
