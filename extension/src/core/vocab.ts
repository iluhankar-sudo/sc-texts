/**
 * Словари для подсказки распознаванию: мат и сленг (русский и английский) + свои слова пользователя.
 *
 * Whisper обучен на субтитрах, где мат часто вырезан, а сленга мало, поэтому на песнях он
 * пропускает такие слова или подставляет похожие «словарные». Если слова есть в подсказке (prompt),
 * модель охотнее пишет их как есть.
 *
 * Ограничение: Whisper учитывает только последние ~224 токена подсказки (≈ 400 символов кириллицы),
 * поэтому ему достаётся короткая выборка самых частых слов, а DeepSeek получает словари целиком.
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

/** Сленг, который часто звучит в песнях (рэп, поп, клубная музыка). Сначала — самые частые. */
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
  /** Свои слова пользователя (имена, прозвища, редкий сленг) — через запятую или с новой строки. */
  custom?: string;
}

/** Свои слова пользователя: через запятую, точку с запятой или с новой строки. */
export function parseCustomWords(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/[,;\n]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && w.length <= 40)
    .slice(0, 100);
}

const BUDGET = 360; // символов на словарь: вместе с названием трека это укладывается в ~224 токена Whisper

/**
 * Словарная часть подсказки Whisper: свои слова (важнее всего), затем сленг и мат вперемешку
 * по частоте — сколько влезет в бюджет.
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

/** Чередует два списка: по два слова мата на одно слово сленга (мат Whisper теряет чаще). */
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

/** Полный словарь для DeepSeek (у него нет жёсткого ограничения на длину подсказки). */
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
 * Модель иногда «повторяет» подсказку на проигрыше: строка почти целиком из слов словаря через запятую.
 * Такую строку выбрасываем (в настоящей песне слова не идут списком через запятую).
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
