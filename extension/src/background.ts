import { glossaryFor } from './core/vocab.ts';
/**
 * Service worker: запускает/останавливает распознавание по ссылке (команды из popup),
 * держит offscreen-документ и пересылает сообщения между вкладкой и offscreen-документом.
 *
 * Режим ссылки: окошко получает streamId текущей вкладки (это разрешено жестом
 * пользователя), захват стартует, затем вкладка переходит на трек по ссылке.
 * Захват вкладки переживает переход, а content script новой страницы
 * спрашивает CONTENT_READY и получает задание.
 *
 * Отдельная вкладка (чтобы не мешать музыке, которую пользователь слушает):
 * QUEUE_LINK открывает трек в новой вкладке и запоминает задание (pending).
 * Chrome даёт записывать только вкладку, где пользователь нажал на иконку, поэтому
 * окошко, открытое в этой вкладке, само запускает START_LINK, после чего пользователя
 * возвращают в его вкладку. Когда трек дослушан, вкладка распознавания закрывается.
 */
import { isSameTrack, parseTrackUrl, trackUrlFromHtml, type TrackLink } from './core/link.ts';
import { normalizeConfig } from './core/config.ts';
import type { Config } from './core/types.ts';
import { findLyrics, metaNote, providerLog, saveFound, trackMeta } from './lyrics.ts';
import { installHeaderRules } from './providers.ts';
import { buildCorrectionMessages } from './core/correct.ts';

/** Исправление текста через DeepSeek. Возвращает сырой JSON-ответ модели или бросает ошибку. */
async function correctViaDeepSeek(
  lines: { text: string }[],
  meta: { title: string | null; artist: string | null; alternative?: string | null },
): Promise<string> {
  const cfg = normalizeConfig(await chrome.storage.local.get(null));
  if (!cfg.deepseekKey) throw new Error('no key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${cfg.deepseekKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.deepseekModel,
        temperature: 0,
        max_tokens: 8000,
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
  /** Вкладку открыло расширение — закрыть её по окончании. */
  ownTab?: boolean;
  /** Ускорение трека при распознавании. */
  speed: number;
  /** Откуда звук: tabCapture (клик по иконке) или со страницы (разрешение в окне Chrome). */
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

/** Открывает трек в отдельной вкладке и ждёт клика по иконке там. */
async function queueLink(url: string, path: string | null, returnTabId: number | null) {
  const from = returnTabId !== null ? await chrome.tabs.get(returnTabId).catch(() => null) : null;
  const tab = await chrome.tabs.create({ url, active: true, ...(from ? { index: from.index + 1, windowId: from.windowId } : {}) });
  await chrome.storage.session.set({ pending: { tabId: tab.id!, url, path, returnTabId } satisfies PendingLink });
  // Окошко расширения закрывается в момент открытия вкладки — на всякий случай выводим её вперёд.
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
  /** null — звук присылает сама страница (разрешение в окне Chrome), а не tabCapture. */
  streamId: string | null,
  opts: { mode: 'link'; url?: string | null; path?: string | null; monitor: boolean; returnTabId?: number | null },
) {
  const pending = await getPending();
  const ownTab = pending?.tabId === tabId;
  if (ownTab) await chrome.storage.session.remove('pending');
  if (await getCapture()) await stopCapture();
  const config = normalizeConfig(await chrome.storage.local.get(null));
  await ensureOffscreen();
  // Ускоряем, только если трек слушается без звука (иначе пользователь его слышит).
  // 0 — «Авто»: точную скорость выберет страница, когда узнает длительность трека.
  const speed = opts.monitor ? 1 : config.linkSpeed;
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'START', streamId, config, monitor: opts.monitor, speed: 1 });
  const info: CaptureInfo = { tabId, mode: opts.mode, url: opts.url ?? null, path: opts.path ?? null, config, ownTab, speed, source: streamId ? 'tab' : 'page' };
  await chrome.storage.session.set({ capture: info });
  await setBadge('…');
  // Вкладка уже на SoundCloud: трек запускается внутри сайта, без перехода на его страницу
  // (content script откроет трек, включит его в нижнем плеере и вернёт прежнюю страницу).
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (opts.path && tab?.url && /^https:\/\/(www\.|m\.)?soundcloud\.com\//.test(tab.url)) {
    const res = await chrome.tabs
      .sendMessage(tabId, { type: 'LINK_START', config, url: opts.url, path: opts.path, speed })
      .catch(() => null);
    if (res?.ok) {
      await setBadge('ON');
      if (ownTab) await chrome.action.setBadgeText({ tabId, text: 'ON' });
      // Пользователь остаётся во вкладке трека (раньше его возвращали в прежнюю вкладку — это мешало).
      return;
    }
  }
  // Иначе открываем трек в этой же вкладке: её content script сам спросит задание (CONTENT_READY).
  await chrome.tabs.update(tabId, { url: opts.url! });
}

