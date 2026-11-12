import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeWav, toMono16k } from '../src/core/audio.ts';
import { PlaybackClock } from '../src/core/clock.ts';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/core/config.ts';
import { cleanSegments, dropRepeatedRuns } from '../src/core/filter.ts';
import { dedupeAdjacent, mergeChunk } from '../src/core/merge.ts';
import { addRange, isCovered } from '../src/core/ranges.ts';
import { activeIndex, upcomingIndex, wordIndex } from '../src/core/sync.ts';
import { parseClock } from '../src/core/time.ts';
import type { Line, RawSegment } from '../src/core/types.ts';

const line = (start: number, end: number, text: string): Line => ({ start, end, text, words: [] });

test('parseClock', () => {
  assert.equal(parseClock('1:23'), 83);
  assert.equal(parseClock('0:07'), 7);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('Current time: 2:10'), 130);
  assert.equal(parseClock('abc'), null);
  assert.equal(parseClock(null), null);
});

test('normalizeConfig clamps and falls back', () => {
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  const c = normalizeConfig({ serverUrl: 'http://h:1///', language: 'xx', windowSec: '100', overlapSec: 50, syncOffsetMs: -9999 });
  assert.equal(c.serverUrl, 'http://h:1');
  assert.equal(c.language, 'auto');
  assert.equal(c.windowSec, 30);
  assert.equal(c.overlapSec, 15);
  assert.equal(c.syncOffsetMs, -3000);
});

test('toMono16k length and wav header', () => {
  const src = new Float32Array(48000).fill(0.5);
  const pcm = toMono16k(src, 48000);
  assert.equal(pcm.length, 16000);
  assert.ok(Math.abs(pcm[100]! - Math.round(0.5 * 0x7fff)) <= 1);
  const wav = encodeWav(pcm, 16000);
  const dv = new DataView(wav);
  assert.equal(wav.byteLength, 44 + 32000);
  assert.equal(String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)), 'RIFF');
  assert.equal(dv.getUint32(24, true), 16000);
  assert.equal(dv.getUint32(40, true), 32000);
});

test('cleanSegments drops junk, silence and empty; runs filtered', () => {
  const seg = (text: string, nsp = 0, s = 0, e = 1): RawSegment => ({ start: s, end: e, text, no_speech_prob: nsp, words: [] });
  const out = cleanSegments([seg('привет'), seg('  '), seg('Субтитры сделал кто-то'), seg('музыка', 0.9), seg('bad', 0, 2, 2)]);
  assert.deepEqual(out.map((l) => l.text), ['привет']);
  const loop = [1, 2, 3, 4, 5].map((i) => line(i, i + 1, 'я я я'));
  assert.equal(dropRepeatedRuns(loop).length, 0);
  assert.equal(dropRepeatedRuns(loop.slice(0, 3)).length, 3);
});

test('mergeChunk stitches overlapping windows without gaps or duplicates', () => {
  const edge = 1.5;
  const r1 = mergeChunk([], [line(1, 3, 'a'), line(5, 7, 'b'), line(8, 10, 'c')], { start: 0, end: 10 }, { edge, first: true, last: false });
  assert.deepEqual(r1.lines.map((l) => l.text), ['a', 'b']); // 'c' в ненадёжном хвосте
  const r2 = mergeChunk(r1.lines, [line(8.1, 10.2, 'c'), line(11, 13, 'd'), line(15.5, 17, 'e')], { start: 7, end: 17 }, { edge, first: false, last: false });
  assert.deepEqual(r2.lines.map((l) => l.text), ['a', 'b', 'c', 'd']);
  const r3 = mergeChunk(r2.lines, [line(15.2, 17, 'e')], { start: 14, end: 17 }, { edge, first: false, last: true });
  assert.deepEqual(r3.lines.map((l) => l.text), ['a', 'b', 'c', 'd', 'e']);
});

test('mergeChunk replaces earlier text in trusted window', () => {
  const r = mergeChunk([line(2, 4, 'wrong')], [line(2.1, 4, 'right')], { start: 0, end: 10 }, { edge: 1.5, first: true, last: false });
  assert.deepEqual(r.lines.map((l) => l.text), ['right']);
});

test('dedupeAdjacent merges near-identical neighbours', () => {
  const out = dedupeAdjacent([line(10, 12, 'hello world'), line(10.1, 12.1, 'Hello world!')]);
  assert.equal(out.length, 1);
  assert.equal(dedupeAdjacent([line(10, 12, 'one two'), line(12, 14, 'three four')]).length, 2);
});

test('ranges', () => {
  let r = addRange([], { start: 0, end: 5 });
  r = addRange(r, { start: 5, end: 8 });
  r = addRange(r, { start: 20, end: 25 });
  assert.deepEqual(r, [{ start: 0, end: 8 }, { start: 20, end: 25 }]);
  assert.ok(isCovered(r, 7.9));
  assert.ok(!isCovered(r, 10));
});

