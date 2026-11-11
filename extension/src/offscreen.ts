/**
 * Offscreen-документ: получает аудиопоток вкладки, возвращает звук в динамики,
 * режет поток на окна с перекрытием, кодирует в WAV 16 кГц и отправляет на бэкенд.
 * Время окна фиксируется настенными часами (Date.now): content script по ним
 * вычисляет позицию трека (см. core/clock.ts).
 */
import { concatFloat32, encodeWav, firstNonSilent, toAsrPcm, toMono16k } from './core/audio.ts';
import { windowFor } from './core/speed.ts';
import { buildPrompt, fromCloud, fromElevenLabs, normLang, pickByConfidence } from './core/cloud.ts';
import { fromAudioShakeJson, fromSrt } from './core/audioshake.ts';
import type { Config, TranscribeResponse } from './core/types.ts';
import { t } from './core/i18n.ts';
import { groqEndpoint } from './core/config.ts';

interface PendingChunk {
  epoch: number;
  startWall: number;
  durationSec: number;
  first: boolean;
  last: boolean;
  wav: ArrayBuffer;
  hint: { title?: string | null; artist?: string | null } | null;
  /** Финальный проход: весь непрерывный кусок трека одним запросом. */
  final?: boolean;
}

/** Непрерывно записанный кусок трека (обычно — весь трек) для финального прохода. */
interface Take {
  epoch: number;
  startWall: number;
  eff: number;
  samples: Float32Array;
}

/** Финальный проход не делаем для очень длинных записей (лимит размера файла у API). */
const MAX_FINAL_SEC = 600;

/** Куски не выбрасываются: трек конечен, а потеря куска — это пропавший кусок текста. Предел — только от зависания. */
const MAX_QUEUE = 60;

let audioCtx: AudioContext | null = null;
/** Частота дискретизации источника звука (захват вкладки или скрытый плеер). */
let srcRate = 48000;
/** Источник звука подключён (захват вкладки или скрытый плеер). */
let live = false;
let stream: MediaStream | null = null;
let node: AudioWorkletNode | null = null;
let cfg: Config | null = null;
/** Во сколько раз ускорен трек: звук захвата растягивается обратно перед распознаванием. */
let speed = 1;
/** Язык песни, закреплённый по первому куску (в режиме «Авто»), чтобы модель не прыгала между языками. */
let lockedLang: string | null = null;
/** Новая эпоха началась до старта трека: тишину в начале отбрасываем, окно начинается с первого звука. */
let trimLead = false;

let epoch = 0;
let paused = true;
let firstInEpoch = true;
let hint: PendingChunk['hint'] = null;
let blocks: Float32Array[] = [];
let buffered = 0;
let bufferStartWall = 0;

// Текущий непрерывный дубль и готовые дубли для финального прохода.
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
    // Звук присылает страница (порт sctexts-pcm) — своего захвата нет.
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

  // Захват вкладки глушит её звук. В обычном режиме возвращаем звук в динамики,
  // в режиме ссылки (monitor=false) трек слушается беззвучно.
  if (monitor) source.connect(audioCtx.destination);
  // Worklet должен быть подключён к выходу, иначе браузер может не вызывать process().
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
    if (i < 0) return; // трек ещё не заиграл
    if (i > 0) block = block.subarray(i);
    trimLead = false;
  }
  const sr = srcRate;
  const eff = sr / speed; // частота дискретизации «в секундах трека»
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
  // Трек играл в speed раз быстрее без сохранения высоты тона: если считать, что сэмплы
  // записаны с частотой sr/speed, получается исходный звук с нормальной скоростью и тоном.
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
    // Пауза: дораспознать накопленный хвост (если в нём есть новый звук) под старой эпохой.
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
  // Скорость новой эпохи (накопленный хвост выше уже отправлен со старой).
  if (typeof m.speed === 'number' && m.speed > 0) speed = m.speed;
  trimLead = !!m.trimLead;
  firstInEpoch = true;
}

/** Закрывает текущий непрерывный дубль (пауза, перемотка, конец трека). */
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
 * Финальный проход: каждый непрерывный дубль (обычно весь трек) распознаётся одним запросом —
 * с полным контекстом песни это заметно точнее, чем кусками по 40 секунд.
 */
