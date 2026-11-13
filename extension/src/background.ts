import { glossaryFor } from './core/vocab.ts';
/**
 * Service worker: starts/stops link recognition (commands from the popup),
 * keeps the offscreen document and relays messages between the tab and the offscreen document.
 *
 * Link mode: the popup gets the current tab's streamId (allowed by the user's
 * gesture), capture starts, then the tab navigates to the linked track.
 * Tab capture survives the navigation, and the new page's content script
 * asks CONTENT_READY and receives the job.
 *
 * Separate tab (so as not to interrupt the music the user is listening to):
 * QUEUE_LINK opens the track in a new tab and remembers the job (pending).
 * Chrome only allows recording the tab where the user clicked the icon, so
 * the popup opened in that tab starts START_LINK itself, after which the user
 * is returned to their tab. When the track has played through, the recognition tab closes.
 */
import { isSameTrack, parseTrackUrl, trackUrlFromHtml, type TrackLink } from './core/link.ts';
import { groqEndpoint, normalizeConfig } from './core/config.ts';
import type { Config } from './core/types.ts';
import { findLyrics, metaNote, providerLog, saveFound, trackMeta } from './lyrics.ts';
import { installHeaderRules } from './providers.ts';
import { buildCorrectionMessages } from './core/correct.ts';

/** Lyrics correction. Returns the model's raw JSON reply or throws. */
/** Free Groq model for lyrics correction (same as for translation; allowed by the proxy). */
const GROQ_FIX_MODEL = 'llama-3.3-70b-versatile';

/**
 * Fixing misheard words with a language model: DeepSeek if the user set their own key,
 * otherwise free via Groq (own key or the extension's proxy).
 */
async function correctViaDeepSeek(
  lines: { text: string }[],
  meta: { title: string | null; artist: string | null; alternative?: string | null },
): Promise<string> {
  const cfg = normalizeConfig(await chrome.storage.local.get(null));
  const groq = cfg.deepseekKey ? null : groqEndpoint(cfg);
  if (!cfg.deepseekKey && !groq) throw new Error('no key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(cfg.deepseekKey ? 'https://api.deepseek.com/chat/completions' : `${groq!.url}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: cfg.deepseekKey
        ? { Authorization: `Bearer ${cfg.deepseekKey}`, 'Content-Type': 'application/json' }
        : { ...groq!.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.deepseekKey ? cfg.deepseekModel : GROQ_FIX_MODEL,
        temperature: 0,
        max_tokens: cfg.deepseekKey ? 8000 : 4000,
        response_format: { type: 'json_object' },
        messages: buildCorrectionMessages(lines, { ...meta, glossary: glossaryFor({ uncensored: cfg.uncensored, slang: cfg.slang, custom: cfg.customWords }) }),
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    return String(j?.choices?.[0]?.message?.content ?? '');
  } finally {
    clearTimeout(timer);
  }
}

interface CaptureInfo {
  tabId: number;
  mode: 'link';
  url: string | null;
  path: string | null;
  config: Config;
  /** The extension opened this tab - close it when done. */
  ownTab?: boolean;
  /** Track speed-up during recognition. */
  speed: number;
  /** Audio source: tabCapture (icon click) or the page itself (Chrome's sharing prompt). */
  source?: 'tab' | 'page';
}

interface PendingLink {
  tabId: number;
  url: string;
  path: string | null;
  returnTabId: number | null;
}

async function getPending(): Promise<PendingLink | undefined> {
  return (await chrome.storage.session.get('pending')).pending as PendingLink | undefined;
}

/** Opens the track in a separate tab and waits for an icon click there. */
async function queueLink(url: string, path: string | null, returnTabId: number | null) {
  const from = returnTabId !== null ? await chrome.tabs.get(returnTabId).catch(() => null) : null;
  const tab = await chrome.tabs.create({ url, active: true, ...(from ? { index: from.index + 1, windowId: from.windowId } : {}) });
  await chrome.storage.session.set({ pending: { tabId: tab.id!, url, path, returnTabId } satisfies PendingLink });
  // The popup closes when the tab opens - bring the tab to the front just in case.
  await chrome.tabs.update(tab.id!, { active: true }).catch(() => {});
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.action.setBadgeText({ tabId: tab.id!, text: '▶' });
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id!, color: '#ff7a00' });
}

let readyResolver: (() => void) | null = null;

async function getCapture(): Promise<CaptureInfo | undefined> {
  const s = await chrome.storage.session.get('capture');
  return s.capture as CaptureInfo | undefined;
}