test('activeIndex / upcomingIndex / wordIndex', () => {
  const ls = [line(10, 12, 'a'), line(14, 16, 'b')];
  assert.equal(activeIndex(ls, 5), -1);
  assert.equal(activeIndex(ls, 11), 0);
  assert.equal(activeIndex(ls, 13), 0); // удержание 1.5 c
  assert.equal(activeIndex(ls, 13.6), -1); // пауза между строками
  assert.equal(activeIndex(ls, 14.1), 1);
  assert.equal(activeIndex(ls, 30), -1);
  assert.equal(upcomingIndex(ls, 13), 1);
  assert.equal(upcomingIndex(ls, 20), -1);
  const words = [{ word: 'a', start: 10, end: 10.5, prob: 1 }, { word: 'b', start: 11, end: 11.5, prob: 1 }];
  assert.equal(wordIndex(words, 9), -1);
  assert.equal(wordIndex(words, 10.7), 0);
  assert.equal(wordIndex(words, 12), 1);
});

test('PlaybackClock: tick anchoring, pause, seek, history', () => {
  const clock = new PlaybackClock();
  let ev = 'none';
  // играет с позиции 10.0 в момент wall=0, плеер показывает целые секунды
  for (let t = 0; t <= 5000; t += 100) {
    const e = clock.update(Math.floor(10 + t / 1000), true, t);
    if (e !== 'none') ev = e;
  }
  assert.equal(ev, 'none');
  const p = clock.positionAt(2500)!;
  assert.ok(Math.abs(p - 12.5) < 0.15, `got ${p}`);

  assert.equal(clock.update(15, false, 5100), 'pause');
  const frozen = clock.now(9000);
  assert.ok(Math.abs(frozen - 15.1) < 0.2, `frozen ${frozen}`);
  assert.equal(clock.update(15, false, 9000), 'none');

  assert.equal(clock.update(15, true, 9100), 'play');
  assert.equal(clock.update(60, true, 9200), 'seek');
  assert.ok(Math.abs(clock.now(9200) - 60.5) < 1e-9);
  // прошлое по-прежнему доступно
  assert.ok(Math.abs(clock.positionAt(3000)! - 13) < 0.15);
});

import { fromCloud } from '../src/core/cloud.ts';

test('fromCloud maps verbose_json and attaches words to segments', () => {
  const r = fromCloud({
    language: 'russian',
    duration: 10,
    segments: [{ start: 1, end: 3, text: ' привет мир ', no_speech_prob: 0.1 }, { start: 4, end: 6, text: 'ещё' }],
    words: [
      { word: ' привет', start: 1.1, end: 1.8 },
      { word: 'мир', start: 2, end: 2.9 },
      { word: 'ещё', start: 4.2, end: 5 },
    ],
  });
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0]!.text, 'привет мир');
  assert.deepEqual(r.segments[0]!.words.map((w) => w.word), ['привет', 'мир']);
  assert.deepEqual(r.segments[1]!.words.map((w) => w.word), ['ещё']);
  assert.equal(fromCloud({}).segments.length, 0);
});

test('normalizeConfig cloud defaults', () => {
  const c = normalizeConfig({ mode: 'x', apiUrl: 'https://a.b/v1//', apiKey: ' k ' });
  assert.equal(c.mode, 'cloud');
  assert.equal(c.apiUrl, 'https://a.b/v1');
  assert.equal(c.apiKey, 'k');
});

import { isSameTrack, parseTrackUrl } from '../src/core/link.ts';

test('parseTrackUrl accepts tracks, rejects playlists and junk', () => {
  assert.deepEqual(parseTrackUrl('https://soundcloud.com/Artist/My-Track?si=abc&utm=x'), {
    url: 'https://soundcloud.com/Artist/My-Track',
    path: '/artist/my-track',
  });
  assert.equal(parseTrackUrl('m.soundcloud.com/a/b')!.url, 'https://soundcloud.com/a/b');
  assert.deepEqual(parseTrackUrl('https://on.soundcloud.com/AbC123'), { url: 'https://on.soundcloud.com/AbC123', path: null });
  assert.equal(parseTrackUrl('https://soundcloud.com/artist'), null);
  assert.equal(parseTrackUrl('https://soundcloud.com/artist/sets/album'), null);
  assert.equal(parseTrackUrl('https://example.com/a/b'), null);
  assert.equal(parseTrackUrl('просто текст'), null);
});

