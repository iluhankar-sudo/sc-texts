/**
 * Чтение состояния плеера SoundCloud из DOM.
 * ВАЖНО: вёрстка SoundCloud меняется без предупреждения. Все селекторы собраны здесь,
 * у каждого есть запасной вариант; при поломке правится только этот файл.
 */
import { parseClock } from '../core/time.ts';
import { readMedia } from './media.ts';

export interface PlayerState {
  /** Путь трека (например /artist/track) или null, если плеер пуст. */
  trackId: string | null;
  title: string | null;
  artist: string | null;
  /** URL обложки (увеличенной), если есть. */
  artwork: string | null;
  /** Целые секунды, как показывает плеер. */
  pos: number | null;
  duration: number | null;
  playing: boolean;
  /** Точное время из медиа-элемента (секунды) или null, если его не видно. */
  exact: number | null;
  /** Фактическая скорость воспроизведения. */
  rate: number;
}

export const SELECTORS = {
  timePassed: '.playbackTimeline__timePassed',
  timePassedVisible: '.playbackTimeline__timePassed span[aria-hidden="true"]',
  duration: '.playbackTimeline__duration',
  durationVisible: '.playbackTimeline__duration span[aria-hidden="true"]',
  progress: '.playbackTimeline__progressWrapper',
  playButton: '.playControls__play, .playControl',
  titleLink: '.playbackSoundBadge__titleLink',
  artistLink: '.playbackSoundBadge__lightLink',
  /** Большая кнопка play на странице трека (несколько вариантов вёрстки). */
  heroPlay:
    '.fullHero__playButton .sc-button-play, .fullHero__playButton button, .fullListenHero .sc-button-play, ' +
    '.listenHero .sc-button-play, .soundTitle__playButton .sc-button-play, .sc-button-play.sc-button-xlarge, ' +
    '.l-listen-hero .sc-button-play, .listenEngagement .sc-button-play, [class*="Hero"] .sc-button-play, [class*="hero"] button[aria-label*="Play" i]',
  /** Кнопка play/pause в нижнем плеере. */
  playControl: '.playControls__play, .playControl',
  /** Где искать обложку играющего трека (любой элемент с картинкой внутри). */
  artworkRoots: '.playbackSoundBadge, .playControls__soundBadge, .playbackSoundBadge__avatar',
  /** Обложка на странице трека (запасной вариант). */
  heroArtwork: '.fullHero__artwork, .listenArtworkWrapper, .fullListenHero__artwork',
} as const;

function textOf(doc: Document, ...sels: string[]): string | null {
  for (const s of sels) {
    const t = doc.querySelector(s)?.textContent;
    if (t && t.trim()) return t.trim();
  }
  return null;
}

export function readPlayer(doc: Document = document): PlayerState {
  let pos = parseClock(textOf(doc, SELECTORS.timePassedVisible, SELECTORS.timePassed));
  if (pos === null) {
    const now = doc.querySelector(SELECTORS.progress)?.getAttribute('aria-valuenow');
    if (now && Number.isFinite(Number(now))) pos = Math.floor(Number(now));
  }
  const duration = parseClock(textOf(doc, SELECTORS.durationVisible, SELECTORS.duration));

  const btn = doc.querySelector(SELECTORS.playButton);
  let playing: boolean;
  if (btn) {
    playing = btn.classList.contains('playing');
  } else {
    playing = Array.from(doc.querySelectorAll('audio, video')).some((m) => !(m as HTMLMediaElement).paused);
  }

  const link = doc.querySelector(SELECTORS.titleLink) as HTMLAnchorElement | null;
  let trackId: string | null = null;
  const href = link?.getAttribute('href');
  if (href) {
    try {
      trackId = new URL(href, 'https://soundcloud.com').pathname;
    } catch {
      trackId = href;
    }
  }
  const title = link?.getAttribute('title') ?? link?.textContent?.trim() ?? null;

  const artistEl = doc.querySelector(SELECTORS.artistLink);
  const artist = artistEl?.getAttribute('title') ?? artistEl?.textContent?.trim() ?? null;

  let artwork = findArtwork(doc, SELECTORS.artworkRoots);
  // Запасной вариант: мы на странице этого трека — берём обложку со страницы или из og:image.
  const onTrackPage = !!trackId && doc.location?.pathname?.toLowerCase().replace(/\/+$/, '') === trackId.toLowerCase().replace(/\/+$/, '');
  if (!artwork && onTrackPage) {
    artwork =
      findArtwork(doc, SELECTORS.heroArtwork) ??
      artworkUrl(doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null);
  }

  // Точное время — только для настоящей страницы (в тестах document подменён).
  const media = doc === globalThis.document ? readMedia() : null;
  const exact = media && pos !== null && Math.abs(media.time - pos) < 3 ? media.time : null;

  return { trackId, title, artist, artwork, pos, duration, playing, exact, rate: media?.rate ?? 1 };
}

