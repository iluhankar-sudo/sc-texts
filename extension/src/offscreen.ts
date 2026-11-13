/**
 * Offscreen document: receives the tab's audio stream, routes the sound back to the speakers,
 * cuts the stream into overlapping windows, encodes them as 16 kHz WAV and sends them for recognition.
 * A window's time is stamped with the wall clock (Date.now): from it the content script
 * computes the track position (see core/clock.ts).
 */
import { concatFloat32, encodeWav, firstNonSilent, toAsrPcm, toMono16k } from './core/audio.ts';
import { windowFor } from './core/speed.ts';
import { buildPrompt, fromCloud, fromElevenLabs, normLang, pickByConfidence } from './core/cloud.ts';
import { fromAudioShakeJson, fromSrt } from './core/audioshake.ts';
import type { Config, TranscribeResponse } from './core/types.ts';
import { t } from './core/i18n.ts';
import { geminiEndpoint, groqEndpoint } from './core/config.ts';
import { buildGeminiRequest, parseGeminiLyrics, toBase64, type GeminiMeta } from './core/gemini.ts';

interface PendingChunk {
  epoch: number;
  startWall: number;
  durationSec: number;
  first: boolean;
  last: boolean;
  wav: ArrayBuffer;
  hint: { title?: string | null; artist?: string | null } | null;
  /** Final pass: a whole continuous piece of the track in one request. */
  final?: boolean;
}

/** A continuously recorded piece of the track (usually the whole track) for the final pass. */
interface Take {
  epoch: number;
  startWall: number;
  eff: number;
  samples: Float32Array;
}

/** No final pass for very long recordings (the API's file size limit). */
const MAX_FINAL_SEC = 600;

/** Chunks are never dropped: the track is finite, and a lost chunk is a missing piece of lyrics. The limit only guards against hangs.
const MAX_QUEUE = 60;

let audioCtx: AudioContext | null = null;
/** Sample rate of the audio source (tab capture or the page). */
let srcRate = 48000;
/** The audio source is connected (tab capture or the page). */
let live = false;
let stream: MediaStream | null = null;
let node: AudioWorkletNode | null = null;
let cfg: Config | null = null;
/** How many times the track is sped up: captured audio is stretched back before recognition. */
let speed = 1;
/** Song language locked from the first chunk (in "Auto" mode), so the model doesn't jump between languages. */
let lockedLang: string | null = null;
/** A new epoch started before the track did: drop the leading silence, the window starts at the first sound. */
let trimLead = false;

let epoch = 0;
let paused = true;
let firstInEpoch = true;
let hint: PendingChunk['hint'] = null;
let blocks: Float32Array[] = [];
let buffered = 0;
let bufferStartWall = 0;

// The current continuous take and finished takes for the final pass.
let takeBlocks: Float32Array[] = [];
let takeLen = 0;
let takeStartWall = 0;
let takeEpoch = 0;
let takeSpeed = 1;
let takes: Take[] = [];

const queue: PendingChunk[] = [];
let busy = false;

function send(msg: Record<string, unknown>) {
  chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});
}

function clearBuffer() {
  blocks = [];
  buffered = 0;
}

async function stop() {
  live = false;
  node?.disconnect();
  node = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (audioCtx && audioCtx.state !== 'closed') await audioCtx.close();
  audioCtx = null;
  clearBuffer();
  queue.length = 0;
  paused = true;
}

async function start(streamId: string | null, config: Config, monitor: boolean, rate = 1) {
  await stop();
  cfg = config;
  speed = rate > 0 ? rate : 1;
  lockedLang = null;
  takes = [];
  takeBlocks = [];
  takeLen = 0;
  epoch = 0;
  firstInEpoch = true;

  if (!streamId) {
    // The page sends the audio (the sctexts-pcm port) - no capture of our own.
    live = true;
    send({ type: 'STATUS', state: 'listening' });
    return;
  }
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  } as unknown as MediaStreamConstraints);

  audioCtx = new AudioContext();
  srcRate = audioCtx.sampleRate;
  live = true;
  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
  const source = audioCtx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(audioCtx, 'pcm-capture');
  node.port.onmessage = (e: MessageEvent<Float32Array>) => onBlock(e.data);

  // Tab capture mutes the tab. In normal mode the sound is routed back to the speakers,
  // in link mode (monitor=false) the track is listened to silently.
  if (monitor) source.connect(audioCtx.destination);
  // The worklet must be connected to the output, otherwise the browser may not call process().
  const silent = audioCtx.createGain();
  silent.gain.value = 0;
  source.connect(node);
  node.connect(silent);
  silent.connect(audioCtx.destination);

  send({ type: 'STATUS', state: 'listening' });
}