test('isSameTrack', () => {
  assert.ok(isSameTrack('/Artist/My-Track', '/artist/my-track'));
  assert.ok(isSameTrack('/artist/my-track/', '/artist/my-track'));
  assert.ok(!isSameTrack('/artist/my-track-2', '/artist/my-track'));
  assert.ok(isSameTrack('/undefined/my-track', '/artist/my-track')); // исполнитель ещё не подгрузился
  assert.ok(!isSameTrack('/other/my-track', '/artist/my-track'));
  assert.ok(!isSameTrack('/undefined/other-track', '/artist/my-track'));
  assert.ok(isSameTrack('/x/y', null));
  assert.ok(!isSameTrack(null, '/a/b'));
});

import { coveredRatio, pruneCache, trackKey } from '../src/core/cache.ts';

test('cache helpers', () => {
  assert.equal(trackKey('/Artist/Track/?in=x'), '/artist/track');
  const map = { a: { createdAt: 1 }, b: { createdAt: 3 }, c: { createdAt: 2 } };
  assert.deepEqual(Object.keys(pruneCache(map, 2)).sort(), ['b', 'c']);
  assert.equal(coveredRatio([{ start: 0, end: 50 }, { start: 60, end: 100 }], 100), 0.9);
  assert.equal(coveredRatio([{ start: -5, end: 500 }], 100), 1);
  assert.equal(coveredRatio([], 0), 0);
});

import { baseLang, detectScriptLang } from '../src/core/lang.ts';

test('language helpers', () => {
  assert.equal(detectScriptLang('Ветер поёт'), 'ru');
  assert.equal(detectScriptLang('Midnight lights'), 'en');
  assert.equal(detectScriptLang('Я baby, ты моя'), 'ru');
  assert.equal(detectScriptLang('♪ 123'), null);
  assert.equal(baseLang('ru-RU'), 'ru');
  assert.equal(baseLang('en_US'), 'en');
  assert.equal(baseLang(''), 'en');
});

import { buildPrompt, fromElevenLabs } from '../src/core/cloud.ts';

test('fromElevenLabs groups words into lines', () => {
  const w = (text: string, start: number, end: number) => ({ text, start, end, type: 'word', logprob: 0 });
  const r = fromElevenLabs({
    language_code: 'ru',
    words: [
      w('Огни', 0, 0.4), { text: ' ', start: 0.4, end: 0.5, type: 'spacing' }, w('города.', 0.5, 1),
      w('Ветер', 1.1, 1.5), w('поёт', 1.6, 2),
      w('Тишина', 3.5, 4), { text: '(смех)', start: 4, end: 4.5, type: 'audio_event' },
    ],
  });
  assert.deepEqual(r.segments.map((s) => s.text), ['Огни города.', 'Ветер поёт', 'Тишина']);
  assert.equal(r.segments[0]!.words.length, 2);
  assert.equal(r.segments[1]!.start, 1.1);
  assert.equal(fromElevenLabs({}).segments.length, 0);
});

test('buildPrompt: artist and title as plain vocabulary, no announcement sentence', () => {
  assert.equal(buildPrompt({ title: 'Night Drive', artist: 'Test' }, 'ru'), 'Test, Night Drive.');
  assert.equal(buildPrompt({ title: 'Night Drive', artist: null }, 'en'), 'Night Drive.');
  assert.equal(buildPrompt(null, ''), '');
  assert.ok(!/Текст песни|Song lyrics/.test(buildPrompt({ title: 'X', artist: 'Y' }, 'ru', { slang: true, uncensored: true })));
});

import { cleanTitle, guessArtistTrack, parseLrc, pickBest } from '../src/core/lyrics.ts';

test('parseLrc', () => {
  const lines = parseLrc('[ar:Test]\n[00:12.50] Первая строка\n[00:15.00]\n[00:16.20]Вторая строка\n[00:20.00][01:05.00] Припев');
  assert.deepEqual(lines.map((l) => [l.start, l.text]), [[12.5, 'Первая строка'], [16.2, 'Вторая строка'], [20, 'Припев'], [65, 'Припев']]);
  assert.equal(lines[0]!.end, 15); // конец = начало следующей отметки (пустая строка — пауза)
});

test('cleanTitle / guessArtistTrack', () => {
  assert.equal(cleanTitle('Night Drive (prod. Someone) [Free DL]'), 'Night Drive');
  assert.equal(cleanTitle('Night Drive feat. Other'), 'Night Drive');
  assert.deepEqual(guessArtistTrack('Test Artist - Night Drive (prod. X)', 'Some Label Records'), [
    { artist: 'Test Artist', track: 'Night Drive' },
    { artist: 'Some Label', track: 'Night Drive' },
  ]);
  assert.deepEqual(guessArtistTrack('Night Drive', 'Test Artist'), [{ artist: 'Test Artist', track: 'Night Drive' }]);
});

