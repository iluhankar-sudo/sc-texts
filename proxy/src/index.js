/**
 * sc texts proxy (Cloudflare Worker).
 *
 * Without its own key, the extension sends audio for recognition and text for translation/correction here,
 * and the proxy forwards them to Groq with its key (the GROQ_KEY secret). Users never see the key.
 *
 * Protecting the owner's limits:
 * - only the needed paths and models (allow-lists in wrangler.toml);
 * - audio up to 25 MB, chat replies up to 4000 tokens;
 * - at most LIMITER requests per minute from one address;
 * - if the APP_TOKEN secret is set, requests without an X-SC-Texts header with that value are rejected
 *   (stops casual visitors, not someone who extracts the token from the extension).
 */

const GROQ = 'https://api.groq.com/openai/v1';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-SC-Texts',
  'Access-Control-Max-Age': '86400',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
const fail = (status, message) => json({ error: { message } }, status);
const list = (s, fallback) => (s || fallback).split(',').map((x) => x.trim()).filter(Boolean);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ ok: true, service: 'sc-texts-proxy', key: !!env.GROQ_KEY });
    }
    if (request.method !== 'POST') return fail(405, 'method not allowed');
    if (!env.GROQ_KEY) return fail(500, 'proxy is not configured (GROQ_KEY)');
    if (env.APP_TOKEN && request.headers.get('X-SC-Texts') !== env.APP_TOKEN) return fail(401, 'unknown client');

    if (env.LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return fail(429, 'too many requests from this address, try again in a minute');
    }

    if (url.pathname === '/v1/audio/transcriptions') return transcribe(request, env);
    if (url.pathname === '/v1/chat/completions') return chat(request, env);
    return fail(404, 'not found');
  },
};

async function transcribe(request, env) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_AUDIO_BYTES) return fail(413, 'audio is too large (max 25 MB)');
  let form;
  try {
    form = await request.formData();
  } catch {
    return fail(400, 'expected multipart/form-data');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail(400, 'no audio file');
  if (file.size > MAX_AUDIO_BYTES) return fail(413, 'audio is too large (max 25 MB)');
  const model = String(form.get('model') || '');
  if (!list(env.ALLOWED_TRANSCRIBE_MODELS, 'whisper-large-v3,whisper-large-v3-turbo').includes(model)) {
    return fail(400, `model not allowed: ${model}`);
  }
  // Forward only known fields.
  const out = new FormData();
  out.append('file', file, file.name || 'audio.wav');
  for (const k of ['model', 'response_format', 'language', 'prompt', 'temperature']) {
    const v = form.get(k);
    if (v !== null) out.append(k, String(v));
  }
  for (const v of form.getAll('timestamp_granularities[]')) out.append('timestamp_granularities[]', String(v));
  return forward(`${GROQ}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${env.GROQ_KEY}` }, body: out });
}

async function chat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'expected JSON');
  }
  if (!list(env.ALLOWED_CHAT_MODELS, 'llama-3.3-70b-versatile').includes(String(body?.model))) {
    return fail(400, `model not allowed: ${body?.model}`);
  }
  const safe = {
    model: body.model,
    messages: Array.isArray(body.messages) ? body.messages.slice(0, 20) : [],
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.2,
    max_tokens: Math.min(Number(body.max_tokens) || 2048, 4000),
    stream: false,
  };
  if (body.response_format) safe.response_format = body.response_format;
  return forward(`${GROQ}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(safe),
  });
}

async function forward(url, init) {
  let r;
  try {
    r = await fetch(url, init);
  } catch (e) {
    return fail(502, `groq is unreachable: ${String(e).slice(0, 100)}`);
  }
  const headers = { 'Content-Type': r.headers.get('Content-Type') || 'application/json', ...cors };
  const ra = r.headers.get('Retry-After');
  if (ra) headers['Retry-After'] = ra;
  return new Response(r.body, { status: r.status, headers });
}
