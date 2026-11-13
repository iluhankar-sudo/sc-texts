/**
 * Окошко под иконкой расширения.
 * Распознавание — только по ссылке: расширение открывает трек, беззвучно слушает
 * его до конца и сохраняет текст. 🎤 в шапке включает караоке: сохранённый текст
 * подсвечивается синхронно с плеером, без захвата звука и без распознавания.
 */
import { normalizeConfig } from './core/config.ts';
import { baseLang, detectScriptLang, langName } from './core/lang.ts';
import { isSameTrack, parseTrackUrl } from './core/link.ts';
import { editorLines, retimeEdited } from './core/edit.ts';
import { translateLines } from './translate.ts';
import { classifyCaptureError } from './core/errors.ts';
import { applyCorrection } from './core/correct.ts';
import { pruneCache, trackKey } from './core/cache.ts';
import { activeIndex } from './core/sync.ts';
import { dropTitleEcho } from './core/filter.ts';
import type { PanelState, SavedResult } from './content/controller.ts';
import { applyI18n, t, uiLang } from './core/i18n.ts';


applyI18n();

const SOURCE_NAMES: Record<string, string> = { lrclib: 'LRCLIB', genius: 'Genius', netease: 'NetEase', kugou: 'Kugou' };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const bgEl = $('bg');
const artEl = $('art');
const titleEl = $('title');
const artistEl = $('artist');
const toggle = $<HTMLButtonElement>('toggle');
const form = $<HTMLFormElement>('form');
const urlInput = $<HTMLInputElement>('url');
const soundBtn = $<HTMLButtonElement>('sound');
const goBtn = $<HTMLButtonElement>('go');
const progressEl = $('progress');
const barEl = $('bar');
const ptimeEl = $('ptime');
const statusEl = $('status');
const listEl = $('list');
const copyBtn = $<HTMLButtonElement>('copy');
const copyTip = $('copyTip');
const pinBtn = $<HTMLButtonElement>('pin');
const karaokeBtn = $<HTMLButtonElement>('karaoke');
const karaokeTip = $('karaokeTip');
/** Вкладка, где идёт караоке, запущенное кнопкой 🎤. */
let karaokeTabId: number | null = null;
const pinTip = $('pinTip');
const editBtn = $<HTMLButtonElement>('edit');
const editorEl = $<HTMLTextAreaElement>('editor');
const editActions = $('editActions');
let editing = false;
const correctBtn = $<HTMLButtonElement>('correct');
let hasDeepseek = false;
let forceScan = false; // «Распознать по звуку»: не искать готовый текст
const translateBtn = $<HTMLButtonElement>('translate');
const translateLabel = $('translateLabel');
let viewTexts: string[] = []; // строки, которые сейчас на экране

const ICON_MIC =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const ICON_MUTED =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>';
const ICON_SOUND =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';

let activeTab: chrome.tabs.Tab | undefined;
let captureTabId: number | null = null;
let state: PanelState | null = null;
let result: SavedResult | null = null;
let monitor = false;
let busy = false;
let note = ''; // разовое сообщение (ошибка, «Скопировано»)
let noteIsError = false;
let lastKey = '';
let lastArt: string | null | undefined;
let lastTarget = -2;
let orphanSince: number | null = null; // запись числится, а вкладка не отвечает — с какого момента
let basePos: number | null = null; // позиция из последнего опроса
let baseAt = 0; // performance.now() момента опроса
let karaokeLines: { start: number; end: number; words: { start: number }[] }[] = [];
let lastOn = -2;

// Перевод
const target = baseLang(navigator.language);
const targetName = langName(target, uiLang());
let translateOn = false;
let translations = new Map<string, string>();
const failed = new Set<string>();
let trBusy = false;
let trStatus = '';
let trVersion = 0;

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0')}`;
const isSC = (url?: string) => !!url && /^https:\/\/(www\.|m\.)?soundcloud\.com\//.test(url);

function setNote(text: string, isError = false) {
  note = text;
  noteIsError = isError;
}

function emptyView(key: string, title: string, text: string) {
  if (lastKey === key) return;
  lastKey = key;
  lastTarget = -2;
  const d = document.createElement('div');
  d.className = 'empty';
  const b = document.createElement('b');
  b.textContent = title;
  const p = document.createElement('div');
  p.textContent = text;
  d.append(b, p);
  listEl.replaceChildren(d);
}

interface ViewLine {
  start: number;
  end: number;
  text: string;
  words?: { word: string; start: number }[];
  chorus?: boolean;
}

/** Длинные тире (— и –) в тексте песни заменяем обычным дефисом. */
function dashes(s: string): string {
  return s.replace(/[\u2014\u2013\u2012\u2015]/g, '-');
}

/** Можно ли перематывать трек кликом по строке (есть время строк и сейчас не идёт распознавание). */
let seekable = false;