test('pickBest prefers exact title, artist, duration and synced lyrics', () => {
  const recs = [
    { trackName: 'Night Drive (Remix)', artistName: 'Test Artist', duration: 200, plainLyrics: 'x' },
    { trackName: 'Night Drive', artistName: 'Test Artist', duration: 185, syncedLyrics: '[00:01.00] x' },
    { trackName: 'Night Drive', artistName: 'Другой', duration: 185, plainLyrics: 'x' },
    { trackName: 'Other Song', artistName: 'Test Artist', duration: 185, syncedLyrics: '[00:01.00] x' },
  ];
  assert.equal(pickBest(recs, { artist: 'Test Artist', track: 'Night Drive', duration: 186 }), recs[1]);
  assert.equal(pickBest(recs, { artist: 'Unknown', track: 'Completely Different' }), null);
});

import { setLang, t as tr, uiLang } from '../src/core/i18n.ts';

test('i18n picks language and fills placeholders', () => {
  assert.equal(uiLang('ru-RU'), 'ru');
  assert.equal(uiLang('en-GB'), 'en');
  assert.equal(uiLang('de-DE'), 'en');
  setLang('ru');
  assert.equal(tr('translateTo', { lang: 'английский' }), 'Перевести на английский');
  assert.equal(tr('lineCount', { src: 'X', n: 3 }), 'X · строк: 3');
  setLang('en');
  assert.equal(tr('translateTo', { lang: 'Russian' }), 'Translate to Russian');
  assert.equal(tr('lineCount', { src: 'X', n: 3 }), 'X · 3 lines');
});

test('PlaybackClock with rate and exact time', () => {
  const c = new PlaybackClock();
  c.setRate(3, 0);
  assert.equal(c.updateExact(10, true, 0), 'none');
  for (let w = 100; w <= 2000; w += 100) assert.equal(c.updateExact(10 + (w / 1000) * 3, true, w), 'none');
  // ×3: за 1 секунду реального времени трек сдвигается на 3 секунды
  assert.ok(Math.abs(c.positionAt(1000)! - 13) < 0.05, String(c.positionAt(1000)));
  assert.ok(Math.abs(c.now(2500) - 17.5) < 0.05);
  assert.equal(c.updateExact(50, true, 2600), 'seek');
  assert.equal(c.updateExact(50.2, false, 2700), 'pause');
  assert.ok(Math.abs(c.now(9000) - 50.2) < 1e-9);
});

import { toMono16k as resample } from '../src/core/audio.ts';

test('stretching sped-up capture restores original duration', () => {
  // 1 секунда трека, сыгранная на ×3 и захваченная на 48 кГц = 16000 сэмплов;
  // при частоте 48000/3 они дают ровно 1 секунду звука для распознавания.
  const captured = new Float32Array(16000).fill(0.25);
  assert.equal(resample(captured, 48000 / 3).length, 16000);
});

import { pickSpeed, windowFor } from '../src/core/speed.ts';

test('pickSpeed auto: accuracy first, caps at x3', () => {
  assert.equal(pickSpeed(0, 210), 3); // 3:30 → ×3 → 70 с
  assert.equal(pickSpeed(0, 60), 2.5); // 1:00 → ×2.4 → ×2.5
  assert.equal(pickSpeed(0, 40), 2); // короткий трек: минимум ×2
  assert.equal(pickSpeed(0, 300), 3); // длинный: не выше ×3
  assert.equal(pickSpeed(0, null), 3);
  assert.equal(pickSpeed(8, 200), 8);
  assert.equal(pickSpeed(1, 200), 1);
  assert.equal(windowFor(20, 6), 40);
  assert.equal(windowFor(20, 1), 20);
});

import { firstNonSilent } from '../src/core/audio.ts';

test('firstNonSilent finds where the track starts', () => {
  const b = new Float32Array(100);
  assert.equal(firstNonSilent(b), -1);
  b[37] = 0.01;
  assert.equal(firstNonSilent(b), 37);
  b[10] = 0.00001; // шум ниже порога
  assert.equal(firstNonSilent(b), 37);
});

import { confidence, normLang, pickByConfidence } from '../src/core/cloud.ts';
import { isHallucination } from '../src/core/filter.ts';

test('hallucination filter uses model confidence', () => {
  const seg = (text: string, extra: Partial<RawSegment>): RawSegment => ({ start: 0, end: 2, text, no_speech_prob: 0.1, words: [], ...extra });
  assert.equal(isHallucination(seg('Ветер поёт в проводах', { avg_logprob: -0.3 }), 'Ветер поёт в проводах'), false);
  assert.equal(isHallucination(seg('Some random words here', { avg_logprob: -1.3 }), 'Some random words here'), true);
  assert.equal(isHallucination(seg('Here!', { avg_logprob: -0.7 }), 'Here!'), true);
  assert.equal(isHallucination(seg('Привет', { avg_logprob: -0.2 }), 'Привет'), false); // уверенное короткое — оставляем
  assert.equal(isHallucination(seg('la la la la la la', { avg_logprob: -0.3, compression_ratio: 3.1 }), 'la la la la la la'), true);
  assert.equal(isHallucination(seg('text', { no_speech_prob: 0.9, avg_logprob: -0.7 }), 'text'), true);
  assert.equal(isHallucination(seg('без оценок', { no_speech_prob: 0.2 }), 'без оценок'), false);
});