function clickFirst(selector: string, doc: Document): boolean {
  const el = doc.querySelector(selector) as HTMLElement | null;
  if (!el) return false;
  el.click();
  return true;
}

/** Нажать play на странице трека. */
export function clickHeroPlay(doc: Document = document): boolean {
  if (clickFirst(SELECTORS.heroPlay, doc)) return true;
  // Вёрстка поменялась: первая видимая кнопка play на странице, не в нижнем плеере.
  const cands = Array.from(
    doc.querySelectorAll<HTMLElement>('.sc-button-play, button[aria-label="Play" i], button[title="Play" i], [role="button"][aria-label="Play" i]'),
  ).filter((el) => !el.closest('.playControls, .playControl, .playbackSoundBadge') && el.getClientRects().length > 0);
  const el = cands[0];
  if (!el) return false;
  el.click();
  return true;
}

/** Большая кнопка на странице трека показывает «пауза» — трек играет (или запускается). */
export function isHeroPlaying(doc: Document = document): boolean {
  const b = doc.querySelector(SELECTORS.heroPlay);
  const btn = (b?.closest('.sc-button-play') ?? b) as Element | null;
  return !!btn && (btn.classList.contains('sc-button-pause') || btn.classList.contains('playing'));
}

/** Нажать play/pause в нижнем плеере. */
export function clickPlayControl(doc: Document = document): boolean {
  return clickFirst(SELECTORS.playControl, doc);
}

/** Достаёт адрес картинки SoundCloud из style="background-image: url(...)" или src и увеличивает её до 500×500. */
export function artworkUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /url\((?:&quot;|["'])?(.*?)(?:&quot;|["'])?\)/.exec(raw);
  const url = (m?.[1] ?? raw).trim();
  if (!/^https:\/\/[^\s"']*sndcdn\.com\//.test(url)) return null;
  return url.replace(/-(?:large|t\d+x\d+|crop|small|badge|tiny|mini)\./, '-t500x500.');
}

/** Ищет первую картинку SoundCloud внутри указанных блоков. */
function findArtwork(doc: Document, rootsSelector: string): string | null {
  const roots = doc.querySelectorAll?.(rootsSelector) ?? [];
  for (const root of Array.from(roots)) {
    const candidates = [root, ...Array.from((root as Element).querySelectorAll?.('[style*="background-image"], img') ?? [])];
    for (const el of candidates) {
      const e = el as HTMLElement;
      const url =
        artworkUrl(e.style?.backgroundImage) ??
        artworkUrl(e.getAttribute?.('style')) ??
        artworkUrl(e.tagName === 'IMG' ? (e as HTMLImageElement).src : null);
      if (url) return url;
    }
  }
  return null;
}

/**
 * Перемотка средствами SoundCloud: клик по полосе прогресса в нижнем плеере
 * (fraction — доля длительности, 0…1). Так плеер сам подгружает нужный кусок трека.
 */
export function seekViaUi(fraction: number, doc: Document = document): boolean {
  const bar = doc.querySelector(SELECTORS.progress) as HTMLElement | null;
  if (!bar) return false;
  const r = bar.getBoundingClientRect();
  if (!r.width) return false;
  const x = r.left + Math.max(1, Math.min(r.width - 1, r.width * Math.max(0, Math.min(1, fraction))));
  const y = r.top + r.height / 2;
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1 };
  bar.dispatchEvent(new PointerEvent('pointerdown', opts));
  bar.dispatchEvent(new MouseEvent('mousedown', opts));
  bar.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
  bar.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
  bar.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
  return true;
}
