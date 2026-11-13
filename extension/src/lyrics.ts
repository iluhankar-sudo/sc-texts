/**
 * Ready lyrics lookup for a track (runs in the background script):
 * metadata from SoundCloud's official oEmbed (or the track page), lyrics from the open LRCLIB database
 * and additional sources (Genius, NetEase, Kugou - see providers.ts).
 */
import { pruneCache, trackKey, type CachedResult } from './core/cache.ts';
import { guessArtistTrack, parseLrc, pickBest, plainToLines, type LrcRecord } from './core/lyrics.ts';
import { metaFromHtml, metaFromPath } from './core/meta.ts';
import { genius, kugou, netease, providerLog, type ProviderHit, type Want } from './providers.ts';
export { providerLog };

const LRCLIB = 'https://lrclib.net/api';
const CLIENT = 'sc texts/0.1 (personal browser extension)';

const REQUEST_TIMEOUT_MS = 3500;
/** LRCLIB didn't answer any request - leave it alone for a while. */
const DOWN_PAUSE_MS = 5 * 60 * 1000;
let lrclibDownUntil = 0;
let answered = 0; // how many LRCLIB requests got an answer in the current lookup

async function getJson<T>(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Lrclib-Client': CLIENT } });
    answered++;
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), ms));

export interface TrackMeta {
  title: string;
  uploader: string | null;
  artwork: string | null;
  duration: number | null;
}