async function ensureOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
  if (ctxs.length) return;
  const ready = new Promise<void>((res) => {
    readyResolver = res;
  });
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
    justification: 'Capture tab audio for speech recognition',
  });
  await Promise.race([ready, new Promise((r) => setTimeout(r, 3000))]);
}

async function setBadge(text: string) {
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#c0392b' : '#ff7a00' });
}

async function startCapture(
  tabId: number,
  /** null - the page itself sends the audio (Chrome's sharing prompt), not tabCapture. */
  streamId: string | null,
  opts: { mode: 'link'; url?: string | null; path?: string | null; monitor: boolean; returnTabId?: number | null },
) {
  const pending = await getPending();
  const ownTab = pending?.tabId === tabId;
  if (ownTab) await chrome.storage.session.remove('pending');
  if (await getCapture()) await stopCapture();
  const config = normalizeConfig(await chrome.storage.local.get(null));
  await ensureOffscreen();
  // Speed up only if the track is muted (otherwise the user hears it).
  // 0 - "Auto": the page picks the exact speed once it knows the track duration.
  const speed = opts.monitor ? 1 : config.linkSpeed;
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'START', streamId, config, monitor: opts.monitor, speed: 1 });
  const info: CaptureInfo = { tabId, mode: opts.mode, url: opts.url ?? null, path: opts.path ?? null, config, ownTab, speed, source: streamId ? 'tab' : 'page' };
  await chrome.storage.session.set({ capture: info });
  await setBadge('…');
  // The tab is already on SoundCloud: the track starts inside the site, without navigating to its page
  // (the content script opens the track, starts it in the bottom player and returns to the previous page).
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (opts.path && tab?.url && /^https:\/\/(www\.|m\.)?soundcloud\.com\//.test(tab.url)) {
    const res = await chrome.tabs
      .sendMessage(tabId, { type: 'LINK_START', config, url: opts.url, path: opts.path, speed })
      .catch(() => null);
    if (res?.ok) {
      await setBadge('ON');
      if (ownTab) await chrome.action.setBadgeText({ tabId, text: 'ON' });
      // The user stays in the track's tab (returning them to the previous tab used to get in the way).
      return;
    }
  }
  // Otherwise open the track in this same tab: its content script will ask for the job itself (CONTENT_READY).
  await chrome.tabs.update(tabId, { url: opts.url! });
}

async function stopCapture() {
  const cap = await getCapture();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP' }).catch(() => {});
  if (cap) await chrome.tabs.sendMessage(cap.tabId, { type: 'CAPTURE_STOPPED' }).catch(() => {});
  // Don't close the recognition tab: Chrome would switch to a neighbouring one (with another track).
  if (cap?.ownTab) await chrome.action.setBadgeText({ tabId: cap.tabId, text: '' }).catch(() => {});
  await chrome.storage.session.remove('capture');
  await setBadge('');
  await chrome.offscreen.closeDocument().catch(() => {});
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getCapture())?.tabId === tabId) await stopCapture();
  if ((await getPending())?.tabId === tabId) await chrome.storage.session.remove('pending');
});