test('language helpers for locking', () => {
  assert.equal(normLang('russian'), 'ru');
  assert.equal(normLang('English'), 'en');
  assert.equal(normLang('rus'), 'ru');
  assert.equal(normLang('indonesian'), 'indonesian');
  const mk = (lp: number) => ({ language: '', language_probability: 1, duration: 10, segments: [{ start: 0, end: 5, text: 'x', no_speech_prob: 0, avg_logprob: lp, words: [] }] });
  assert.equal(pickByConfidence({ lang: 'ru', res: mk(-0.2) }, { lang: 'en', res: mk(-0.9) }).lang, 'ru');
  assert.equal(pickByConfidence({ lang: 'ru', res: mk(-1.1) }, { lang: 'en', res: mk(-0.4) }).lang, 'en');
  assert.ok(confidence(mk(-0.5)) === -0.5);
});

import { applyCorrection, buildCorrectionMessages } from '../src/core/correct.ts';

test('LLM correction keeps timings, drops junk, rejects bad answers', () => {
  const w = [{ word: 'Ветер', start: 20, end: 20.5, prob: 1 }];
  const lines = [
    { start: 12, end: 15, text: 'Огни вечерного горада', words: [] },
    { start: 20, end: 23, text: 'Ветер поёт в проводах', words: w },
    { start: 24, end: 25, text: 'Pertama kali ini', words: [] },
  ];
  const ok = applyCorrection(
    lines,
    JSON.stringify({ lines: [{ text: 'Огни вечернего города' }, { text: 'Ветер поёт в проводах.' }, { text: '', drop: true }] }),
  )!;
  assert.deepEqual(ok.map((l) => [l.start, l.text]), [[12, 'Огни вечернего города'], [20, 'Ветер поёт в проводах.']]);
  assert.equal(ok[1]!.words.length, 1); // по сути не изменилась — слова сохранены
  assert.equal(applyCorrection(lines, JSON.stringify({ lines: [{ text: 'x' }] })), null); // другое число строк
  assert.equal(applyCorrection(lines, 'not json'), null);
  const many = Array.from({ length: 5 }, (_, i) => ({ start: i, end: i + 1, text: `строка ${i}`, words: [] }));
  assert.equal(applyCorrection(many, JSON.stringify({ lines: many.map(() => ({ drop: true })) })), null);
  const msgs = buildCorrectionMessages(lines, { title: 'Night Drive', artist: 'Test Artist' });
  assert.ok(msgs[0]!.content.includes('json') && JSON.parse(msgs[1]!.content).lines.length === 3);
});

import { classifyCaptureError } from '../src/core/errors.ts';

test('classifyCaptureError', () => {
  assert.equal(classifyCaptureError(new Error('Cannot capture a tab with an active stream.')), 'busy');
  assert.equal(classifyCaptureError('Error: Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.'), 'notAllowed');
  assert.equal(classifyCaptureError(new Error('HTTP 500')), 'other');
});

test('correction prompt includes the alternative transcription when given', () => {
  const lines = [{ text: 'Огни вечерного горада' }];
  const withAlt = buildCorrectionMessages(lines, { title: 'T', artist: 'A', alternative: 'Огни вечернего города' });
  assert.ok(withAlt[0]!.content.includes('alternative'));
  assert.equal(JSON.parse(withAlt[1]!.content).alternative, 'Огни вечернего города');
  const without = buildCorrectionMessages(lines, { title: 'T', artist: 'A' });
  assert.ok(!('alternative' in JSON.parse(without[1]!.content)));
});

import { fromAudioShakeJson, fromSrt } from '../src/core/audioshake.ts';

test('AudioShake: lines with words (seconds)', () => {
  const j = { lines: [
    { text: 'Огни вечернего города', start: 12.5, end: 15, words: [{ text: 'Огни', start: 12.5, end: 13 }, { text: 'вечернего', start: 13.1, end: 14 }, { text: 'города', start: 14.1, end: 15 }] },
    { text: 'Я снова иду домой', start: 16, end: 19, words: [{ text: 'Я', start: 16, end: 16.3 }, { text: 'снова', start: 16.4, end: 17 }] },
  ] };
  const r = fromAudioShakeJson(j)!;
  assert.deepEqual(r.segments.map((s) => [s.start, s.text, s.words.length]), [[12.5, 'Огни вечернего города', 3], [16, 'Я снова иду домой', 2]]);
});

