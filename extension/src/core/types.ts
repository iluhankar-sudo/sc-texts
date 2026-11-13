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
  /** The model's confidence in the line, 0...1 (from the segment's avg_logprob). */
  conf?: number;
  /** A chorus line (repeats in the song). */
  chorus?: boolean;
  /** The original recognized text, if the line was corrected using other chorus repeats. */
  raw?: string;
}

export interface RawSegment {
  start: number;
  end: number;
  text: string;
  no_speech_prob: number;
  /** Mean model confidence (token log-probability); below -1 it's almost certainly made up. */
  avg_logprob?: number;
  /** Text compression ratio; above 2.4 the model is looping on a repeat. */
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
  /** Recognition model: whisper-large-v3, whisper-large-v3-turbo (Groq/OpenAI-compatible API) or scribe_v2 (ElevenLabs). */
  apiModel: string;
  /** ElevenLabs key (for scribe_v2). */
  elevenKey: string;
  /** AudioShake key: if set, AudioShake does the final pass (the alignment model). */
  audioshakeKey: string;
  /** OpenAI key (for whisper-1, i.e. Whisper large-v2). */
  openaiKey: string;
  /** DeepSeek key: if set, DeepSeek fixes the recognized lyrics (otherwise Groq does). */
  deepseekKey: string;
  /** DeepSeek model for corrections. */
  deepseekModel: string;
  /** Chat model for translation when Chrome's built-in translator is unavailable. */
  translateModel: string;
  serverUrl: string;
  language: Language;
  windowSec: number;
  overlapSec: number;
  syncOffsetMs: number;
  /** Track speed-up during link recognition: 0 - "Auto" (by duration), otherwise 1-8. */
  linkSpeed: number;
  /** Simple mode: the extension doesn't control the player (no speed-up, seeking or pausing). */
  simpleMode: boolean;
  /** Prompt the model with uncensored profanity. */
  uncensored: boolean;
  /** Prompt the model with common slang. */
  slang: boolean;
  /** Custom words for the prompt (comma-separated). */
  customWords: string;
}

/** Message from the offscreen document with the recognition result for one window. */
export interface ChunkResultMessage {
  type: 'CHUNK_RESULT';
  epoch: number;
  startWall: number;
  durationSec: number;
  first: boolean;
  last: boolean;
  /** Result of the final pass over a whole continuous piece of the track. */
  final?: boolean;
  /** Which engine recognized it (for the final pass). */
  engine?: 'whisper' | 'audioshake';
  response: TranscribeResponse;
}

export type CaptureState = 'idle' | 'listening' | 'transcribing' | 'lagging' | 'error';
