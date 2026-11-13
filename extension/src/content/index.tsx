import { normalizeConfig } from '../core/config.ts';
import type { ChunkResultMessage } from '../core/types.ts';
import { Controller } from './controller.ts';
import { clickHeroPlay, clickPlayControl, readPlayer, seekViaUi } from './player.ts';
import { controlMedia, readMedia } from './media.ts';
import { isSameTrack } from '../core/link.ts';
import { requestTabAudio, startStreaming, stopPageCapture } from './page-capture.ts';
import { t } from '../core/i18n.ts';
import { extensionAlive } from './alive.ts';

/** Интерфейс живёт в popup; content script только следит за плеером и собирает строки. */
const controller = new Controller();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'GET_STATE':
      sendResponse(controller.getSnapshot());
      return false;
    case 'KARAOKE_START':
      // Караоке без захвата звука: только подсветка сохранённого текста.
      chrome.storage.local
        .get(null)
        .then((raw) => {
          controller.start(normalizeConfig(raw), { mode: 'karaoke' });
          if (msg.autoplay && msg.path) playForKaraoke(String(msg.path));
          sendResponse({ ok: true });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'PLAYER_INFO':
      sendResponse(readPlayer());
      return false;
    case 'SEEK_TO':
      // Клик по строке в окошке: перемотка на её начало (как на YouTube и в Spotify).
      void seekTo(msg.path ?? null, Math.max(0, Number(msg.time) || 0)).then(sendResponse);
      return true;
    case 'LINK_START':
      hideHint();
      // Трек по ссылке на уже открытом SoundCloud: без перехода на его страницу.
      controller.start(normalizeConfig(msg.config), { mode: 'link', url: msg.url, path: msg.path, inPage: true, speed: msg.speed });
      sendResponse({ ok: true });
      return false;
    case 'KARAOKE_STOP':
      if (controller.getSnapshot().mode === 'karaoke') controller.stop();
      sendResponse({ ok: true });
      return false;
    case 'CAPTURE_STOPPED':
      stopPageCapture(); // убирает и полоску Chrome «Вы показываете эту вкладку»
      if (controller.getSnapshot().mode === 'link') controller.stop();
      return false;
    case 'CHUNK_RESULT':
      controller.onChunk(msg as ChunkResultMessage);
      return false;
    case 'STATUS':
      controller.setStatus(msg.state, msg.message);
      return false;
    case 'IDLE':
      controller.onIdle();
      return false;
    case 'FINAL_DONE':
      controller.onFinalDone();
      return false;
  }
  return false;
});

// Страница могла открыться по ссылке из окошка (или перезагрузиться во время захвата):
// спрашиваем у фонового скрипта, есть ли для этой вкладки задание.
function askForJob(retries: number) {
  if (!extensionAlive()) return;
  chrome.runtime
    .sendMessage({ type: 'CONTENT_READY' })
    .then((res) => {
      const cap = res?.capture;
      if (cap) controller.start(normalizeConfig(cap.config), { mode: cap.mode, url: cap.url, path: cap.path, speed: cap.speed });
      else if (res?.karaoke) {
        // Вкладка открыта кнопкой 🎤: караоке для этого трека.
        void chrome.storage.local.get(null).then((raw) => {
          controller.start(normalizeConfig(raw), { mode: 'karaoke' });
          playForKaraoke(String(res.karaoke.path));
        });
      } else if (res?.pending) showHint();
      else if (retries > 0) setTimeout(() => askForJob(retries - 1), 1500); // вкладку могли зарегистрировать чуть позже
    })
    .catch(() => {});
}
askForJob(4);

/**
 * Караоке по кнопке 🎤: включить этот трек (одно нажатие — кнопка play у SoundCloud переключатель).
 * В новой вкладке Chrome может не дать включить звук без клика по странице — тогда маленькая
 * плашка с кнопкой «Включить трек».
 */
function playForKaraoke(path: string) {
  const norm = (x: string) => x.toLowerCase().replace(/\/+$/, '');
  const ours = () => {
    const p = readPlayer();
    return !!p.trackId && isSameTrack(p.trackId, path);
  };
  const press = () => {
    const p = readPlayer();
    if (ours()) {
      if (!p.playing) clickPlayControl();
    } else if (norm(location.pathname) === norm(path)) clickHeroPlay();
  };
  setTimeout(press, 600);
  setTimeout(() => {
    if (!(ours() && readPlayer().playing)) showKaraokeHint(press);
  }, 3500);
}