test('AudioShake: flat words in milliseconds are grouped into lines', () => {
  const j = { result: { words: [
    { word: 'Ветер', startMs: 20000, endMs: 20400 }, { word: 'поёт', startMs: 20500, endMs: 21000 },
    { word: 'Тихо', startMs: 24000, endMs: 24400 }, { word: 'шумит', startMs: 24500, endMs: 25000 },
  ] } };
  const r = fromAudioShakeJson(j, 185)!;
  assert.deepEqual(r.segments.map((s) => [s.start, s.text]), [[20, 'Ветер поёт'], [24, 'Тихо шумит']]);
});

test('AudioShake: SRT fallback and junk', () => {
  const srt = '1\n00:00:12,500 --> 00:00:15,000\nОгни вечернего города\n\n2\n00:00:16,000 --> 00:00:19,200\nЯ снова иду домой\n';
  assert.deepEqual(fromSrt(srt)!.segments.map((s) => [s.start, s.end, s.text]), [[12.5, 15, 'Огни вечернего города'], [16, 19.2, 'Я снова иду домой']]);
  assert.equal(fromSrt('nothing here'), null);
  assert.equal(fromAudioShakeJson({ foo: 1 }), null);
});

import { isPromptEcho, parseCustomWords, vocabPrompt, glossaryFor } from '../src/core/vocab.ts';

test('vocab prompt: custom words first, budget, title last', () => {
  const p = buildPrompt({ title: 'Night Drive', artist: 'Test' }, 'ru', { uncensored: true, slang: true, custom: 'Скриптонит; Кизару\nбосс' });
  assert.ok(p.startsWith('Test, Night Drive, Скриптонит, Кизару, босс, блять, бля, флекс'));
  assert.ok(p.length <= 460, `длина ${p.length}`);
  assert.ok(vocabPrompt('en', { slang: true }).startsWith('drip, flex'));
  assert.equal(vocabPrompt('ru', {}), '');
  assert.deepEqual(parseCustomWords(' a, ,b;c\n'), ['a', 'b', 'c']);
  assert.ok(glossaryFor({ slang: true, uncensored: true }).length > 150);
});

test('prompt-echo filter', () => {
  assert.equal(isPromptEcho('блять, сука, нахуй, флекс, вайб'), true);
  assert.equal(isPromptEcho('drip, flex, ice, opps, cap'), true);
  assert.equal(isPromptEcho('Без цензуры: блять'), true);
  assert.equal(isPromptEcho('Я иду по городу, и мне похуй на дождь'), false);
  assert.equal(isPromptEcho('Флекс, вайб и движ — это мы на районе'), false);
});

test('correction prompt includes glossary', () => {
  const m = buildCorrectionMessages([{ text: 'x' }], { title: 'T', artist: 'A', glossary: ['флекс', 'вайб'] });
  assert.ok(m[0]!.content.includes('glossary'));
  assert.equal(JSON.parse(m[1]!.content).glossary, 'флекс, вайб');
});

test('positionAt extrapolates slightly before the first anchor', () => {
  const c = new PlaybackClock();
  c.updateExact(0.5, true, 10000);
  c.setRate(2, 10000);
  c.updateExact(0.5, true, 10000);
  assert.ok(Math.abs(c.positionAt(9900)! - 0.4) < 0.11);
  assert.equal(c.positionAt(5000), null); // слишком давно — неизвестно
});

import { dropTitleEcho, isTitleEcho } from '../src/core/filter.ts';

test('title/artist mentions are removed, a sung chorus with the title is kept', () => {
  const hint = { title: 'Night Drive', artist: 'Test Artist' };
  assert.equal(isTitleEcho('Текст песни «Night Drive»', hint), true);
  assert.equal(isTitleEcho('Night Drive — Test Artist', hint), true);
  assert.equal(isTitleEcho('Test Artist', hint), true);
  assert.equal(isTitleEcho('Мы едем в night drive до утра', hint), false);
  const L = (text: string) => ({ start: 0, end: 1, text, words: [] });
  // Одиночная строка-название — убираем; повторяющаяся (припев) — оставляем.
  assert.deepEqual(dropTitleEcho([L('Night Drive'), L('Огни за окном'), L('Дорога в ночь')], hint).map((l) => l.text), ['Огни за окном', 'Дорога в ночь']);
  assert.equal(dropTitleEcho([L('Night drive!'), L('Огни за окном'), L('Night drive!')], hint).length, 3);
});

import { highPass, toAsrPcm } from '../src/core/audio.ts';

test('highPass removes bass and keeps voice band', () => {
  const sr = 16000;
  const tone = (f: number) => Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * f * i) / sr));
  const rms = (x: Float32Array) => Math.sqrt(x.slice(sr / 2).reduce((s, v) => s + v * v, 0) / (sr / 2));
  assert.ok(rms(highPass(tone(40), sr, 120)) < 0.15); // бочка/бас: −17 дБ и больше
  assert.ok(rms(highPass(tone(1000), sr, 120)) > 0.69); // голос: почти без изменений
});