function reply(p: Promise<unknown>, sendResponse: (r: unknown) => void) {
  p.then(() => sendResponse({ ok: true })).catch(async (err) => {
    console.error('[SC AI Lyrics]', err);
    await stopCapture();
    await setBadge('!');
    sendResponse({ ok: false, error: String(err).slice(0, 160) });
  });
  return true; // the reply comes asynchronously
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Commands from the extension popup
  if (msg?.type === 'START_LINK') {
    return reply(
      startCapture(msg.tabId, msg.streamId, {
        mode: 'link',
        url: msg.url,
        path: msg.path,
        monitor: !!msg.monitor,
        returnTabId: msg.returnTabId ?? null,
      }),
      sendResponse,
    );
  }
  // Short "Copy link" URL (on.soundcloud.com/...) → full track URL /artist/track.
  if (msg?.type === 'RESOLVE_LINK') {
    resolveShortLink(msg.url)
      .then((link) => sendResponse({ ok: !!link, url: link?.url ?? null, path: link?.path ?? null }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  // Ready lyrics for a link (from the popup): oEmbed → lyrics sources → save as the last result.
  if (msg?.type === 'LOOKUP_LINK') {
    void (async () => {
      const t0 = Date.now();
      const meta = await trackMeta(msg.url, msg.path ?? null);
      const found = meta ? await findLyrics(meta, msg.url) : null;
      if (found && msg.path) await saveFound(msg.path, found, true);
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      const what = !meta
        ? 'no track data'
        : found
          ? `found in ${found.source} (${found.synced ? 'timed' : 'untimed'}, ${found.lines.length} lines)`
          : 'not found';
      const lines = [
        `${new Date().toISOString().slice(11, 19)} ready lyrics lookup: ${what}, ${sec} s`,
        `  title: ${meta ? `"${meta.title}" - ${meta.uploader ?? '?'}` : '-'} (${metaNote})`,
        ...providerLog.map((l) => `  ${l}`),
      ];
      await chrome.storage.local.set({ lookupLog: lines.join('\n') }).catch(() => {});
      sendResponse({ ok: !!found, synced: found?.synced ?? false, lines: found?.lines.length ?? 0 });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
  // Ready lyrics for the playing track (from karaoke on the page).
  if (msg?.type === 'LOOKUP_TRACK') {
    void (async () => {
      const found = await findLyrics(
        { title: msg.title ?? '', uploader: msg.artist ?? null, artwork: msg.artwork ?? null, duration: msg.duration ?? null },
        msg.path ? `https://soundcloud.com${msg.path}` : null,
      );
      if (found && msg.path) await saveFound(msg.path, found, false);
      sendResponse({ ok: !!found });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
  // Fixing recognized lyrics with a language model (from the page or the popup).
  if (msg?.type === 'CORRECT_LYRICS') {
    correctViaDeepSeek(msg.lines ?? [], { title: msg.title ?? null, artist: msg.artist ?? null, alternative: msg.alternative ?? null })
      .then((raw) => sendResponse({ ok: true, raw }))
      .catch((e) => sendResponse({ ok: false, error: String(e).slice(0, 160) }));
    return true;
  }
  // Click on a lyrics line: seek the track to the start of the line.
  if (msg?.type === 'SEEK_LINE') {
    void (async () => {
      let tabId: number | null = msg.tabId ?? null;
      if (tabId === null && msg.path) tabId = (await findTrackTab(msg.path))?.id ?? null;
      if (tabId === null) return sendResponse({ ok: false, reason: 'notOpen' });
      const res = await chrome.tabs.sendMessage(tabId, { type: 'SEEK_TO', path: msg.path ?? null, time: msg.time }).catch(() => null);
      sendResponse(res ?? { ok: false, reason: 'notOpen' });
    })();
    return true;
  }
  if (msg?.type === 'QUEUE_LINK') {
    queueLink(msg.url, msg.path ?? null, msg.returnTabId ?? null)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e).slice(0, 160) }));
    return true;
  }
  if (msg?.type === 'STOP_CAPTURE') {
    stopCapture().then(() => sendResponse({ ok: true }));
    return true;
  }

  // A new page in the capture tab asks what to do
  // 🎤 button in the popup: karaoke for ready lyrics - in the tab with this track, or in a new one.
  if (msg?.type === 'KARAOKE_OPEN') {
    return reply(openKaraoke(String(msg.url), String(msg.path)), sendResponse);
  }

  // "Start recognition" button on the page: the user allowed recording in Chrome's prompt,
  // the page itself will send the audio.
  if (msg?.type === 'PAGE_CAPTURE' && sender.tab?.id !== undefined) {
    const tabId = sender.tab.id;
    return reply(
      (async () => {
        const p = await getPending();
        const link = p?.tabId === tabId ? p : null;
        const url = link?.url ?? msg.url ?? null;
        const path = link?.path ?? msg.path ?? null;
        if (!url || !path) throw new Error('no track for this tab');
        await startCapture(tabId, null, { mode: 'link', url, path, monitor: false });
      })(),
      sendResponse,
    );
  }

  if (msg?.type === 'CONTENT_READY' && sender.tab?.id !== undefined) {
    void Promise.all([getCapture(), chrome.storage.session.get('karaoke')]).then(async ([cap, ks]) => {
      const k = ks.karaoke as { tabId: number; path: string; pending?: boolean } | undefined;
      if (!cap && k?.pending && k.tabId === sender.tab!.id) {
        await chrome.storage.session.set({ karaoke: { tabId: k.tabId, path: k.path } });
        sendResponse({ capture: null, karaoke: { path: k.path } });
        return;
      }
      if (cap && cap.tabId === sender.tab!.id && cap.source === 'page') {
        // The page reloaded - its audio recording was cut off. The job waits for the button again.
        void (async () => {
          await stopCapture();
          if (cap.path && cap.url) await chrome.storage.session.set({ pending: { tabId: cap.tabId, url: cap.url, path: cap.path, returnTabId: null } });
          sendResponse({ capture: null, pending: true });
        })();
        return;
      }
      if (cap && cap.tabId === sender.tab!.id) {
        void setBadge('ON');
        sendResponse({ capture: { mode: cap.mode, url: cap.url, path: cap.path, config: cap.config, speed: cap.speed ?? 1 } });
        return;
      }
      void getPending().then((p) => sendResponse({ capture: null, pending: p?.tabId === sender.tab!.id }));
    });
    return true;
  }

  // CHUNK_RESULT, STATUS, IDLE from offscreen → tab
  if (msg?.target === 'background') {
    if (msg.type === 'OFFSCREEN_READY') {
      readyResolver?.();
      readyResolver = null;
      return;
    }
    void getCapture().then((cap) => {
      if (cap) chrome.tabs.sendMessage(cap.tabId, msg).catch(() => {});
    });
    return;
  }
  // RESET from the content script → offscreen
  if (sender.tab && (msg?.type === 'RESET' || msg?.type === 'FINAL_PASS')) {
    chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }).catch(() => {});
  }
});

// Keyboard shortcut (Alt+Shift+S by default) - same as clicking the icon: Chrome allows
// recording this tab's audio. In a tab opened from a link it starts recognition right away.
chrome.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== 'start-recognition') return;
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const pending = await getPending();
  if (!target?.id || !pending || pending.tabId !== target.id) return;
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.id });
    await startCapture(target.id, streamId, { mode: 'link', url: pending.url, path: pending.path, monitor: false, returnTabId: pending.returnTabId });
  } catch (err) {
    console.error('[sc texts]', err);
    await setBadge('!');
  }
});

