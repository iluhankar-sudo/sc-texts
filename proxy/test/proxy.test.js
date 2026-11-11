import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  if (String(url).endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'ok', segments: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ choices: [{ message: { content: 'перевод' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const env = (extra = {}) => ({ GROQ_KEY: 'gsk_test', ...extra });
const audioForm = (model = 'whisper-large-v3') => {
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(1000)], { type: 'audio/wav' }), 'a.wav');
  f.append('model', model);
  f.append('response_format', 'verbose_json');
  f.append('timestamp_granularities[]', 'word');
  f.append('evil', 'x');
  return f;
};
const post = (path, body, headers = {}) => new Request(`https://p.example${path}`, { method: 'POST', body, headers });

test('transcription is forwarded with the secret key, only known fields', async () => {
  calls.length = 0;
  const r = await worker.fetch(post('/v1/audio/transcriptions', audioForm()), env());
  assert.equal(r.status, 200);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gsk_test');
  const sent = calls[0].init.body;
  assert.equal(sent.get('model'), 'whisper-large-v3');
  assert.deepEqual(sent.getAll('timestamp_granularities[]'), ['word']);
  assert.equal(sent.get('evil'), null);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});

test('disallowed model, wrong path, no key, app token', async () => {
  assert.equal((await worker.fetch(post('/v1/audio/transcriptions', audioForm('some-expensive-model')), env())).status, 400);
  assert.equal((await worker.fetch(post('/v1/files', '{}'), env())).status, 404);
  assert.equal((await worker.fetch(post('/v1/audio/transcriptions', audioForm()), {})).status, 500);
  assert.equal((await worker.fetch(post('/v1/audio/transcriptions', audioForm()), env({ APP_TOKEN: 't1' }))).status, 401);
  assert.equal((await worker.fetch(post('/v1/audio/transcriptions', audioForm(), { 'X-SC-Texts': 't1' }), env({ APP_TOKEN: 't1' }))).status, 200);
});

test('rate limit and chat caps', async () => {
  const LIMITER = { limit: async () => ({ success: false }) };
  assert.equal((await worker.fetch(post('/v1/chat/completions', '{}'), env({ LIMITER }))).status, 429);
  calls.length = 0;
  const r = await worker.fetch(post('/v1/chat/completions', JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }], max_tokens: 99999, stream: true })), env());
  assert.equal(r.status, 200);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.max_tokens, 4000);
  assert.equal(sent.stream, false);
  assert.equal((await worker.fetch(post('/v1/chat/completions', JSON.stringify({ model: 'gpt-5' })), env())).status, 400);
});

test('health and CORS preflight', async () => {
  const h = await worker.fetch(new Request('https://p.example/health'), env());
  assert.deepEqual(await h.json(), { ok: true, service: 'sc-texts-proxy', key: true });
  assert.equal((await worker.fetch(new Request('https://p.example/v1/audio/transcriptions', { method: 'OPTIONS' }), env())).status, 204);
});