function renderLines(baseKey: string, lines: ViewLine[], intro: boolean, karaoke: boolean) {
  listEl.classList.toggle('karaoke', karaoke);
  listEl.classList.toggle('seekable', seekable);
  viewTexts = lines.map((l) => l.text);
  const key = `${baseKey}|tr:${translateOn ? trVersion : 'off'}`;
  if (key === lastKey) return;
  lastKey = key;
  lastTarget = -2;
  lastOn = -2;
  const nodes: HTMLElement[] = [];
  if (intro) {
    const n = document.createElement('div');
    n.className = 'line note';
    n.textContent = '♪';
    nodes.push(n);
  }
  lines.forEach((l, idx) => {
    const d = document.createElement('div');
    d.className = 'line';
    d.dataset.t = String(l.start);
    // Припев: найденные повторы помечаются, у первой строки каждого припева — подпись.
    if (l.chorus) {
      d.classList.add('chorus');
      if (!lines[idx - 1]?.chorus) {
        d.classList.add('chorusStart');
        d.dataset.label = t('chorusLabel');
      }
    }
    const words = karaoke ? (l.words ?? []).filter((w) => w.word) : [];
    if (words.length) {
      words.forEach((w, i) => {
        const sp = document.createElement('span');
        sp.className = 'w';
        sp.textContent = (i ? ' ' : '') + dashes(w.word);
        d.append(sp);
      });
    } else {
      d.textContent = dashes(l.text);
      if (karaoke) d.classList.add('plain');
    }
    const tr = translateOn ? translations.get(l.text) : undefined;
    if (tr && tr.toLowerCase() !== l.text.toLowerCase()) {
      const t = document.createElement('div');
      t.className = 'tr';
      t.textContent = dashes(tr);
      d.append(t);
    }
    nodes.push(d);
  });
  listEl.replaceChildren(...nodes);
  karaokeLines = karaoke ? lines.map((l) => ({ start: l.start, end: l.end, words: (l.words ?? []).filter((w) => w.word) })) : [];
}

/**
 * Прокручивает список так, чтобы строка оказалась на заданной доле высоты окна текста.
 * Положение считаем относительно самого списка: offsetTop отсчитывается от страницы
 * (вместе с шапкой), из-за чего строки уезжали слишком высоко.
 */
function scrollLineTo(el: HTMLElement, frac: number) {
  const y = listEl.scrollTop + el.getBoundingClientRect().top - listEl.getBoundingClientRect().top;
  const top = Math.max(0, Math.round(y - listEl.clientHeight * frac));
  if (Math.abs(top - listEl.scrollTop) > 2) listEl.scrollTo({ top, behavior: 'smooth' });
}

/** Караоке: подсветка текущей строки и спетых слов; вызывается каждый кадр. */
const KARAOKE_LEAD = 0.25;
function karaokeFrame() {
  requestAnimationFrame(karaokeFrame);
  if (!karaokeLines.length || basePos === null || !state?.active) return;
  // Строка загорается чуть раньше первого слова — глазу нужно мгновение, чтобы её прочитать.
  const pos = basePos + (state.playing ? (performance.now() - baseAt) / 1000 : 0) + KARAOKE_LEAD;
  const lines = karaokeLines;
  const idx = activeIndex(lines as never, pos, 1);
  const offset = listEl.firstElementChild?.classList.contains('note') ? 1 : 0;
  if (idx !== lastOn) {
    lastOn = idx;
    for (let i = 0; i < lines.length; i++) {
      const el = listEl.children[i + offset] as HTMLElement | undefined;
      if (!el) continue;
      el.classList.toggle('on', i === idx);
      el.classList.toggle('past', idx >= 0 ? i < idx : lines[i]!.end < pos);
      if (i !== idx) el.querySelectorAll('.w.sung').forEach((w) => w.classList.remove('sung'));
    }
    const intro = offset ? (listEl.children[0] as HTMLElement) : null;
    intro?.classList.toggle('on', idx < 0 && pos < (lines[0]?.start ?? 0));
    const target = idx >= 0 ? idx + offset : pos < (lines[0]?.start ?? 0) ? 0 : -1;
    const el = target >= 0 ? (listEl.children[target] as HTMLElement | undefined) : undefined;
    if (el) scrollLineTo(el, 0.32);
  }
  // Подсвечивается вся текущая строка целиком (без слов по одному).
}

function setHeader(title: string, artist: string, art: string | null) {
  titleEl.textContent = dashes(title);
  artistEl.textContent = dashes(artist);
  if (art !== lastArt) {
    lastArt = art;
    const url = art ? `url("${art.replace(/"/g, '%22')}")` : '';
    artEl.style.backgroundImage = url;
    artEl.textContent = art ? '' : '♪';
    bgEl.style.backgroundImage = url;
    bgEl.classList.toggle('cover', !!art);
  }
}