function onBlock(input: Float32Array, wallEnd = Date.now()) {
  if (paused || !live || !cfg) return;
  let block = input;
  if (trimLead) {
    const i = firstNonSilent(block);
    if (i < 0) return; // the track hasn't started yet
    if (i > 0) block = block.subarray(i);
    trimLead = false;
  }
  const sr = srcRate;
  const eff = sr / speed; // sample rate "in track seconds"
  if (buffered === 0) bufferStartWall = wallEnd - (block.length / sr) * 1000;
  if (takeLen === 0) {
    takeStartWall = wallEnd - (block.length / sr) * 1000;
    takeEpoch = epoch;
    takeSpeed = speed;
  }
  takeBlocks.push(block);
  takeLen += block.length;
  blocks.push(block);
  buffered += block.length;
  if (buffered >= windowFor(cfg.windowSec, speed) * eff) emitWindow(false);
}

function emitWindow(last: boolean) {
  if (!live || !cfg) return;
  const sr = srcRate;
  // The track played speed times faster without preserving pitch: if we treat the samples
  // as recorded at sr/speed, we get the original audio at normal speed and pitch.
  const eff = sr / speed;
  const all = concatFloat32(blocks, buffered);
  enqueue({
    epoch,
    startWall: bufferStartWall,
    durationSec: all.length / eff,
    first: firstInEpoch,
    last,
    wav: encodeWav(toAsrPcm(all, eff), 16000),
    hint,
  });
  firstInEpoch = false;
  if (last) {
    clearBuffer();
    return;
  }
  const keep = Math.min(all.length, Math.round(cfg.overlapSec * eff));
  const tail = all.slice(all.length - keep);
  bufferStartWall += ((all.length - keep) / sr) * 1000;
  blocks = [tail];
  buffered = tail.length;
}

function handleReset(m: {
  epoch: number;
  paused: boolean;
  flush: boolean;
  hint?: PendingChunk['hint'];
  speed?: number;
  trimLead?: boolean;
}) {
  if (live && cfg && m.flush && !paused) {
    // Pause: finish recognizing the accumulated tail (if it has new audio) under the old epoch.
    const eff = srcRate / speed;
    const keep = firstInEpoch ? 0 : Math.round(cfg.overlapSec * eff);
    if (buffered - keep >= 1.5 * eff) emitWindow(true);
  }
  clearBuffer();
  closeTake();
  if (!busy && queue.length === 0) send({ type: 'IDLE' });
  epoch = m.epoch;
  paused = m.paused;
  if (m.hint) hint = m.hint;
  // The new epoch's speed (the accumulated tail above was already sent with the old one).
  if (typeof m.speed === 'number' && m.speed > 0) speed = m.speed;
  trimLead = !!m.trimLead;
  firstInEpoch = true;
}

/** Closes the current continuous take (pause, seek, end of track). */
function closeTake() {
  if (!live || takeLen === 0) return;
  const eff = srcRate / takeSpeed;
  if (takeLen / eff >= 2) {
    takes.push({ epoch: takeEpoch, startWall: takeStartWall, eff, samples: concatFloat32(takeBlocks, takeLen) });
  }
  takeBlocks = [];
  takeLen = 0;
}

/**
 * Final pass: each continuous take (usually the whole track) is recognized in one request -
 * with the full song context this is noticeably more accurate than 40-second chunks.
 */
function finalPass(meta: GeminiMeta | null) {
  closeTake();
  const list = takes;
  takes = [];
  // Gemini listens to the same recording in parallel; its text is aligned onto Whisper's timings later.
  void geminiPass(list, meta);
  if (cfg?.audioshakeKey) {
    void audioshakePass(list);
    return;
  }
  void whisperFinal(list);
}

/**
 * Whisper final pass: the whole recorded track in one request, right away and in parallel with
 * the preview chunks (it used to wait in the shared queue until they were recognized).
 * The model is the most accurate one (large-v3), even if turbo is chosen for the preview chunks.
 */
