/**
 * Gemini listens to the whole recorded track and writes down the lyrics.
 *
 * Unlike the text-only correction (Groq/DeepSeek), Gemini hears the audio itself, so it can catch words
 * Whisper misheard under the beat. Gemini's timestamps are not reliable, so only its text is used:
 * the lines are aligned onto Whisper's word timings (see align.ts), and karaoke/seek keep working.
 * Pure logic only: request building and reply parsing. Networking is in offscreen.ts.
 */

export interface GeminiMeta {
  title: string | null;
  artist: string | null;
  /** 'ru' | 'en' | null (unknown). */
  language: string | null;
  /** Whisper's transcription, as a hint for names and hard-to-hear words. */
  draft: string | null;
  /** Slang, profanity and custom words that are often sung. */
  glossary: string[];
  /** A short fragment of the song (live checking during playback), not the whole track. */
  fragment?: boolean;
}

const SYSTEM =
  'You transcribe song lyrics from audio. Write down exactly the words that are sung in this recording, ' +
  'in the language they are sung in (do not translate), one line per sung phrase, the way lyrics sites format songs. ' +
  'Repeat choruses and ad-libs every time they are sung. Keep slang and profanity uncensored and spelled in full. ' +
  'Do not add section labels ([Chorus], [Verse]), the title, credits, descriptions of the music or anything that is not sung. ' +
  'If a part is purely instrumental, write nothing for it. If nothing is sung at all, return an empty list.';

/** Request body for models/{model}:generateContent (REST, v1beta). */
export function buildGeminiRequest(wavBase64: string, meta: GeminiMeta) {
  const ctx: string[] = [];
  if (meta.fragment) ctx.push('This is a short fragment of the song: it may start or end in the middle of a phrase. Write those partial phrases too.');
  if (meta.title) ctx.push(`Track title: ${meta.title}`);
  if (meta.artist) ctx.push(`Artist: ${meta.artist}`);
  if (meta.language === 'ru') ctx.push('Language: Russian (may contain English words).');
  else if (meta.language === 'en') ctx.push('Language: English.');
  if (meta.glossary.length) ctx.push(`Words often heard in songs (use only if actually sung): ${meta.glossary.join(', ')}`);
  if (meta.draft) {
    ctx.push(
      'A speech recognizer produced this rough draft; it contains mistakes and may miss lines. ' +
        'Use it only as a hint for names and hard-to-hear words, trust the audio:\n' +
        meta.draft.slice(0, 6000),
    );
  }
  ctx.push('Reply with JSON: {"lines": ["first sung line", "second sung line", ...]}.');
  const off = (category: string) => ({ category, threshold: 'BLOCK_NONE' });
  return {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [
      {
        role: 'user',
        parts: [{ inline_data: { mime_type: 'audio/wav', data: wavBase64 } }, { text: ctx.join('\n\n') }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { lines: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['lines'] },
    },
    // Lyrics often contain profanity and violent or sexual words - they must not be blocked.
    safetySettings: [
      off('HARM_CATEGORY_HARASSMENT'),
      off('HARM_CATEGORY_HATE_SPEECH'),
      off('HARM_CATEGORY_SEXUALLY_EXPLICIT'),
      off('HARM_CATEGORY_DANGEROUS_CONTENT'),
    ],
  };
}

export type GeminiParse = { ok: true; lines: string[] } | { ok: false; error: string };

/** Lyrics lines from a generateContent reply (or the reason there are none). */
export function parseGeminiLyrics(json: unknown): GeminiParse {
  const j = json as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    error?: { message?: string };
  };
  if (j?.error?.message) return { ok: false, error: j.error.message.slice(0, 160) };
  if (j?.promptFeedback?.blockReason) return { ok: false, error: `blocked: ${j.promptFeedback.blockReason}` };
  const c = j?.candidates?.[0];
  const text = (c?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  if (!text) return { ok: false, error: `empty reply${c?.finishReason ? ` (${c.finishReason})` : ''}` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not JSON after all - take it as plain lines.
    raw = { lines: text.split('\n') };
  }
  const arr = Array.isArray(raw) ? raw : (raw as { lines?: unknown })?.lines;
  if (!Array.isArray(arr)) return { ok: false, error: 'unexpected reply format' };
  const lines = arr
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim()) // drop "[Chorus]" labels
    .filter(Boolean);
  if (!lines.length) return { ok: false, error: 'no lines' };
  return { ok: true, lines };
}

/** Base64 of binary data in chunks (btoa on a huge string would overflow the call stack). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}