function render() {
  const active = !!state?.active;
  const linkJob = active && state!.mode === 'link';

  // Шапка
  if (active && (state!.title || linkJob)) {
    setHeader(state!.title ?? t('openingTrack'), state!.artist ?? '', state!.artwork);
  } else if (!active && result) {
    setHeader(result.title ?? t('lastTrack'), result.artist ?? '', result.artwork);
  } else {
    setHeader('sc texts', t('tagline'), null);
  }

  // Кнопка ■ в шапке: только остановка идущего задания (караоке теперь — кнопкой 🎤 внизу).
  toggle.hidden = !active;
  toggle.innerHTML = ICON_STOP;
  toggle.classList.toggle('on', active);
  toggle.disabled = busy;
  const tLabel = active ? t('stop') : t('karaokeForPlaying');
  toggle.title = tLabel;
  toggle.setAttribute('aria-label', tLabel);

  goBtn.disabled = busy || linkJob;
  urlInput.disabled = linkJob;
  soundBtn.innerHTML = monitor ? ICON_SOUND : ICON_MUTED;
  soundBtn.classList.toggle('on', monitor);
  soundBtn.title = monitor ? t('soundOn') : t('soundOff');

  // Прогресс
  const dur = state?.duration ?? null;
  progressEl.hidden = !(linkJob && dur);
  if (linkJob && dur) {
    const pos = Math.min(dur, Math.max(0, state!.pos ?? 0));
    barEl.style.width = `${(pos / dur) * 100}%`;
    ptimeEl.textContent = `${fmt(pos)} / ${fmt(dur)}`;
  }

  // Статус
  let status = note;
  if (!status && active && (linkJob || state!.lines.length > 0)) status = state!.message;
  if (!status && !active && result) {
    const found = result.source && result.source !== 'scan';
    const src = found
      ? t('srcFound', {
          src: SOURCE_NAMES[result.source!] ?? result.source!,
          timing: result.alignedBy === 'audio' ? t('alignedByAudio') : result.synced !== false ? t('synced') : t('notSynced'),
        })
      : result.edited
        ? t('srcEdited')
        : result.engine === 'audioshake'
          ? t('srcAudioshake')
          : result.corrected
            ? t('srcCorrected')
            : t('srcScan');
    status = t('lineCount', { src, n: result.lines.length });
  }
  correctBtn.hidden =
    active || !hasDeepseek || !result || (!!result.source && result.source !== 'scan') || !!result.corrected || result.lines.length === 0;
  correctBtn.disabled = busy;
  if (!status && translateOn) status = trStatus;
  statusEl.textContent = status;
  statusEl.classList.toggle('err', noteIsError || state?.status === 'error');

  // Текст
  copyBtn.hidden = active || !result || result.lines.length === 0;
  // Закреп: текст остаётся за треком, и по этой ссылке больше не нужно искать или распознавать.
  pinBtn.hidden = copyBtn.hidden || !result?.url || !parseTrackUrl(result.url)?.path;
  // ✏️ Правка: только для текстов, распознанных расширением (свои ошибки распознавания).
  editBtn.hidden = pinBtn.hidden || !(!result!.source || result!.source === 'scan' || result!.alignedBy === 'audio');
  const pinned = !!result?.pinned;
  pinBtn.classList.toggle('on', pinned);
  pinTip.textContent = pinned ? t('pinnedTip') : t('pinTip');
  pinBtn.setAttribute('aria-label', pinTip.textContent);
  // 🎤 Караоке: появляется, когда текст готов. Без таймингов — сначала синхронизация по звуку.
  const karaokeOn = active && state!.mode === 'karaoke';
  const hasLyrics = !active && !!result?.url && result.lines.length > 0 && !!parseTrackUrl(result.url)?.path;
  karaokeBtn.hidden = !(karaokeOn || hasLyrics);
  karaokeBtn.classList.toggle('on', karaokeOn);
  karaokeBtn.disabled = busy;
  const needsSync = !karaokeOn && !!result && result.synced === false && result.alignedBy !== 'audio';
  karaokeTip.textContent = karaokeOn ? t('karaokeStopTip') : needsSync ? t('karaokeApproxTip') : t('karaokeTip');
  karaokeBtn.setAttribute('aria-label', karaokeTip.textContent);
  if (!(active && state!.lines.length) && !(!active && result?.lines.length)) viewTexts = [];
  renderTranslateButton();
  if (active) {
    const lines = state!.lines;
    if (lines.length === 0) {
      if (linkJob) return emptyView('wait', '♪', t('waitLink'));
      if (state!.pos === null) return emptyView('k-noplayer', t('karaoke'), t('playInPlayer'));
      return emptyView(
        'k-none',
        t('notRecognized'),
        t('notRecognizedHint'),
      );
    }
    if (!linkJob) {
      // Караоке: синхронная подсветка, позиция интерполируется в karaokeFrame().
      // Текст без таймингов (из LRCLIB) показываем целиком, без подсветки.
      const synced = state!.synced !== false;
      seekable = synced;
      renderLines(`k:${synced}:${lines.map((l) => `${l.start}|${l.text}|${l.chorus ? 1 : 0}`).join('\n')}`, lines, synced, synced);
      return;
    }
    seekable = false;
    renderLines(`a:${lines.map((l) => `${l.start}|${l.text}|${l.chorus ? 1 : 0}`).join('\n')}`, lines, true, false);
    // Прокрутка к последней распознанной строке
    const target = lines.length;
    if (target !== lastTarget) {
      lastTarget = target;
      const el = listEl.children[target] as HTMLElement | undefined;
      if (el) scrollLineTo(el, 0.5);
    }
    return;
  }
  if (result) {
    if (result.lines.length === 0) return emptyView(`r0:${result.createdAt}`, t('noLyricsTitle'), t('noLyricsText'));
    seekable = !!result.url && (result.synced !== false || result.alignedBy === 'audio');
    return renderLines(`r:${result.createdAt}`, result.lines, false, false);
  }
  emptyView(
    'start',
    t('emptyTitle'),
    t('emptyText'),
  );
}