async function whisperFinal(list: Take[]) {
  try {
    await Promise.all(
      list.map(async (tk) => {
        const sec = tk.samples.length / tk.eff;
        if (sec > MAX_FINAL_SEC) return;
        const c: PendingChunk = {
          epoch: tk.epoch,
          startWall: tk.startWall,
          durationSec: sec,
          first: true,
          last: true,
          wav: encodeWav(toAsrPcm(tk.samples, tk.eff), 16000),
          hint,
          final: true,
        };
        try {
          const response = await withRetry(() => transcribe(c));
          send({ type: 'CHUNK_RESULT', epoch: c.epoch, startWall: c.startWall, durationSec: sec, first: true, last: true, final: true, response });
        } catch (err) {
          send({ type: 'STATUS', state: 'error', message: t('recFailed', { msg: String(err) }) });
        }
      }),
    );
  } finally {
    send({ type: 'FINAL_DONE' });
  }
}

const AS_API = 'https://api.audioshake.ai';
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Final pass via AudioShake; on error, the usual Whisper final pass. */
let asPending = 0;
async function audioshakePass(list: Take[]) {
  const failed: Take[] = [];
  const todo = list.filter((tk) => tk.samples.length / tk.eff <= 45 * 60); // AudioShake's limit is 45 minutes
  asPending++;
  try {
    // Takes (if the track was interrupted) are sent in parallel - waiting for each in turn takes too long.
    await Promise.all(
      todo.map(async (tk) => {
        const sec = tk.samples.length / tk.eff;
        try {
          const response = await withRetry(() => audioshakeTake(tk));
          send({ type: 'CHUNK_RESULT', epoch: tk.epoch, startWall: tk.startWall, durationSec: sec, first: true, last: true, final: true, engine: 'audioshake', response });
        } catch (err) {
          send({ type: 'STATUS', state: 'error', message: t('audioshakeFailed', { msg: String(err).replace(/^Error: /, '').slice(0, 120) }) });
          failed.push(tk);
        }
      }),
    );
  } finally {
    asPending--;
  }
  if (failed.length) await whisperFinal(failed);
  else send({ type: 'FINAL_DONE' });
}

async function audioshakeTake(tk: Take): Promise<TranscribeResponse> {
  const key = cfg!.audioshakeKey;
  // Higher quality than for Whisper (AudioShake recommends uncompressed audio), but without "invented" frequencies.
  const rate = Math.max(16000, Math.min(32000, Math.round(tk.eff)));
  const wav = encodeWav(toMono16k(tk.samples, tk.eff, rate), rate);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'track.wav');
  const up = await fetch(`${AS_API}/assets`, { method: 'POST', headers: { 'x-api-key': key }, body: form });
  if (!up.ok) throw new Error(`upload HTTP ${up.status}: ${(await up.text()).slice(0, 120)}`);
  const asset = (await up.json()) as { id?: string };
  if (!asset.id) throw new Error('upload: no asset id');

  const target: Record<string, unknown> = { model: 'alignment', formats: ['json', 'srt'] };
  const lang = cfg!.language !== 'auto' ? cfg!.language : lockedLang;
  if (lang) target.language = lang;
  const tr = await fetch(`${AS_API}/tasks`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: asset.id, targets: [target] }),
  });
  if (!tr.ok) throw new Error(`task HTTP ${tr.status}: ${(await tr.text()).slice(0, 120)}`);
  const task = (await tr.json()) as { id?: string };
  if (!task.id) throw new Error('task: no id');

  // Wait for the result: poll every 5 seconds (as in the docs), for no longer than ~4 minutes.
  type Out = { link?: string; format?: string; name?: string };
  type Target = { model?: string; status?: string; output?: Out[]; error?: unknown };
  let outputs: Out[] | null = null;
  for (let i = 0; i < 48 && !outputs; i++) {
    await sleepMs(5000);
    const g = await fetch(`${AS_API}/tasks/${encodeURIComponent(task.id)}`, { headers: { 'x-api-key': key } });
    if (!g.ok) continue;
    const st = (await g.json()) as { targets?: Target[] };
    const tg = st.targets?.find((x) => x.model === 'alignment') ?? st.targets?.[0];
    if (!tg) continue;
    if (tg.status === 'completed') outputs = tg.output ?? [];
    else if (tg.status === 'error' || tg.status === 'failed') throw new Error(`task error: ${JSON.stringify(tg.error ?? tg.status).slice(0, 120)}`);
  }
  if (!outputs) throw new Error('timeout');

  const byFmt = (f: string) => outputs!.find((o) => (o.format ?? '').toLowerCase() === f || (o.link ?? '').split('?')[0]!.toLowerCase().endsWith(`.${f}`) || (o.name ?? '').toLowerCase().endsWith(`.${f}`));
  const sec = tk.samples.length / tk.eff;
  const jsonOut = byFmt('json');
  if (jsonOut?.link) {
    try {
      const parsed = fromAudioShakeJson(await (await fetch(jsonOut.link)).json(), sec);
      if (parsed) return parsed;
    } catch (e) {
      if (e instanceof TypeError) throw new Error(t('audioshakeNoPerm'));
    }
  }
  const srtOut = byFmt('srt');
  if (srtOut?.link) {
    let text: string;
    try {
      text = await (await fetch(srtOut.link)).text();
    } catch {
      throw new Error(t('audioshakeNoPerm'));
    }
    const parsed = fromSrt(text);
    if (parsed) return parsed;
  }
  throw new Error('no usable output');
}