let karaokeHost: HTMLElement | null = null;
function showKaraokeHint(press: () => void) {
  if (karaokeHost) return;
  karaokeHost = document.createElement('div');
  const root = karaokeHost.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .box { position: fixed; top: 12px; right: 16px; z-index: 2147483647; width: 300px; padding: 14px 16px;
        border-radius: 14px; background: rgba(36, 36, 38, .96); color: #f2f2f2; border: 1px solid rgba(255,255,255,.08);
        box-shadow: 0 8px 24px rgba(0,0,0,.35); font: 13.5px/1.4 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif; }
      b { display: block; font-size: 14px; font-weight: 600; margin-bottom: 3px; }
      span { color: rgba(255,255,255,.62); }
      button { display: block; width: 100%; margin-top: 10px; padding: 10px 12px; border-radius: 10px; font: 500 14px/1 inherit;
        font-family: inherit; color: #f2f2f2; cursor: pointer; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.14); }
      button:hover { background: rgba(255,255,255,.16); }
    </style>
    <div class="box" role="status"><b></b><span></span><button></button></div>`;
  root.querySelector('b')!.textContent = t('karaokeHintTitle');
  root.querySelector('span')!.textContent = t('karaokeHintText');
  const btn = root.querySelector('button')!;
  btn.textContent = t('karaokePlay');
  btn.addEventListener('click', () => {
    press();
    karaokeHost?.remove();
    karaokeHost = null;
  });
  document.documentElement.append(karaokeHost);
}

/**
 * Подсказка во вкладке, открытой по ссылке: одна кнопка «Начать распознавание».
 * По нажатию Chrome спрашивает разрешение записать эту вкладку («Разрешить»), после чего трек
 * включается и распознаётся с начала. Клик по кнопке заодно снимает запрет Chrome на автозапуск
 * звука в новой вкладке. Запасной способ — клик по иконке расширения (Alt+Shift+S).
 */
let hintHost: HTMLElement | null = null;
let hintRoot: ShadowRoot | null = null;
function showHint() {
  if (hintHost) return;
  hintHost = document.createElement('div');
  const root = hintHost.attachShadow({ mode: 'open' });
  hintRoot = root;
  root.innerHTML = `
    <style>
      .box { position: fixed; top: 12px; right: 16px; z-index: 2147483647; width: 320px; padding: 14px 16px;
        border-radius: 14px; background: rgba(36, 36, 38, .96); color: #f2f2f2;
        border: 1px solid rgba(255,255,255,.08); box-shadow: 0 8px 24px rgba(0,0,0,.35);
        font: 13.5px/1.4 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif; }
      .box b { display: block; font-size: 14px; font-weight: 600; margin-bottom: 3px; }
      .box span { color: rgba(255,255,255,.62); }
      button { display: block; width: 100%; margin: 10px 0 2px; padding: 10px 12px; border-radius: 10px;
        font: 500 14px/1 inherit; font-family: inherit; color: #f2f2f2; cursor: pointer;
        background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.14); }
      button:hover { background: rgba(255,255,255,.16); }
      button:disabled { opacity: .6; cursor: default; }
      .err { display: block; margin-top: 6px; color: #ffb4a8; }
      .err:empty { display: none; }
      .alt { display: block; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.1); opacity: .55; font-size: 12.5px; }
    </style>
    <div class="box" role="status">
      <b class="t1"></b><span class="x1"></span>
      <button class="go"></button>
      <span class="err"></span>
      <span class="alt"></span>
    </div>`;
  root.querySelector('.t1')!.textContent = t('hintStartTitle');
  root.querySelector('.x1')!.textContent = t('hintStartText');
  root.querySelector('.alt')!.textContent = t('hintAlt');
  const btn = root.querySelector('.go') as HTMLButtonElement;
  const err = root.querySelector('.err') as HTMLElement;
  btn.textContent = t('hintStartButton');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = t('hintWaiting');
    err.textContent = '';
    const fail = (key: string) => {
      err.textContent = t(key);
      btn.disabled = false;
      btn.textContent = t('hintStartButton');
    };
    const audio = await requestTabAudio();
    if (typeof audio === 'string') return fail(audio === 'denied' ? 'capDenied' : audio === 'noAudio' ? 'capNoAudio' : 'capFailed');
    const res = await chrome.runtime
      .sendMessage({ type: 'PAGE_CAPTURE', url: location.href.split('?')[0], path: location.pathname.toLowerCase() })
      .catch((e) => ({ ok: false, error: String(e) }));
    if (!res?.ok) {
      console.warn('[sc texts] PAGE_CAPTURE:', res?.error);
      stopPageCapture();
      return fail('capFailed');
    }
    // Распознавание запущено (подсказку уже убрал LINK_START) — передаём звук.
    startStreaming(audio, () => void chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }).catch(() => {}));
  });
  document.documentElement.append(hintHost);
}

function hideHint() {
  hintHost?.remove();
  hintHost = null;
  hintRoot = null;
}

// Новые сохранённые тексты сразу доступны караоке.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.results) controller.reloadCache(changes.results.newValue as never);
});

/** Перемотка трека на время строки; трек не в плеере, но открыта его страница — сначала включаем. */
async function seekTo(path: string | null, time: number): Promise<{ ok: boolean; reason?: string }> {
  let p = readPlayer();
  const onPage = !!path && location.pathname.toLowerCase().replace(/\/+$/, '') === path;
  if (!p.trackId || (path && !isSameTrack(p.trackId, path))) {
    if (!onPage || !clickHeroPlay()) return { ok: false, reason: 'otherTrack' };
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      p = readPlayer();
      if (p.trackId && isSameTrack(p.trackId, path!) && (readMedia()?.duration || p.duration)) break;
    }
    if (!p.trackId || !isSameTrack(p.trackId, path!)) return { ok: false, reason: 'notStarted' };
  }
  const dur = readMedia()?.duration || p.duration || 0;
  // Через полосу прогресса SoundCloud сам подгружает нужный кусок; иначе — напрямую в медиа.
  if (!(dur > 0 && seekViaUi(time / dur))) controlMedia('seek', undefined, time);
  if (!readPlayer().playing) clickPlayControl();
  return { ok: true };
}