async function refresh() {
  if (editing) return; // не мешаем правке текста
  const s = await chrome.storage.session.get(['capture', 'karaoke']).catch(() => ({}) as Record<string, unknown>);
  const cap = s.capture as { tabId: number } | undefined;
  captureTabId = cap?.tabId ?? null;
  karaokeTabId = (s.karaoke as { tabId: number } | undefined)?.tabId ?? null;
  const tabId = captureTabId ?? karaokeTabId ?? activeTab?.id;
  state = null;
  if (tabId !== undefined && tabId !== null) {
    state = (await chrome.tabs.sendMessage(tabId, { type: 'GET_STATE' }).catch(() => null)) as PanelState | null;
  }
  // Караоке во вкладке закончилось (вкладку закрыли или остановили) — забываем её.
  if (karaokeTabId !== null && !captureTabId && !(state?.active && state.mode === 'karaoke') && !(s.karaoke as { pending?: boolean }).pending) {
    karaokeTabId = null;
    await chrome.storage.session.remove('karaoke').catch(() => {});
    if (tabId !== activeTab?.id && activeTab?.id) state = (await chrome.tabs.sendMessage(activeTab.id, { type: 'GET_STATE' }).catch(() => null)) as PanelState | null;
  }
  // Запись числится, но вкладка давно не отвечает (её перезагрузили, закрыли, сломалась страница) —
  // освобождаем захват, чтобы окошко не «зависло».
  if (captureTabId !== null && !state?.active) {
    orphanSince ??= Date.now();
    if (Date.now() - orphanSince > 12000) {
      orphanSince = null;
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }).catch(() => {});
      captureTabId = null;
      setNote(t('staleReset'));
    }
  } else orphanSince = null;
  // Пока страница по ссылке загружается, контроллера ещё нет: показываем задание как активное.
  if (captureTabId !== null && !state?.active) {
    state = {
      active: true, mode: 'link', status: 'listening', message: t('openingTrack'), lines: [], coverage: [],
      pos: null, duration: null, title: null, artist: null, artwork: null, playing: false, fromCache: false,
    };
  }
  if (state?.active && state.pos != null) {
    basePos = state.pos;
    baseAt = performance.now();
  } else basePos = null;
  if (!state?.active) karaokeLines = [];
  result = ((await chrome.storage.local.get('lastResult')).lastResult as SavedResult | undefined) ?? null;
  // Распознанные раньше тексты могли содержать строку с названием песни — прячем её и в них.
  if (result && result.source !== 'lrclib') result = { ...result, lines: dropTitleEcho(result.lines, { title: result.title, artist: result.artist }) };
  render();
}