function enqueue(c: PendingChunk) {
  queue.push(c);
  // On overload, drop the oldest regular chunks (the final pass is never touched).
  while (queue.filter((q) => !q.final).length > MAX_QUEUE) {
    queue.splice(queue.findIndex((q) => !q.final), 1);
    send({ type: 'STATUS', state: 'lagging' });
  }
  void pump();
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const c = queue.shift()!;
      send({ type: 'STATUS', state: 'transcribing' });
      try {
        const response = await withRetry(() => transcribe(c));
        send({
          type: 'CHUNK_RESULT',
          epoch: c.epoch,
          startWall: c.startWall,
          durationSec: c.durationSec,
          first: c.first,
          last: c.last,
          final: !!c.final,
          response,
        });
        send({ type: 'STATUS', state: 'listening' });
      } catch (err) {
        send({ type: 'STATUS', state: 'error', message: t('recFailed', { msg: String(err) }) });
      }
    }
  } finally {
    busy = false;
    if (asPending === 0) send({ type: 'IDLE' });
  }
}

/** Transient failures (rate limit, server error, network drop) - up to 4 attempts with a pause. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err);
      const transient = /HTTP (429|5\d\d)|TypeError|Failed to fetch|network|timeout/i.test(msg);
      if (!transient || i >= 3 || !cfg) throw err;
      const wait = /HTTP 429/.test(msg) ? 4000 * (i + 1) : 1500 * (i + 1);
      send({ type: 'STATUS', state: 'lagging' });
      await sleepMs(wait);
    }
  }
}

/**
 * Recognizes a chunk. Language: from settings, otherwise the locked one. Until locked, the model detects it
 * itself; if it decided it's neither Russian nor English (it happens on music), the chunk
 * is recognized with both languages and the variant the model is more confident in wins.
 */
async function transcribe(c: PendingChunk): Promise<TranscribeResponse> {
  const fixed = cfg!.language !== 'auto' ? cfg!.language : lockedLang;
  if (fixed) return transcribeOnce(c, fixed);
  const res = await transcribeOnce(c, '');
  const words = res.segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  const detected = normLang(res.language);
  if (detected === 'ru' || detected === 'en') {
    if (words >= 4) lockedLang = detected; // don't lock the language on a couple of words
    return res;
  }
  if (words === 0) return res; // instrumental - decide on the next chunk
  const [ru, en] = await Promise.all([transcribeOnce(c, 'ru'), transcribeOnce(c, 'en')]);
  const best = pickByConfidence({ lang: 'ru', res: ru }, { lang: 'en', res: en });
  lockedLang = best.lang;
  return best.res;
}