/** A plain GET without extra headers (SoundCloud rejects "foreign" headers). */
async function fetchText(url: string, timeoutMs: number): Promise<{ status: number; text: string } | { error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    return { status: r.status, text: r.ok ? await r.text() : '' };
  } catch (e) {
    return { error: (e as Error)?.name === 'AbortError' ? 'timeout' : String(e).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

/** How the track title was obtained (for the log). */
export let metaNote = '';

/** Title, author and artwork from a link - via SoundCloud's official oEmbed. */
export async function oembedMeta(url: string): Promise<TrackMeta | null> {
  const r = await fetchText(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`, 3500);
  let j: { title?: string; author_name?: string; thumbnail_url?: string } | null = null;
  if ('text' in r && r.text) {
    try {
      j = JSON.parse(r.text);
    } catch {
      j = null;
    }
  }
  metaNote = 'error' in r ? `oEmbed: ${r.error}` : `oEmbed: HTTP ${r.status}`;
  if (!j?.title) return null;
  const uploader = j.author_name ?? null;
  // oEmbed returns "Title by Author" - strip the tail.
  const title = uploader ? j.title.replace(new RegExp(`\\s+by\\s+${uploader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '') : j.title;
  return { title, uploader, artwork: j.thumbnail_url ?? null, duration: null };
}

/**
 * The track title at any cost: oEmbed → track page HTML → the link itself.
 * (In a user's report oEmbed didn't answer, and the ready-lyrics lookup never ran.)
 */
export async function trackMeta(url: string, path: string | null): Promise<TrackMeta | null> {
  const viaOembed = await oembedMeta(url);
  if (viaOembed) {
    metaNote = 'oEmbed';
    return viaOembed;
  }
  const failed = metaNote;
  const page = await fetchText(url, 4000);
  const fromPage = 'text' in page && page.text ? metaFromHtml(page.text) : null;
  if (fromPage) {
    metaNote = `track page (${failed})`;
    return fromPage;
  }
  const fromPath = metaFromPath(path ?? safePath(url));
  metaNote = fromPath ? `from the link (${failed}; page: ${'error' in page ? page.error : `HTTP ${page.status}`})` : `none (${failed})`;
  return fromPath;
}

function safePath(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** Looks up a candidate in LRCLIB: an exact request (if the duration is known) and a search, in parallel. */
async function searchCandidate(c: { artist: string; track: string }, duration: number | null): Promise<LrcRecord | null> {
  const reqs: Promise<LrcRecord[]>[] = [];
  if (duration && c.artist) {
    const qs = new URLSearchParams({ track_name: c.track, artist_name: c.artist, duration: String(Math.round(duration)) });
    reqs.push(getJson<LrcRecord>(`${LRCLIB}/get?${qs}`).then((r) => (r ? [r] : [])));
  }
  const qs = new URLSearchParams(c.artist ? { track_name: c.track, artist_name: c.artist } : { q: c.track });
  reqs.push(getJson<LrcRecord[]>(`${LRCLIB}/search?${qs}`).then((r) => r ?? []));
  if (c.artist) reqs.push(getJson<LrcRecord[]>(`${LRCLIB}/search?${new URLSearchParams({ q: `${c.artist} ${c.track}` })}`).then((r) => r ?? []));
  const lists = await Promise.all(reqs);
  return pickBest(lists.flat(), { ...c, duration });
}

/** How long to wait for all sources together. */
const ALL_DEADLINE_MS = 8000;

/**
 * Looks up ready lyrics in all sources at once (in parallel, no longer than ALL_DEADLINE_MS):
 * LRCLIB, NetEase, Kugou (lyrics with line timings) and Genius (lyrics without timings).
 * Choice: timed lyrics first (LRCLIB → NetEase → Kugou), otherwise untimed ones (Genius → LRCLIB → the rest).
 */
export async function findLyrics(meta: TrackMeta, url: string | null): Promise<CachedResult | null> {
  const candidates = guessArtistTrack(meta.title, meta.uploader).slice(0, 2);
  if (!candidates.length) return null;
  providerLog.length = 0;
  answered = 0;
  const lrclibUp = Date.now() >= lrclibDownUntil;
  const want: Want = { title: candidates[0]!.track, artist: candidates[0]!.artist || meta.uploader, duration: meta.duration };

  let lrc: { rec: LrcRecord; artist: string } | null = null;
  const extra: ProviderHit[] = [];
  let lrclibDone = false;
  let resolveSynced: () => void = () => {};
  const syncedFromLrclib = new Promise<void>((res) => (resolveSynced = res));

  const lrclibTask = (lrclibUp ? Promise.all(candidates.map((c) => searchCandidate(c, meta.duration))) : Promise.resolve([] as (LrcRecord | null)[])).then(
    (res) => {
      lrclibDone = true;
      const idx = res.findIndex((r) => r !== null);
      if (idx >= 0) lrc = { rec: res[idx]!, artist: candidates[idx]?.artist || meta.uploader || '' };
      if (lrclibUp && answered === 0) lrclibDownUntil = Date.now() + DOWN_PAUSE_MS; // the service doesn't answer at all
      providerLog.push(`LRCLIB: ${lrc ? (lrc.rec.syncedLyrics ? 'found, timed' : 'found, untimed') : lrclibUp ? 'not found' : 'skipped (not answering)'}`);
      if (lrc?.rec.syncedLyrics || lrc?.rec.instrumental) resolveSynced(); // it won't get any better - don't wait for the rest
    },
  );
  const tasks = [genius(want), netease(want), kugou(want)].map((p) => p.then((h) => h && extra.push(h)));
  await Promise.race([Promise.all([lrclibTask, ...tasks]), syncedFromLrclib, sleep(ALL_DEADLINE_MS)]);
  if (!lrclibDone) providerLog.push('LRCLIB: did not answer in time');

  const base = { url, title: meta.title, artwork: meta.artwork, createdAt: Date.now() };
  const found = lrc as { rec: LrcRecord; artist: string } | null;
  if (found?.rec.instrumental) return { ...base, artist: found.artist, duration: found.rec.duration ?? meta.duration, lines: [], source: 'lrclib', synced: true };
  if (found?.rec.syncedLyrics) {
    return { ...base, artist: found.artist, duration: found.rec.duration ?? meta.duration, lines: parseLrc(found.rec.syncedLyrics, found.rec.duration), source: 'lrclib', synced: true };
  }
  const by = (src: ProviderHit['source'], synced: boolean) => extra.find((h) => h.source === src && h.synced === synced);
  const syncedHit = by('netease', true) ?? by('kugou', true);
  if (syncedHit) {
    const lines = parseLrc(syncedHit.text, meta.duration);
    if (lines.length >= 3) return { ...base, artist: syncedHit.artist || want.artist, duration: meta.duration, lines, source: syncedHit.source, synced: true };
  }
  const geniusHit = by('genius', false);
  if (geniusHit) return { ...base, artist: geniusHit.artist || want.artist, duration: meta.duration, lines: plainToLines(geniusHit.text), source: 'genius', synced: false };
  if (found?.rec.plainLyrics) {
    return { ...base, artist: found.artist, duration: found.rec.duration ?? meta.duration, lines: plainToLines(found.rec.plainLyrics), source: 'lrclib', synced: false };
  }
  const plainHit = extra.find((h) => h.text);
  if (plainHit) {
    const lines = plainToLines(plainHit.text.replace(/\[[^\]]*\]/g, ''));
    if (lines.length) return { ...base, artist: plainHit.artist || want.artist, duration: meta.duration, lines, source: plainHit.source, synced: false };
  }
  return null;
}

/** Saves the track's lyrics into the shared cache (karaoke uses it too). */
export async function saveFound(path: string, result: CachedResult, setLast: boolean) {
  const r = await chrome.storage.local.get('results');
  const all = (r.results as Record<string, CachedResult> | undefined) ?? {};
  if (all[trackKey(path)]?.pinned) return; // lyrics pinned by the user are left alone
  all[trackKey(path)] = result;
  await chrome.storage.local.set({ results: pruneCache(all), ...(setLast ? { lastResult: result } : {}) });
}