async function startLink(e: Event) {
  e.preventDefault();
  if (busy) return;
  // Пустое поле, а на вкладке открыт трек SoundCloud → распознаём его.
  if (!urlInput.value.trim() && activeTab?.url && parseTrackUrl(activeTab.url)) urlInput.value = activeTab.url;
  let link = parseTrackUrl(urlInput.value);
  if (!link) {
    setNote(t('notALink'), true);
    return render();
  }
  // Короткая ссылка (кнопка «Copy link» на SoundCloud) — сначала узнаём настоящий адрес трека,
  // иначе не найти готовый текст и не отличить этот трек от другого, играющего в плеере.
  if (!link.path) {
    const full = (await chrome.runtime.sendMessage({ type: 'RESOLVE_LINK', url: link.url }).catch(() => null)) as {
      url: string | null;
      path: string | null;
    } | null;
    if (full?.url && full.path) link = { url: full.url, path: full.path };
  }
  if (!activeTab?.id) return;
  busy = true;
  setNote('');
  render();
  const skipLookup = forceScan;
  forceScan = false;
  try {
    if (link.path && !skipLookup) {
      const store = await chrome.storage.local.get('results');
      // Текст этого трека уже есть — показываем его без распознавания, если ему можно доверять:
      // закреплён или исправлен вручную, либо найден готовым с таймингами (или уже сверен со звуком).
      // Прошлое распознавание без закрепа распознаём заново (распознавание со временем улучшается),
      // а готовый текст без таймингов сверяем со звуком — иначе караоке будет «примерным».
      const saved = (store.results as Record<string, SavedResult> | undefined)?.[trackKey(link.path)];
      const trusted =
        !!saved &&
        (saved.pinned || saved.edited || (!!saved.source && saved.source !== 'scan' && (saved.synced !== false || saved.alignedBy === 'audio')));
      if (saved && saved.lines.length > 0 && trusted) {
        await chrome.storage.local.set({ lastResult: saved });
        urlInput.value = '';
        setNote(saved.pinned ? t('pinnedUsed') : t('savedUsed'));
        busy = false;
        lastKey = '';
        return await refresh();
      }
    }
    // Сначала ищем готовый текст (LRCLIB) — сканировать звук нужно, только если его нет.
    if (!skipLookup && link.path) {
      setNote(t('searching'));
      render();
      // Не ждём дольше 12 секунд (источников несколько, у самого поиска срок 8 с + название трека).
      const found = (await Promise.race([
        chrome.runtime.sendMessage({ type: 'LOOKUP_LINK', url: link.url, path: link.path }).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 12000)),
      ])) as { ok?: boolean; synced?: boolean } | null;
      // Готовый текст с таймингами — готово. Без таймингов — он станет основой, а время строк
      // возьмём из распознавания звука (сверка в конце трека).
      if (found?.ok && found.synced) {
        urlInput.value = '';
        setNote('');
        busy = false;
        lastKey = '';
        return await refresh();
      }
      setNote(found?.ok ? t('refSyncScan') : t('noReadyScan'));
      render();
    }
    // Что сейчас играет в этой вкладке?
    const player = isSC(activeTab.url)
      ? ((await chrome.tabs.sendMessage(activeTab.id, { type: 'PLAYER_INFO' }).catch(() => null)) as {
          trackId: string | null;
          playing: boolean;
        } | null)
      : null;
    const sameTrack = !!player?.trackId && !!link.path && isSameTrack(player.trackId, link.path);
    // Уже открыта страница этого трека (или он в плеере) — распознаём прямо здесь, без лишних кликов.
    const onTrackPage = !!activeTab.url && !!link.path && parseTrackUrl(activeTab.url)?.path === link.path;

    if (!sameTrack && !onTrackPage) {
      // Иначе трек открывается в отдельной вкладке и сразу включается; распознавание стартует
      // по клику на иконку там (так требует Chrome для записи звука вкладки).
      const res = await chrome.runtime.sendMessage({ type: 'QUEUE_LINK', url: link.url, path: link.path, returnTabId: activeTab.id });
      if (res && res.ok === false) setNote(res.error ?? t('cantOpenTab'), true);
      else urlInput.value = '';
      busy = false;
      return render();
    }

    // streamId запрашивается здесь, в ответ на действие пользователя, для текущей вкладки.
    let streamId: string;
    try {
      streamId = await getStreamId(activeTab.id);
    } catch (err) {
      if (!(err instanceof TabBusyError)) throw err;
      // Вкладку уже записывает демонстрация экрана — распознаём в соседней вкладке.
      const q = await chrome.runtime.sendMessage({ type: 'QUEUE_LINK', url: link.url, path: link.path, returnTabId: activeTab.id });
      if (q && q.ok === false) setNote(q.error ?? t('cantOpenTab'), true);
      else {
        urlInput.value = '';
        setNote(t('tabShared'));
      }
      busy = false;
      return render();
    }
    const res = await chrome.runtime.sendMessage({
      type: 'START_LINK',
      tabId: activeTab.id,
      streamId,
      url: link.url,
      path: link.path,
      // Даже если этот трек уже играет, распознаём быстро (с ускорением и без звука), как и по
      // любой ссылке; со звуком и на обычной скорости — только если включена кнопка звука.
      monitor,
    });
    if (res && res.ok === false) setNote(res.error ?? t('cantStart'), true);
    else {
      urlInput.value = '';
      setNote('');
    }
  } catch (err) {
    const text = String(err);
    setNote(classifyCaptureError(err) === 'notAllowed' ? t('tabNotUsable') : t('error', { msg: text.slice(0, 90) }), true);
  }
  busy = false;
  lastKey = '';
  await refresh();
}

class TabBusyError extends Error {}