test('toAsrPcm normalizes quiet audio but limits gain', () => {
  const quiet = Float32Array.from({ length: 48000 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 1000 * i) / 48000));
  const out = toAsrPcm(quiet, 48000);
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0) / 32768;
  assert.ok(peak > 0.8 && peak < 0.95, `peak ${peak}`);
  const silent = toAsrPcm(new Float32Array(48000), 48000);
  assert.equal(silent.reduce((m, v) => Math.max(m, Math.abs(v)), 0), 0);
});

import { extractGeniusLyrics, geniusHits, hasTimings, kugouCandidates, kugouLrc, neteaseLrc, neteaseSongs, normName, strictMatch } from '../src/core/providers.ts';
import { metaFromHtml, metaFromPath } from '../src/core/meta.ts';
import { alignLyrics } from '../src/core/align.ts';

test('strictMatch: title must match, artist or duration confirms; Cyrillic ↔ Latin', () => {
  assert.ok(strictMatch({ title: 'Ночной город', artist: 'Тестер' }, { title: 'Ночной город', artist: 'Тестер' }) > 0);
  assert.ok(strictMatch({ title: 'Ночной город', artist: 'Тестер' }, { title: 'Nochnoy gorod', artist: 'Tester' }) > 0); // транслит
  assert.ok(strictMatch({ title: 'Song For Love (feat. Someone)', artist: 'okishslay3r' }, { title: 'Song for Love', artist: 'Okishslay3r & Someone' }) > 0);
  assert.equal(strictMatch({ title: 'Ночной город', artist: 'Тестер' }, { title: 'Ночной город', artist: 'Другой' }), 0); // чужой исполнитель
  assert.ok(strictMatch({ title: 'Ночной город', artist: 'Тестер', duration: 200 }, { title: 'Ночной город', artist: 'Другой', duration: 202 }) > 0);
  assert.equal(strictMatch({ title: 'Ночной город', artist: 'Тестер' }, { title: 'Дневной лес', artist: 'Тестер' }), 0);
  assert.equal(normName('Ёлка (prod. X)'), 'elka');
});

test('Genius: hits and lyrics extraction', () => {
  const hits = geniusHits({ response: { sections: [{ hits: [{ result: { url: 'https://genius.com/Tester-nochnoy-gorod-lyrics', title: 'Ночной город', artist_names: 'Тестер' } }, { result: { url: 'https://genius.com/artists/Tester' } }] }] } });
  assert.equal(hits.length, 1);
  const html = '<div class="x"><div data-lyrics-container="true">[Куплет 1]<br/>Первая строка<br><a href="#">Вторая &amp; строка</a><div data-exclude-from-selection="true">ads</div></div></div><div data-lyrics-container="true">[Припев]<br>Третья строка</div>';
  assert.equal(extractGeniusLyrics(html), 'Первая строка\nВторая & строка\n\nТретья строка'); // пустая строка — граница куплетов
});

test('NetEase and Kugou parsing', () => {
  const songs = neteaseSongs({ result: { songs: [{ id: 7, name: 'Night City', artists: [{ name: 'Tester' }], duration: 201000 }] } });
  assert.deepEqual(songs, [{ id: 7, name: 'Night City', artist: 'Tester', duration: 201 }]);
  const lrc = '[ti:Night City]\n[00:01.00] 作词 : Someone\n[00:05.00]Line one\n[00:09.00]Line two\n[00:13.00]Line three';
  assert.equal(neteaseLrc({ lrc: { lyric: lrc } }), '[00:05.00]Line one\n[00:09.00]Line two\n[00:13.00]Line three');
  assert.equal(neteaseLrc({ nolyric: true }), '');
  assert.ok(hasTimings(neteaseLrc({ lrc: { lyric: lrc } })));
  assert.ok(!hasTimings('[00:00.00] всё одной строкой'));
  const c = kugouCandidates({ candidates: [{ id: 1, accesskey: 'k', song: 'Night City', singer: 'Tester', duration: 201000 }] });
  assert.equal(c[0]!.duration, 201);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode('[00:05.00]Строка один\n[00:09.00]Строка два')));
  assert.equal(kugouLrc({ content: b64 }), '[00:05.00]Строка один\n[00:09.00]Строка два');
});