// After installing or updating the extension, already open SoundCloud tabs keep the old
// (disconnected) copy of the script. Inject the new one right away so the page needn't be reloaded.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['https://soundcloud.com/*'] }).catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) {
    if (tab.id === undefined || tab.discarded) continue;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-hook.js'], world: 'MAIN' }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  }
});

// Referer header for NetEase (the rule lives until the browser restarts - set it on every start).
void installHeaderRules();

/** Karaoke via the 🎤 button: find a SoundCloud tab with this track (preferably where it is playing), otherwise open it. */
/** SoundCloud tab with this track: playing in the player (3) > paused in the player (2) > its page is open (1). */
async function findTrackTab(path: string): Promise<{ id: number; windowId: number; score: number } | null> {
  const tabs = await chrome.tabs.query({ url: ['https://soundcloud.com/*'] }).catch(() => [] as chrome.tabs.Tab[]);
  let best: { id: number; windowId: number; score: number } | null = null;
  for (const tab of tabs) {
    if (tab.id === undefined || tab.discarded) continue;
    const info = (await chrome.tabs.sendMessage(tab.id, { type: 'PLAYER_INFO' }).catch(() => null)) as { trackId: string | null; playing: boolean } | null;
    const inPlayer = !!info?.trackId && isSameTrack(info.trackId, path);
    const onPage = !!tab.url && parseTrackUrl(tab.url)?.path === path;
    if (!inPlayer && !onPage) continue;
    const score = inPlayer && info!.playing ? 3 : inPlayer ? 2 : 1;
    if (!best || score > best.score) best = { id: tab.id, windowId: tab.windowId, score };
  }
  return best;
}

async function openKaraoke(url: string, path: string): Promise<{ tabId: number; created: boolean }> {
  const best = await findTrackTab(path);
  if (best) {
    await chrome.tabs.sendMessage(best.id, { type: 'KARAOKE_START', path, autoplay: true });
    await chrome.storage.session.set({ karaoke: { tabId: best.id, path } });
    return { tabId: best.id, created: false };
  }
  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.session.set({ karaoke: { tabId: tab.id!, path, pending: true } });
  return { tabId: tab.id!, created: true };
}


/** Resolves a SoundCloud short link: follow the redirect, or read the page if that fails. */
async function resolveShortLink(url: string): Promise<TrackLink | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { redirect: 'follow', credentials: 'omit', signal: ctrl.signal });
    const direct = parseTrackUrl(r.url);
    if (direct?.path) return direct;
    return trackUrlFromHtml(await r.text());
  } catch (e) {
    console.warn('[sc texts] short link:', e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