/**
 * Идентификатор потока вкладки. Если вкладку держит наш прошлый захват — освобождаем и пробуем снова.
 * Если её записывает кто-то ещё (демонстрация экрана «вкладка Chrome») — TabBusyError.
 */
async function getStreamId(tabId: number): Promise<string> {
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    if (classifyCaptureError(err) !== 'busy') throw err;
    const cap = (await chrome.storage.session.get('capture').catch(() => ({}) as Record<string, unknown>)).capture as
      | { tabId: number }
      | undefined;
    if (cap?.tabId === tabId) {
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      try {
        return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      } catch (err2) {
        if (classifyCaptureError(err2) === 'busy') throw new TabBusyError(String(err2));
        throw err2;
      }
    }
    throw new TabBusyError(String(err));
  }
}

/** Запуск распознавания в отдельной вкладке (окошко открыто именно в ней). */
async function startPending(p: { tabId: number; url: string; path: string | null; returnTabId: number | null }) {
  busy = true;
  setNote(t('startingRecognition'));
  render();
  try {
    const streamId = await getStreamId(p.tabId);
    const res = await chrome.runtime.sendMessage({
      type: 'START_LINK',
      tabId: p.tabId,
      streamId,
      url: p.url,
      path: p.path,
      monitor: false,
      returnTabId: p.returnTabId,
    });
    if (res && res.ok === false) setNote(res.error ?? t('cantStart'), true);
    else setNote(t('recognizingSilently'));
  } catch (err) {
    setNote(err instanceof TabBusyError ? t('tabSharedToo') : t('error', { msg: String(err).slice(0, 90) }), true);
  }
  busy = false;
  lastKey = '';
  await refresh();
}

async function toggleCapture() {
  if (busy) return;
  busy = true;
  setNote('');
  render();
  try {
    if (state?.active && state.mode === 'link') {
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
    } else if (state?.active && activeTab?.id) {
      await chrome.tabs.sendMessage(activeTab.id, { type: 'KARAOKE_STOP' });
    } else if (activeTab?.id) {
      const res = await chrome.tabs.sendMessage(activeTab.id, { type: 'KARAOKE_START' });
      if (res && res.ok === false) setNote(res.error ?? t('cantKaraoke'), true);
    }
  } catch (err) {
    setNote(/Receiving end|Could not establish/i.test(String(err)) ? t('reloadSC') : t('error', { msg: String(err).slice(0, 90) }), true);
  }
  busy = false;
  lastKey = '';
  await refresh();
}

form.addEventListener('submit', (e) => void startLink(e));
// Исправить уже распознанный текст через DeepSeek (тайминги строк сохраняются).
correctBtn.addEventListener('click', async () => {
  if (!result || busy) return;
  busy = true;
  setNote(t('correcting'));
  render();
  const lines = result.lines.map((l) => ({ ...l, words: l.words ?? [] }));
  const res = await chrome.runtime
    .sendMessage({ type: 'CORRECT_LYRICS', lines: lines.map((l) => ({ text: l.text })), title: result.title, artist: result.artist })
    .catch((e) => ({ ok: false, error: String(e) }));
  const fixed = res?.ok ? applyCorrection(lines, res.raw) : null;
  if (fixed) {
    const updated = { ...result, lines: fixed, corrected: true, createdAt: Date.now() };
    const path = result.url ? parseTrackUrl(result.url)?.path : null;
    const store = await chrome.storage.local.get('results');
    const all = (store.results as Record<string, SavedResult> | undefined) ?? {};
    if (path) all[trackKey(path)] = updated;
    await chrome.storage.local.set({ lastResult: updated, results: pruneCache(all) });
    setNote('');
  } else {
    setNote(res?.ok ? t('correctNoChange') : t('correctFailed', { msg: String(res?.error ?? '').slice(0, 80) }), true);
  }
  busy = false;
  lastKey = '';
  await refresh();
});

karaokeBtn.addEventListener('click', async () => {
  if (busy) return;
  if (state?.active && state.mode === 'karaoke') {
    const tabId = karaokeTabId ?? activeTab?.id;
    if (tabId) await chrome.tabs.sendMessage(tabId, { type: 'KARAOKE_STOP' }).catch(() => {});
    await chrome.storage.session.remove('karaoke').catch(() => {});
    lastKey = '';
    return void (await refresh());
  }
  const path = result?.url ? parseTrackUrl(result.url)?.path : null;
  if (!result?.url || !path) return;
  busy = true;
  render();
  const res = await chrome.runtime.sendMessage({ type: 'KARAOKE_OPEN', url: result.url, path }).catch((e) => ({ ok: false, error: String(e) }));
  busy = false;
  if (res && res.ok === false) setNote(res.error ?? t('cantKaraoke'), true);
  else setNote(t('karaokeStarted'));
  lastKey = '';
  await refresh();
});

