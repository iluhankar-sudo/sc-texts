import { vocabPrompt, type VocabOptions } from './vocab.ts';
import type { RawSegment, TranscribeResponse, Word } from './types.ts';

interface CloudWord {
  word?: string;
  start?: number;
  end?: number;
}
interface CloudSegment {
  start?: number;
  end?: number;
  text?: string;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
}
interface CloudResponse {
  language?: string;
  duration?: number;
  text?: string;
  segments?: CloudSegment[];
  words?: CloudWord[];
}

/** Converts an OpenAI-compatible API reply (verbose_json) into our backend's format. */
export function fromCloud(j: CloudResponse): TranscribeResponse {
  const words: Word[] = (j.words ?? [])
    .filter((w) => typeof w.word === 'string' && typeof w.start === 'number' && typeof w.end === 'number')
    .map((w) => ({ word: w.word!.trim(), start: w.start!, end: w.end!, prob: 1 }))
    .filter((w) => w.word);

  const segments: RawSegment[] = (j.segments ?? [])
    .filter((s) => typeof s.start === 'number' && typeof s.end === 'number')
    .map((s) => ({
      start: s.start!,
      end: s.end!,
      text: (s.text ?? '').trim(),
      no_speech_prob: s.no_speech_prob ?? 0,
      avg_logprob: s.avg_logprob,
      compression_ratio: s.compression_ratio,
      words: words.filter((w) => {
        const m = (w.start + w.end) / 2;
        return m >= s.start! - 0.05 && m < s.end! + 0.05;
      }),
    }));

  return {
    language: j.language ?? '',
    language_probability: 1,
    duration: j.duration ?? segments[segments.length - 1]?.end ?? 0,
    segments,
  };
}

interface ElevenWord {
  text?: string;
  start?: number;
  end?: number;
  type?: string;
  logprob?: number;
}
interface ElevenResponse {
  language_code?: string;
  language_probability?: number;
  words?: ElevenWord[];
}

/** ElevenLabs Scribe reply (words with timestamps) → line segments. */
export function fromElevenLabs(j: ElevenResponse): TranscribeResponse {
  const words: Word[] = (j.words ?? [])
    .filter((w) => w.type === 'word' && typeof w.start === 'number' && typeof w.end === 'number' && (w.text ?? '').trim())
    .map((w) => ({
      word: w.text!.trim(),
      start: w.start!,
      end: w.end!,
      prob: typeof w.logprob === 'number' ? Math.exp(w.logprob) : 1,
    }));
  const segments: RawSegment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    segments.push({
      start: cur[0]!.start,
      end: cur[cur.length - 1]!.end,
      text: cur.map((w) => w.word).join(' '),
      no_speech_prob: 0,
      words: cur,
    });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    // New line: a pause, end of a sentence or a line that's too long.
    if (prev && (w.start - prev.end > 0.7 || /[.!?…]$/.test(prev.word) || cur.length >= 10)) flush();
    cur.push(w);
  }
  flush();
  return {
    language: j.language_code ?? '',
    language_probability: j.language_probability ?? 1,
    duration: segments[segments.length - 1]?.end ?? 0,
    segments,
  };
}

/** Prompt for the model: the track title and artist help with names and slang. */
export function buildPrompt(
  hint: { title?: string | null; artist?: string | null } | null,
  lang: string,
  opts: VocabOptions = {},
): string {
  // The prompt used to be a sentence like "Lyrics of 'Title' - Artist." and Whisper sometimes
  // inserted it right into the lyrics. Now the artist and title are just words in a common
  // comma-separated list (if the model repeats such a list, the isPromptEcho filter drops it).
  const who = [hint?.artist?.trim(), hint?.title?.trim()].filter((x): x is string => !!x && x.length <= 80);
  const custom = [...who, opts.custom ?? ''].filter(Boolean).join(', ');
  return vocabPrompt(lang, { ...opts, custom });
}

const LANG_NAMES: Record<string, string> = { russian: 'ru', rus: 'ru', english: 'en', eng: 'en' };

/** «russian» / «rus» / «ru-RU» → «ru». */
export function normLang(l: string | null | undefined): string {
  const v = (l ?? '').trim().toLowerCase();
  return LANG_NAMES[v] ?? v.split(/[-_]/)[0] ?? '';
}

/** How confident the model is in the result (mean log-probability weighted by duration). */
export function confidence(r: TranscribeResponse): number {
  let sum = 0;
  let dur = 0;
  for (const s of r.segments) {
    if (typeof s.avg_logprob !== 'number') continue;
    const d = Math.max(0.1, s.end - s.start);
    sum += s.avg_logprob * d;
    dur += d;
  }
  if (dur > 0) return sum / dur;
  // No scores (ElevenLabs): rely on word probabilities.
  const probs = r.segments.flatMap((s) => s.words.map((w) => w.prob));
  return probs.length ? probs.reduce((a, b) => a + Math.log(Math.max(1e-6, b)), 0) / probs.length : -Infinity;
}

/** Of two variants (Russian and English), the one the model is more confident in. */
export function pickByConfidence(a: { lang: string; res: TranscribeResponse }, b: { lang: string; res: TranscribeResponse }) {
  return confidence(b.res) > confidence(a.res) ? b : a;
}