test('track meta from page HTML and from the link', () => {
  const html = '<html><head><title>Song For Love (feat. Kid) by okishslay3r | Listen online for free on SoundCloud</title><meta property="og:image" content="https://i1.sndcdn.com/artworks-x-t500x500.jpg"></head><script>{"duration":201345}</script></html>';
  assert.deepEqual(metaFromHtml(html), { title: 'Song For Love (feat. Kid)', uploader: 'okishslay3r', artwork: 'https://i1.sndcdn.com/artworks-x-t500x500.jpg', duration: 201 });
  const og = '<meta property="og:title" content="Ночной &amp; город"><meta name="twitter:audio:artist_name" content="Тестер">';
  assert.equal(metaFromHtml(og)!.title, 'Ночной & город');
  assert.equal(metaFromHtml(og)!.uploader, 'Тестер');
  assert.deepEqual(metaFromPath('/okishslay3r/song-for-love-feat-kinderlil'), { title: 'song for love feat kinderlil', uploader: 'okishslay3r', artwork: null, duration: null });
});

test('alignLyrics: real lyrics get timings from recognition', () => {
  const ref = ['Огни ночного города горят', 'Я еду сквозь туман один', 'Новая строка без пары', 'И снова утро впереди'];
  // распознавание с ошибками: «горять», пропущено слово, «щас» и т.п.; третьей строки модель не услышала
  const w = (word: string, start: number) => ({ word, start, end: start + 0.4, prob: 0.9 });
  const rec = [
    { start: 10, end: 12, text: 'огни ночного города горять', words: [w('огни', 10), w('ночного', 10.5), w('города', 11), w('горять', 11.5)] },
    { start: 14, end: 16, text: 'я еду сквозь туман', words: [w('я', 14), w('еду', 14.4), w('сквозь', 14.9), w('туман', 15.4)] },
    { start: 22, end: 24, text: 'и снова утро впереди', words: [w('и', 22), w('снова', 22.4), w('утро', 22.9), w('впереди', 23.4)] },
  ];
  const al = alignLyrics(ref, rec)!;
  assert.ok(al && al.matched > 0.6, `matched ${al?.matched}`);
  assert.deepEqual(al.lines.map((l) => l.text), ref); // текст — из готового источника
  assert.ok(Math.abs(al.lines[0]!.start - 10) < 0.01);
  assert.ok(Math.abs(al.lines[1]!.start - 14) < 0.01);
  assert.ok(al.lines[2]!.start >= al.lines[1]!.end - 0.01 && al.lines[2]!.end <= 22.01); // между соседями
  assert.ok(Math.abs(al.lines[3]!.start - 22) < 0.01);
  assert.equal(al.lines[0]!.words!.length, 4);
  // чужая песня — не подгоняем
  assert.equal(alignLyrics(['совсем другие слова здесь'], rec), null);
});

import { groqEndpoint } from '../src/core/config.ts';

test('groqEndpoint: own key goes direct, no key and no proxy → null', () => {
  assert.deepEqual(groqEndpoint({ apiUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_x' }), {
    url: 'https://api.groq.com/openai/v1',
    headers: { Authorization: 'Bearer gsk_x' },
    viaProxy: false,
  });
  assert.equal(groqEndpoint({ apiUrl: 'https://api.groq.com/openai/v1', apiKey: '' }), null); // в тестах посредник не вшит
});

test('pruneCache keeps pinned lyrics beyond the limit', () => {
  const map: Record<string, { createdAt: number; pinned?: boolean }> = {};
  for (let i = 0; i < 10; i++) map[`t${i}`] = { createdAt: i };
  map.t0!.pinned = true; // самый старый, но закреплён
  const out = pruneCache(map, 3);
  assert.deepEqual(Object.keys(out).sort(), ['t0', 't7', 't8', 't9']);
});

import { estimateTimings } from '../src/core/lyrics.ts';

test('estimateTimings spreads lines over the track with intro/outro padding', () => {
  const l = estimateTimings(['Короткая', 'Строка подлиннее, чем первая', '', 'Ещё одна строка'], 200);
  assert.equal(l.length, 3);
  assert.ok(l[0]!.start >= 3 && l[0]!.start <= 15);
  assert.ok(l[2]!.end <= 200 - 3);
  assert.ok(l[1]!.end - l[1]!.start > l[0]!.end - l[0]!.start); // длиннее строка — дольше
  for (let i = 1; i < l.length; i++) assert.ok(l[i]!.start >= l[i - 1]!.end);
  assert.deepEqual(estimateTimings(['a'], 0), []);
});

test('trackUrlFromHtml: адрес трека из страницы короткой ссылки', async () => {
  const { trackUrlFromHtml } = await import('../src/core/link.ts');
  assert.deepEqual(trackUrlFromHtml('<head><link rel="canonical" href="https://soundcloud.com/Artist/Song-Name"></head>'), {
    url: 'https://soundcloud.com/Artist/Song-Name',
    path: '/artist/song-name',
  });
  assert.deepEqual(trackUrlFromHtml('<meta property="og:url" content="https://soundcloud.com/a/b?si=1">')?.path, '/a/b');
  assert.equal(trackUrlFromHtml('<html>no</html>'), null);
});