pinBtn.addEventListener('click', async () => {
  const path = result?.url ? parseTrackUrl(result.url)?.path : null;
  if (!path) return;
  // Берём сохранённый результат целиком (в окошке он мог быть подчищен для показа).
  const store = await chrome.storage.local.get(['results', 'lastResult']);
  const results = (store.results as Record<string, SavedResult> | undefined) ?? {};
  const key = trackKey(path);
  const base = (store.lastResult as SavedResult | undefined)?.url === result!.url ? (store.lastResult as SavedResult) : (results[key] ?? result!);
  const pinned = !base.pinned;
  const saved = { ...base, pinned };
  results[key] = saved;
  await chrome.storage.local.set({ results: pruneCache(results), lastResult: saved });
  setNote(pinned ? t('pinnedDone') : t('unpinnedDone'));
  lastKey = '';
  await refresh();
});
urlInput.addEventListener('input', () => {
  if (note) setNote('');
});
toggle.addEventListener('click', () => void toggleCapture());
$('menu').addEventListener('click', () => void chrome.runtime.openOptionsPage());
soundBtn.addEventListener('click', async () => {
  monitor = !monitor;
  await chrome.storage.local.set({ monitor });
  render();
});
copyBtn.addEventListener('click', async () => {
  if (!result) return;
  const head = dashes([result.artist, result.title].filter(Boolean).join(' - '));
  const body = result.lines
    .map((l) => {
      const tr = translateOn ? translations.get(l.text) : undefined;
      return dashes(tr ? `${l.text}\n${tr}` : l.text);
    })
    .join(translateOn ? '\n\n' : '\n');
  const text = (head ? `${head}\n\n` : '') + body;
  try {
    await navigator.clipboard.writeText(text);
    setNote(t('copied'));
    copyTip.textContent = t('copied');
    copyBtn.classList.add('flash');
    setTimeout(() => {
      copyBtn.classList.remove('flash');
      copyTip.textContent = t('copyText');
    }, 1400);
  } catch {
    setNote(t('copyFailed'), true);
  }
  render();
  setTimeout(() => {
    setNote('');
    render();
  }, 2000);
});

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const saved = await chrome.storage.local.get(['language', 'monitor', 'translations', 'deepseekKey']);
  hasDeepseek = typeof saved.deepseekKey === 'string' && saved.deepseekKey.trim() !== '';
  translations = new Map(Object.entries((saved.translations as Record<string, string> | undefined) ?? {}));
  monitor = saved.monitor === true;
  // Если на вкладке открыт трек SoundCloud, подставляем его ссылку.
  if (activeTab?.url && parseTrackUrl(activeTab.url)) urlInput.placeholder = t('linkPlaceholderThis');
  await refresh();
  urlInput.focus();
  // Отдельная вкладка распознавания ждёт клика по иконке — это он.
  const pend = (await chrome.storage.session.get('pending')).pending as
    | { tabId: number; url: string; path: string | null; returnTabId: number | null }
    | undefined;
  if (pend && activeTab?.id === pend.tabId) void startPending(pend);
  else if (pend) {
    setNote(t('pendingElsewhere'));
    render();
  }
  setInterval(() => void refresh(), 250);
  requestAnimationFrame(karaokeFrame);
}

const isForeign = (t: string) => {
  const src = detectScriptLang(t);
  return !!src && src !== target;
};

/** Кнопка «Перевести»: видна, когда на экране есть строки не на языке браузера. */
function renderTranslateButton() {
  const foreign = viewTexts.filter(isForeign);
  translateBtn.hidden = foreign.length === 0;
  // Обе кнопки не помещаются с подписями — «Копировать» остаётся значком.
  copyBtn.classList.toggle('iconOnly', !translateBtn.hidden);
  copyBtn.classList.toggle('tipbtn', !translateBtn.hidden); // без подписи — быстрая подсказка, как у соседних кнопок
  if (!copyBtn.classList.contains('flash')) copyTip.textContent = t('copyText');
  if (translateBtn.hidden) return;
  const untranslated = foreign.some((x) => !translations.has(x) && !failed.has(x));
  translateBtn.disabled = trBusy;
  translateBtn.classList.toggle('alt', translateOn && !untranslated);
  translateLabel.textContent = trBusy
    ? t('translating')
    : !translateOn
      ? t('translateTo', { lang: targetName })
      : untranslated
        ? t('translateNew')
        : t('hideTranslation');
}

