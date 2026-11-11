export interface Word {
  word: string;
  start: number;
  end: number;
  prob: number;
}

export interface Line {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface RawSegment {
  start: number;
  end: number;
  text: string;
  no_speech_prob: number;
  /** Средняя уверенность модели (лог-вероятность токенов); ниже −1 — почти наверняка выдумка. */
  avg_logprob?: number;
  /** Степень сжатия текста; выше 2.4 — модель зациклилась на повторе. */
  compression_ratio?: number;
  words: Word[];
}

export interface TranscribeResponse {
  language: string;
  language_probability: number;
  duration: number;
  segments: RawSegment[];
}

export interface Range {
  start: number;
  end: number;
}

export type Language = 'auto' | 'ru' | 'en';

export type Mode = 'local' | 'cloud';

export interface Config {
  mode: Mode;
  apiUrl: string;
  apiKey: string;
  /** Модель распознавания: whisper-large-v3, whisper-large-v3-turbo (Groq/OpenAI-совместимый API) или scribe_v2 (ElevenLabs). */
  apiModel: string;
  /** Ключ ElevenLabs (для scribe_v2). */
  elevenKey: string;
  /** Ключ AudioShake: если задан, финальный проход делает AudioShake (модель alignment). */
  audioshakeKey: string;
  /** Ключ OpenAI (для whisper-1 — Whisper large-v2). */
  openaiKey: string;
  /** Ключ DeepSeek: если задан, распознанный текст исправляется языковой моделью. */
  deepseekKey: string;
  /** Модель DeepSeek для исправления. */
  deepseekModel: string;
  /** Чат-модель для перевода, если встроенного переводчика Chrome нет. */
  translateModel: string;
  serverUrl: string;
  language: Language;
  windowSec: number;
  overlapSec: number;
  syncOffsetMs: number;
  /** Ускорение трека при распознавании по ссылке: 0 — «Авто» (по длительности), иначе 1–8. */
  linkSpeed: number;
  /** Простой режим: расширение не управляет плеером (без ускорения, перемотки и пауз). */
  simpleMode: boolean;
  /** Подсказывать модели мат без цензуры. */
  uncensored: boolean;
  /** Подсказывать модели частый сленг. */
  slang: boolean;
  /** Свои слова для подсказки (через запятую). */
  customWords: string;
}

/** Сообщение от offscreen-документа с результатом распознавания одного окна. */
export interface ChunkResultMessage {
  type: 'CHUNK_RESULT';
  epoch: number;
  startWall: number;
  durationSec: number;
  first: boolean;
  last: boolean;
  /** Результат финального прохода по всему непрерывному куску трека. */
  final?: boolean;
  /** Кто распознал (для финального прохода). */
  engine?: 'whisper' | 'audioshake';
  response: TranscribeResponse;
}

export type CaptureState = 'idle' | 'listening' | 'transcribing' | 'lagging' | 'error';