async function stopCapture() {
  const cap = await getCapture();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP' }).catch(() => {});
  if (cap) await chrome.tabs.sendMessage(cap.tabId, { type: 'CAPTURE_STOPPED' }).catch(() => {});
  // Вкладку распознавания не закрываем: иначе Chrome переключит на соседнюю (с другим треком).
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
  return true; // ответ придёт асинхронно
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Команды из окошка расширения
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
  // Короткая ссылка «Copy link» (on.soundcloud.com/…) → полный адрес трека /исполнитель/трек.
  if (msg?.type === 'RESOLVE_LINK') {
    resolveShortLink(msg.url)
      .then((link) => sendResponse({ ok: !!link, url: link?.url ?? null, path: link?.path ?? null }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  // Готовый текст по ссылке (из окошка): oEmbed → LRCLIB → сохранить как последний результат.
  if (msg?.type === 'LOOKUP_LINK') {
    void (async () => {
      const t0 = Date.now();
      const meta = await trackMeta(msg.url, msg.path ?? null);
      const found = meta ? await findLyrics(meta, msg.url) : null;
      if (found && msg.path) await saveFound(msg.path, found, true);
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      const what = !meta
        ? 'нет данных о треке'
        : found
          ? `найден в ${found.source} (${found.synced ? 'с таймингами' : 'без таймингов'}, строк ${found.lines.length})`
          : 'не найден';
      const lines = [
        `${new Date().toISOString().slice(11, 19)} поиск готового текста: ${what}, ${sec} с`,
        `  название: ${meta ? `«${meta.title}» — ${meta.uploader ?? '?'}` : '—'} (${metaNote})`,
        ...providerLog.map((l) => `  ${l}`),
      ];
      await chrome.storage.local.set({ lookupLog: lines.join('\n') }).catch(() => {});
      sendResponse({ ok: !!found, synced: found?.synced ?? false, lines: found?.lines.length ?? 0 });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
  // Готовый текст для играющего трека (из караоке на странице).
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
  // Исправление распознанного текста языковой моделью (из страницы или окошка).
  if (msg?.type === 'CORRECT_LYRICS') {
    correctViaDeepSeek(msg.lines ?? [], { title: msg.title ?? null, artist: msg.artist ?? null, alternative: msg.alternative ?? null })
      .then((raw) => sendResponse({ ok: true, raw }))
      .catch((e) => sendResponse({ ok: false, error: String(e).slice(0, 160) }));
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

  // Новая страница во вкладке захвата спрашивает, что делать
  // Кнопка 🎤 в окошке: караоке для готового текста — во вкладке, где этот трек, или в новой.
  if (msg?.type === 'KARAOKE_OPEN') {
    return reply(openKaraoke(String(msg.url), String(msg.path)), sendResponse);
  }

  // Кнопка «Начать распознавание» на странице: пользователь разрешил запись в окне Chrome,
  // звук пришлёт сама страница.
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
        // Страница перезагрузилась — её запись звука оборвалась. Задание снова ждёт кнопки.
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

  // CHUNK_RESULT, STATUS, IDLE из offscreen → вкладка
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
  // RESET из content script → offscreen
  if (sender.tab && (msg?.type === 'RESET' || msg?.type === 'FINAL_PASS')) {
    chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }).catch(() => {});
  }
});

// Сочетание клавиш (по умолчанию Alt+Shift+S) — то же, что клик по иконке: Chrome разрешает
// записывать звук этой вкладки. Во вкладке, открытой по ссылке, сразу запускает распознавание.
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

// После установки или обновления расширения уже открытые вкладки SoundCloud остаются со старой
// (отключённой) копией скрипта. Подключаем новую сразу, чтобы не нужно было обновлять страницу.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['https://soundcloud.com/*'] }).catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) {
    if (tab.id === undefined || tab.discarded) continue;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-hook.js'], world: 'MAIN' }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  }
});

// Заголовок Referer для NetEase (правило живёт до перезапуска браузера — ставим при каждом старте).
void installHeaderRules();

/** Караоке по кнопке 🎤: ищем вкладку SoundCloud с этим треком (лучше — где он уже играет), иначе открываем его. */
async function openKaraoke(url: string, path: string): Promise<{ tabId: number; created: boolean }> {
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
  if (best) {
    await chrome.tabs.sendMessage(best.id, { type: 'KARAOKE_START', path, autoplay: true });
    await chrome.storage.session.set({ karaoke: { tabId: best.id, path } });
    return { tabId: best.id, created: false };
  }
  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.session.set({ karaoke: { tabId: tab.id!, path, pending: true } });
  return { tabId: tab.id!, created: true };
}


/** Раскрывает короткую ссылку SoundCloud: идём по перенаправлению, при неудаче читаем страницу. */
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