/** Переводит строки на экране, которых ещё нет в переводах. Вызывается только по кнопке. */
async function translateVisible() {
  if (trBusy) return;
  const missing = [...new Set(viewTexts)].filter((x) => isForeign(x) && !translations.has(x));
  if (missing.length === 0) return;
  trBusy = true;
  trStatus = t('translatingTo', { lang: targetName });
  render();
  try {
    const cfg = normalizeConfig(await chrome.storage.local.get(null));
    const res = await translateLines(missing, target, cfg, (p) => {
      trStatus = t('downloadingTranslator', { p: Math.round(p * 100) });
      statusEl.textContent = trStatus;
    });
    for (const [k, v] of res) translations.set(k, v);
    missing.forEach((x) => failed.delete(x));
    // Храним последние 3000 переводов.
    const entries = [...translations.entries()].slice(-3000);
    translations = new Map(entries);
    await chrome.storage.local.set({ translations: Object.fromEntries(entries) });
    trStatus = '';
  } catch (err) {
    missing.forEach((x) => failed.add(x));
    trStatus = t('translateFailed', { msg: String(err).replace(/^Error: /, '').slice(0, 90) });
  }
  trBusy = false;
  trVersion++;
  render();
}

translateBtn.addEventListener('click', () => {
  const untranslated = viewTexts.some((x) => isForeign(x) && !translations.has(x));
  if (translateOn && !untranslated) {
    translateOn = false; // «Скрыть перевод»
    trStatus = '';
    render();
    return;
  }
  translateOn = true;
  failed.clear();
  render();
  // Запуск прямо в обработчике клика: встроенному переводчику Chrome можно скачать модель.
  void translateVisible();
});

void init();

// ---------------- Правка текста вручную ----------------

async function storedResult(): Promise<{ results: Record<string, SavedResult>; key: string; base: SavedResult } | null> {
  const path = result?.url ? parseTrackUrl(result.url)?.path : null;
  if (!path) return null;
  const store = await chrome.storage.local.get(['results', 'lastResult']);
  const results = (store.results as Record<string, SavedResult> | undefined) ?? {};
  const key = trackKey(path);
  const last = store.lastResult as SavedResult | undefined;
  const base = last?.url === result!.url ? last : (results[key] ?? result!);
  return { results, key, base };
}

function setEditing(on: boolean) {
  editing = on;
  document.body.classList.toggle('editing', on);
  editorEl.hidden = !on;
  editActions.hidden = !on;
}

editBtn.addEventListener('click', async () => {
  const s = await storedResult();
  if (!s) return;
  // Строки с названием песни (в окошке скрыты) в редактор тоже не попадают.
  const lines = s.base.source === 'lrclib' ? s.base.lines : dropTitleEcho(s.base.lines, { title: s.base.title, artist: s.base.artist });
  editorEl.value = lines.map((l) => dashes(l.text)).join('\n');
  setEditing(true);
  setNote('');
  editorEl.focus();
  editorEl.setSelectionRange(0, 0);
  editorEl.scrollTop = 0;
});
$('editCancel').addEventListener('click', () => {
  setEditing(false);
  lastKey = '';
  void refresh();
});
$('editSave').addEventListener('click', async () => {
  const texts = editorLines(editorEl.value);
  if (!texts.length) {
    statusEl.textContent = t('editEmpty');
    statusEl.classList.add('err');
    return;
  }
  const s = await storedResult();
  if (!s) return setEditing(false);
  const old = s.base.source === 'lrclib' ? s.base.lines : dropTitleEcho(s.base.lines, { title: s.base.title, artist: s.base.artist });
  // Закрепляем, чтобы исправленный текст не перезаписало новое распознавание.
  const saved: SavedResult = { ...s.base, lines: retimeEdited(old, texts), edited: true, pinned: true };
  s.results[s.key] = saved;
  await chrome.storage.local.set({ results: pruneCache(s.results), lastResult: saved });
  setEditing(false);
  setNote(t('editedDone'));
  lastKey = '';
  await refresh();
});
editorEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') (document.getElementById('editCancel') as HTMLButtonElement).click();
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (document.getElementById('editSave') as HTMLButtonElement).click();
});

// ---------------- Перемотка кликом по строке ----------------
listEl.addEventListener('click', async (e) => {
  if (!seekable || editing) return;
  const el = (e.target as HTMLElement).closest<HTMLElement>('.line[data-t]');
  if (!el || window.getSelection()?.toString()) return; // выделяли текст — не перематываем
  const time = Number(el.dataset.t);
  if (!Number.isFinite(time)) return;
  const karaokeOn = !!state?.active && state.mode === 'karaoke';
  const path = result?.url ? parseTrackUrl(result.url)?.path ?? null : null;
  el.classList.add('tap');
  setTimeout(() => el.classList.remove('tap'), 250);
  const res = (await chrome.runtime
    .sendMessage({ type: 'SEEK_LINE', tabId: karaokeOn ? (karaokeTabId ?? activeTab?.id ?? null) : null, path: karaokeOn ? null : path, time: Math.max(0, time - 0.15) })
    .catch(() => null)) as { ok?: boolean; reason?: string } | null;
  if (!res?.ok) setNote(t('seekNeedsTrack'));
  else if (note === t('seekNeedsTrack')) setNote('');
  render();
});
