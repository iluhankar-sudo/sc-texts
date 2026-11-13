/**
 * Additional ready-lyrics sources (background script): Genius, NetEase, Kugou.
 * Unofficial site endpoints - for personal use; any of them may stop responding,
 * so each request has a short timeout, and a failing source is simply skipped.
 */
import {
  extractGeniusLyrics,
  geniusHits,
  hasTimings,
  kugouCandidates,
  kugouLrc,
  neteaseLrc,
  neteaseSongs,
  strictMatch,
} from './core/providers.ts';

export interface Want {
  title: string;
  artist: string | null;
  duration: number | null;
}

export interface ProviderHit {
  source: 'genius' | 'netease' | 'kugou';
  /** LRC with timings or plain text. */
  text: string;
  synced: boolean;
  title: string;
  artist: string;
}

/** Log: what each source answered. */
export const providerLog: string[] = [];
const note = (s: string) => providerLog.push(s);

async function get(url: string, timeoutMs: number, as: 'json' | 'text' = 'json'): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return as === 'json' ? await r.json() : await r.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function genius(w: Want): Promise<ProviderHit | null> {
  try {
    const q = `${w.artist ?? ''} ${w.title}`.trim();
    let hits = geniusHits(await get(`https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`, 4000));
    if (!hits.length) hits = geniusHits(await get(`https://genius.com/api/search/song?q=${encodeURIComponent(q)}`, 4000));
    const ranked = hits
      .map((h) => ({ h, score: strictMatch(w, { title: h.title, artist: h.artist }) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0]?.h;
    if (!best) {
      note(`Genius: no matches (${hits.length} results)`);
      return null;
    }
    const html = (await get(best.url, 5000, 'text')) as string;
    const text = extractGeniusLyrics(html);
    if (!text) {
      note(`Genius: page without lyrics (${best.url})`);
      return null;
    }
    note(`Genius: found "${best.artist} - ${best.title}"`);
    return { source: 'genius', text, synced: false, title: best.title, artist: best.artist };
  } catch (e) {
    note(`Genius: ${String(e).slice(0, 80)}`);
    return null;
  }
}

export async function netease(w: Want): Promise<ProviderHit | null> {
  try {
    const q = `${w.title} ${w.artist ?? ''}`.trim();
    const songs = neteaseSongs(await get(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=8`, 4000));
    const ranked = songs
      .map((s) => ({ s, score: strictMatch(w, { title: s.name, artist: s.artist, duration: s.duration }) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0]?.s;
    if (!best) {
      note(`NetEase: no matches (${songs.length} results)`);
      return null;
    }
    const lrc = neteaseLrc(await get(`https://music.163.com/api/song/lyric?id=${best.id}&lv=1&kv=1&tv=-1`, 4000));
    if (!lrc) {
      note('NetEase: the song has no lyrics');
      return null;
    }
    const synced = hasTimings(lrc);
    note(`NetEase: found "${best.artist} - ${best.name}"${synced ? ', timed' : ''}`);
    return { source: 'netease', text: lrc, synced, title: best.name, artist: best.artist };
  } catch (e) {
    note(`NetEase: ${String(e).slice(0, 80)}`);
    return null;
  }
}

export async function kugou(w: Want): Promise<ProviderHit | null> {
  try {
    const kw = `${w.artist ?? ''} - ${w.title}`;
    const dur = w.duration ? Math.round(w.duration * 1000) : '';
    const cands = kugouCandidates(
      await get(`http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(kw)}&duration=${dur}&hash=`, 4000),
    );
    const ranked = cands
      .map((c) => ({ c, score: strictMatch(w, { title: c.song, artist: c.singer, duration: c.duration }) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0]?.c;
    if (!best) {
      note(`Kugou: no matches (${cands.length} results)`);
      return null;
    }
    const lrc = kugouLrc(
      await get(`http://lyrics.kugou.com/download?ver=1&client=pc&id=${best.id}&accesskey=${best.accesskey}&fmt=lrc&charset=utf8`, 4000),
    );
    if (!lrc) {
      note('Kugou: empty lyrics');
      return null;
    }
    const synced = hasTimings(lrc);
    note(`Kugou: found "${best.singer} - ${best.song}"${synced ? ', timed' : ''}`);
    return { source: 'kugou', text: lrc, synced, title: best.song, artist: best.singer };
  } catch (e) {
    note(`Kugou: ${String(e).slice(0, 80)}`);
    return null;
  }
}

/**
 * NetEase only answers requests "from its own site" (the Referer header). An extension can't
 * set it in fetch directly - so a declarativeNetRequest rule sets it for music.163.com.
 */
export async function installHeaderRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [163],
      addRules: [
        {
          id: 163,
          priority: 1,
          action: {
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: [{ header: 'Referer', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: 'https://music.163.com/' }],
          },
          condition: {
            requestDomains: ['music.163.com'],
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
          },
        },
      ],
    });
  } catch (e) {
    console.warn('[sc texts] NetEase header rule:', e);
  }
}