async function transcribeOnce(c: PendingChunk, lang: string): Promise<TranscribeResponse> {
  const form = new FormData();
  form.append('file', new Blob([c.wav], { type: 'audio/wav' }), 'chunk.wav');

  if (cfg!.mode === 'cloud' && cfg!.apiModel.startsWith('scribe')) {
    // ElevenLabs Scribe: words with timestamps, we build the lines ourselves.
    if (!cfg!.elevenKey) throw new Error(t('noElevenKey'));
    form.append('model_id', cfg!.apiModel);
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    if (lang) form.append('language_code', lang);
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': cfg!.elevenKey },
      body: form,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return fromElevenLabs(await r.json());
  }

  if (cfg!.mode === 'cloud') {
    // whisper-1 is OpenAI's Whisper large-v2: on songs it makes fewer mistakes than v3.
    const openai = cfg!.apiModel === 'whisper-1';
    // Groq: with an own key - directly; without a key - via the proxy (if embedded at build time).
    const groq = openai ? null : groqEndpoint(cfg!);
    if (openai && !cfg!.openaiKey) throw new Error(t('noOpenaiKey'));
    if (!openai && !groq) throw new Error(t('noApiKey'));
    const apiUrl = openai ? 'https://api.openai.com/v1' : groq!.url;
    const authHeaders: Record<string, string> = openai ? { Authorization: `Bearer ${cfg!.openaiKey}` } : groq!.headers;
    // Groq's final pass always uses the most accurate model.
    const model = c.final && !openai && cfg!.apiModel === 'whisper-large-v3-turbo' ? 'whisper-large-v3' : cfg!.apiModel;
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    form.append('timestamp_granularities[]', 'word');
    form.append('temperature', '0');
    if (lang) form.append('language', lang);
    const prompt = buildPrompt(c.hint, lang, { uncensored: cfg!.uncensored, slang: cfg!.slang, custom: cfg!.customWords });
    if (prompt) form.append('prompt', prompt);
    const r = await fetch(`${apiUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders,
      body: form,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return fromCloud(await r.json());
  }

  form.append('language', lang);
  form.append('offset', '0');
  const r = await fetch(`${cfg!.serverUrl}/transcribe`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as TranscribeResponse;
}

chrome.runtime.onMessage.addListener((m) => {
  if (m?.target !== 'offscreen') return;
  switch (m.type) {
    case 'START':
      start(m.streamId, m.config, m.monitor !== false, Number(m.speed) || 1).catch((e) =>
        send({ type: 'STATUS', state: 'error', message: t('captureFailed', { msg: String(e) }) }),
      );
      break;
    case 'STOP':
      void stop();
      break;
    case 'RESET':
      handleReset(m);
      break;
    case 'FINAL_PASS':
      finalPass(m.gemini ?? null);
      break;
  }
});

send({ type: 'OFFSCREEN_READY' });

// Audio from the page ("Start recognition" button + Chrome's sharing prompt): PCM16 in base64.
chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'sctexts-pcm') return;
  p.onMessage.addListener((m: { sr: number; w: number; d: string }) => {
    if (!live || audioCtx) return; // regular tab capture is running - this audio isn't needed
    srcRate = m.sr;
    const bin = atob(m.d);
    const pcm = new Int16Array(bin.length / 2);
    for (let i = 0; i < pcm.length; i++) {
      const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      pcm[i] = v >= 0x8000 ? v - 0x10000 : v;
    }
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i]! / 0x8000;
    onBlock(f, m.w);
  });
});

/** Gemini takes at most this much audio (the request limit is 20 MB; 16 kHz WAV in base64 is ~43 KB per second). */
const GEMINI_MAX_SEC = 7 * 60;

/** Gemini listens to the whole recording and writes the lyrics down; the result goes to the page as GEMINI_RESULT. */
async function geminiPass(list: Take[], meta: GeminiMeta | null) {
  const ep = geminiEndpoint();
  if (!ep || !meta || !list.length) return send({ type: 'GEMINI_RESULT', ok: false, error: ep ? 'no audio' : 'no proxy' });
  try {
    const pcm = list.map((tk) => toAsrPcm(tk.samples, tk.eff));
    const total = pcm.reduce((n, p) => n + p.length, 0);
    if (total / 16000 > GEMINI_MAX_SEC) return send({ type: 'GEMINI_RESULT', ok: false, error: 'track too long' });
    const all = new Int16Array(total);
    let at = 0;
    for (const p of pcm) {
      all.set(p, at);
      at += p.length;
    }
    const wav = encodeWav(all, 16000);
    const body = JSON.stringify(buildGeminiRequest(toBase64(new Uint8Array(wav)), meta));
    const json = await withRetry(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 150000);
      try {
        const r = await fetch(ep.url, { method: 'POST', signal: ctrl.signal, headers: { ...ep.headers, 'Content-Type': 'application/json' }, body });
        const j = await r.json().catch(() => null);
        if (!r.ok) {
          const msg = (j as { error?: { message?: string } } | null)?.error?.message ?? '';
          throw Object.assign(new Error(`HTTP ${r.status}: ${msg.slice(0, 120)}`), { status: r.status });
        }
        return j;
      } finally {
        clearTimeout(timer);
      }
    });
    const res = parseGeminiLyrics(json);
    send(res.ok ? { type: 'GEMINI_RESULT', ok: true, lines: res.lines } : { type: 'GEMINI_RESULT', ok: false, error: res.error });
  } catch (e) {
    send({ type: 'GEMINI_RESULT', ok: false, error: String(e).slice(0, 160) });
  }
}