function finalPass() {
  closeTake();
  const list = takes;
  takes = [];
  if (cfg?.audioshakeKey) {
    void audioshakePass(list);
    return;
  }
  void whisperFinal(list);
}

/**
 * Финальный проход Whisper: весь записанный трек одним запросом, сразу и параллельно с
 * предварительными кусками (раньше он ждал в общей очереди, пока они распознаются).
 * Модель — самая точная (large-v3), даже если для предварительных кусков выбрана turbo.
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

/** Финальный проход через AudioShake; при ошибке — обычный финальный проход Whisper. */
let asPending = 0;
async function audioshakePass(list: Take[]) {
  const failed: Take[] = [];
  const todo = list.filter((tk) => tk.samples.length / tk.eff <= 45 * 60); // лимит AudioShake — 45 минут
  asPending++;
  try {
    // Дубли (если трек прерывался) отправляются параллельно — каждый ждать по очереди долго.
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
  // Повыше качество, чем для Whisper (AudioShake советует несжатый звук), но без «досочинённых» частот.
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

  // Ждём результат: опрос раз в 5 секунд (как в документации), не дольше ~4 минут.
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
  // При перегрузке выбрасываем самые старые обычные куски (финальный проход не трогаем).
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

/** Временные сбои (лимит запросов, ошибка сервера, обрыв сети) — до 4 попыток с паузой. */
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
 * Распознаёт кусок. Язык: из настроек, иначе закреплённый. Пока не закреплён — модель определяет его
 * сама; если она решила, что это не русский и не английский (на музыке так бывает), кусок
 * распознаётся с обоими языками и берётся вариант, в котором модель увереннее.
 */
async function transcribe(c: PendingChunk): Promise<TranscribeResponse> {
  const fixed = cfg!.language !== 'auto' ? cfg!.language : lockedLang;
  if (fixed) return transcribeOnce(c, fixed);
  const res = await transcribeOnce(c, '');
  const words = res.segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  const detected = normLang(res.language);
  if (detected === 'ru' || detected === 'en') {
    if (words >= 4) lockedLang = detected; // по паре слов язык не закрепляем
    return res;
  }
  if (words === 0) return res; // проигрыш — решим по следующему куску
  const [ru, en] = await Promise.all([transcribeOnce(c, 'ru'), transcribeOnce(c, 'en')]);
  const best = pickByConfidence({ lang: 'ru', res: ru }, { lang: 'en', res: en });
  lockedLang = best.lang;
  return best.res;
}

async function transcribeOnce(c: PendingChunk, lang: string): Promise<TranscribeResponse> {
  const form = new FormData();
  form.append('file', new Blob([c.wav], { type: 'audio/wav' }), 'chunk.wav');

  if (cfg!.mode === 'cloud' && cfg!.apiModel.startsWith('scribe')) {
    // ElevenLabs Scribe: слова с таймкодами, строки собираем сами.
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
    // whisper-1 — это Whisper large-v2 у OpenAI: на песнях он ошибается реже, чем v3.
    const openai = cfg!.apiModel === 'whisper-1';
    // Groq: свой ключ — напрямую, без ключа — через сервер-посредник (если он вшит при сборке).
    const groq = openai ? null : groqEndpoint(cfg!);
    if (openai && !cfg!.openaiKey) throw new Error(t('noOpenaiKey'));
    if (!openai && !groq) throw new Error(t('noApiKey'));
    const apiUrl = openai ? 'https://api.openai.com/v1' : groq!.url;
    const authHeaders: Record<string, string> = openai ? { Authorization: `Bearer ${cfg!.openaiKey}` } : groq!.headers;
    // Финальный проход у Groq — всегда самой точной моделью.
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
      finalPass();
      break;
  }
});

send({ type: 'OFFSCREEN_READY' });

// Звук со страницы (кнопка «Начать распознавание» + разрешение в окне Chrome): PCM16 в base64.
chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'sctexts-pcm') return;
  p.onMessage.addListener((m: { sr: number; w: number; d: string }) => {
    if (!live || audioCtx) return; // идёт обычный захват вкладки — этот звук не нужен
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
