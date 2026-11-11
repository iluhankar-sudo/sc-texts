/**
 * Контроллер страницы: опрашивает плеер, ведёт часы воспроизведения,
 * управляет «эпохами» захвата и собирает строки из результатов распознавания.
 *
 * Эпоха — непрерывный отрезок воспроизведения. Меняется при паузе, возобновлении,
 * перемотке и смене трека. Перемотка и смена трека делают прежние результаты
 * недействительными; пауза и возобновление — нет (позиция трека продолжается).
 *
 * Режимы:
 *  - link: трек открыт по ссылке, контроллер сам запускает его, звук вкладки
 *    распознаётся до конца трека, текст сохраняется в chrome.storage.local
 *    (results по треку + lastResult), затем захват останавливается;
 *  - karaoke: захвата и распознавания нет — уже сохранённый текст трека
 *    подсвечивается синхронно с плеером.
 */
import { PlaybackClock } from '../core/clock.ts';
import { DEFAULT_CONFIG } from '../core/config.ts';
import { cleanSegments, dropRepeatedRuns, dropTitleEcho, isTitleEcho } from '../core/filter.ts';
import { pruneCache, trackKey, type CachedResult } from '../core/cache.ts';
import { applyCorrection } from '../core/correct.ts';
import { isSameTrack } from '../core/link.ts';
import { mergeChunk } from '../core/merge.ts';
import { addRange } from '../core/ranges.ts';
import type { CaptureState, ChunkResultMessage, Config, Line, Range, RawSegment } from '../core/types.ts';
import { AUTO_MAX_SPEED_AUDIOSHAKE, pickSpeed } from '../core/speed.ts';
import { setMediaSpeed } from './media.ts';
import { clickHeroPlay, clickPlayControl, readPlayer, seekViaUi } from './player.ts';
import { t } from '../core/i18n.ts';
import { extensionAlive } from './alive.ts';
import { alignLyrics } from '../core/align.ts';

export type CaptureMode = 'karaoke' | 'link';

export interface StartOptions {
  mode: CaptureMode;
  url?: string | null;
  path?: string | null;
  /** Открыть трек внутри SoundCloud и вернуть прежнюю страницу, когда он заиграет. */
  inPage?: boolean;
  /** Ускорение при распознавании (только режим ссылки): 0 — «Авто», иначе 1–8. */
  speed?: number;
}

export type SavedResult = CachedResult;

export interface PanelState {
  active: boolean;
  mode: CaptureMode;
  status: CaptureState;
  message: string;
  lines: Line[];
  coverage: Range[];
  /** Позиция трека, секунды (оценка по часам), либо null, если плеер не найден. */
  pos: number | null;
  duration: number | null;
  title: string | null;
  artist: string | null;
  artwork: string | null;
  playing: boolean;
  /** Текст взят из сохранённых (трек уже распознавался), распознавание не идёт. */
  fromCache: boolean;
  /** У текста есть тайминги строк (иначе караоке показывает текст без подсветки). */
  synced: boolean;
  /** Откуда текст. */
  source: 'scan' | 'lrclib' | null;
}

const POLL_MS = 100;
const MAX_AUTOPLAY_CLICKS = 4;

const initial = (): PanelState => ({
  active: false,
  mode: 'karaoke',
  status: 'idle',
  message: '',
  lines: [],
  coverage: [],
  pos: null,
  duration: null,
  title: null,
  artist: null,
  artwork: null,
  playing: false,
  fromCache: false,
  synced: true,
  source: null,
});

export class Controller {
  private state: PanelState = initial();
  private listeners = new Set<() => void>();
  private clock = new PlaybackClock();
  private config: Config = DEFAULT_CONFIG;
  private epoch = 0;
  /** cutoff: результаты эпохи после этой позиции трека отбрасываются (там уже играл другой трек). */
  private epochs = new Map<number, { valid: boolean; cutoff?: number }>();
  private trackId: string | null = null;
  private playing = false;
  private timer: number | null = null;

  // режим ссылки
  private linkUrl: string | null = null;
  private linkPath: string | null = null;
  private linkStarted = false;
  private autoplayDone = false;
  private clicks = 0;
  private misses = 0;
  private lastClick = 0;
  private finishing = false;
  private idleWaiter: (() => void) | null = null;
  private finalWaiter: (() => void) | null = null;
  /** Финальный результат принят: предварительные куски после него больше не нужны. */
  private finalApplied = false;
  /** Текст взят из готового источника и синхронизирован по звуку. */
  private alignedFrom: SavedResult['source'] | null = null;
  /** Текст по предварительным кускам (до финального прохода) — второй вариант для DeepSeek. */
  private previewText = '';
  private speedSetting = 1; // настройка: 0 — «Авто»
  private speed = 1; // фактическое ускорение трека при распознавании по ссылке
  private lastExact = -1;
  private lastAdvance = 0; // когда точное время последний раз сдвигалось
  private restarting = false; // трек перематывается в начало перед записью
  private awaitFirstPlay = false; // запись уже идёт, ждём старта трека
  private away = false; // во время распознавания заиграл другой трек — ждём возвращения нашего
  private lastOurPos = 0; // последняя позиция трека по ссылке
  private corrected = false; // текст исправлен DeepSeek
  private altText: string | null = null; // текст по кускам — второй вариант для DeepSeek
  private engine: 'whisper' | 'audioshake' = 'whisper';
  private safe = false; // простой режим: не управлять плеером (настройка или страховка сработала)
  private playCheckFrom = 0; // с какого момента ждём, что трек пошёл (0 — проверка не нужна)
  private checkPos = 0;
  private retryPlayUntil = 0; // после страховки: повторять play до этого момента
  private logBuf: string[] = [];
  private logTimer: number | null = null; // страница, на которую вернуться после запуска трека

  // сохранённые тексты
  private cache: Record<string, SavedResult> = {};
  private cacheReady = false;
  private fromCache = false;
  private saved = false;
  private lookedUp = new Set<string>(); // треки, для которых уже искали готовый текст

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.state;

  private set(patch: Partial<PanelState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  start(config: Config, opts: StartOptions = { mode: 'karaoke' }) {
    this.config = config;
    this.clock = new PlaybackClock();
    this.trackId = null; // первый тик сработает как смена трека и отправит RESET
    this.epochs.clear();
    this.linkUrl = opts.url ?? null;
    this.speedSetting = opts.mode === 'link' ? Math.min(8, Math.max(0, opts.speed ?? 1)) : 1;
    this.speed = 1;
    this.away = false;
    this.lastOurPos = 0;
    this.corrected = false;
    this.altText = null;
    this.engine = 'whisper';
    this.safe = opts.mode === 'link' && config.simpleMode;
    if (this.safe) this.speedSetting = 1;
    this.playCheckFrom = 0;
    if (opts.mode === 'link') {
      this.logBuf = [];
      this.log(`старт: ${opts.url ?? '?'} скорость=${opts.speed ?? 1} простой=${this.safe} модель=${config.apiModel} язык=${config.language}`);
    }
    this.linkPath = opts.path ?? null;
    this.linkStarted = false;
    this.autoplayDone = false;
    this.clicks = 0;
    this.misses = 0;
    this.lastClick = 0;
    this.finishing = false;
    this.fromCache = false;
    this.saved = false;
    this.finalApplied = false;
    this.alignedFrom = null;
    this.previewText = '';
    this.cacheReady = false;
    if (opts.mode === 'link' && opts.inPage && opts.url) this.openInPage(opts.url);
    void chrome.storage.local
      .get('results')
      .then((r) => {
        this.cache = (r.results as Record<string, SavedResult> | undefined) ?? {};
      })
      .catch(() => {})
      .finally(() => {
        this.cacheReady = true;
      });
    const message = opts.mode === 'link' ? t('startingTrack') : t('karaoke');
    this.set({ ...initial(), active: true, mode: opts.mode, status: 'listening', message });
    if (this.timer === null) this.timer = window.setInterval(() => this.tick(), POLL_MS);
    this.tick();
  }

  stop() {
    if (this.state.mode === 'link' && this.speed > 1) setMediaSpeed(1);
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.finishing = false;
    this.idleWaiter?.();
    this.idleWaiter = null;
    this.set(initial());
  }

  /** Журнал для «Скопировать отчёт» в настройках (без ключей и текстов песен). */
  private log(msg: string) {
    const ts = new Date().toISOString().slice(11, 23);
    this.logBuf.push(`${ts} ${msg}`);
    if (this.logBuf.length > 150) this.logBuf.splice(0, this.logBuf.length - 150);
    if (this.logTimer === null) {
      this.logTimer = window.setTimeout(() => {
        this.logTimer = null;
        if (!extensionAlive()) return;
        chrome.storage.local.set({ debugLog: this.logBuf.join('\n') }).catch(() => {});
      }, 500);
    }
  }

  setStatus(status: CaptureState, message?: string) {
    if (status === 'error' || status === 'lagging') this.log(`статус ${status}: ${message ?? ''}`);
    if (!this.state.active || this.finishing) return;
    const defaults: Record<CaptureState, string> = {
      idle: '',
      listening: t('listeningTrack'),
      transcribing: t('recognizing'),
      lagging: t('lagging'),
      error: t('errorShort'),
    };
    this.set({ status, message: message ?? defaults[status] });
  }

  /** Offscreen-документ разобрал всю очередь. */
  onIdle() {
    this.idleWaiter?.();
    this.idleWaiter = null;
  }

  /** Финальный проход закончился (успешно или нет). */
  onFinalDone() {
    this.finalWaiter?.();
    this.finalWaiter = null;
  }

  private newEpoch(opts: { invalidatePrev: boolean; flush: boolean; trimLead?: boolean }) {
    if (this.state.mode === 'karaoke') return; // караоке не трогает захват
    if (opts.invalidatePrev) this.epochs.set(this.epoch, { valid: false });
    this.epoch++;
    this.epochs.set(this.epoch, { valid: true });
    for (const k of this.epochs.keys()) if (k < this.epoch - 20) this.epochs.delete(k);
    chrome.runtime
      .sendMessage({
        type: 'RESET',
        epoch: this.epoch,
        paused: !this.playing,
        flush: opts.flush,
        hint: { title: this.state.title, artist: this.state.artist },
        speed: this.state.mode === 'link' ? this.speed : 1,
        trimLead: !!opts.trimLead,
      })
      .catch(() => {});
  }

  /**
   * Режим ссылки: в плеере заиграл другой трек. Если наш уже доигран — это обычное завершение.
   * Иначе запись ставится на паузу (звук другого трека не попадает в текст), а трек по ссылке
   * открывается и запускается снова; продолжение — с места остановки (см. начало tick()).
   */
  private onOtherTrack() {
    this.log(`в плеере другой трек (наш на ${this.lastOurPos.toFixed(1)} из ${this.state.duration ?? '?'})`);
    const dur = this.state.duration;
    if (dur && this.lastOurPos >= dur - 3) {
      this.finish().catch(() => {});
      return;
    }
    this.away = true;
    // Хвост текущего окна ещё распознаётся — отбрасываем всё, что после места переключения.
    const cur = this.epochs.get(this.epoch);
    if (cur) this.epochs.set(this.epoch, { ...cur, cutoff: this.lastOurPos + 0.3 });
    this.playing = false;
    this.newEpoch({ invalidatePrev: false, flush: true });
    this.set({ message: t('returningToTrack') });
    this.autoplayDone = false;
    this.clicks = 0;
    this.lastClick = 0;
    if (this.linkUrl) this.openInPage(this.linkUrl);
  }

  /** Запомнить, откуда должен пойти трек, — для страховки. */
  private armPlayCheck(p: ReturnType<typeof readPlayer>) {
    this.playCheckFrom = Date.now();
    this.checkPos = p.exact ?? p.pos ?? 0;
  }

  /** Трек не пошёл за 7 секунд: обычная скорость, один раз play — и дальше просто слушаем. */
  private fallbackToSimple(p: ReturnType<typeof readPlayer>) {
    this.log(`СТРАХОВКА: трек не пошёл за 7 с (играет: ${p.playing}, позиция ${(p.exact ?? p.pos ?? 0).toFixed(1)}) — простой режим`);
    this.safe = true;
    this.playCheckFrom = 0;
    this.awaitFirstPlay = false;
    if (this.speed > 1) {
      this.speed = 1;
      setMediaSpeed(1);
    }
    this.playing = p.playing;
    this.newEpoch({ invalidatePrev: false, flush: false });
    if (!p.playing) clickPlayControl();
    this.lastClick = Date.now();
    this.retryPlayUntil = Date.now() + 15000;
    this.set({ message: t('fallbackSimple') });
  }

  /**
   * Пауза → перемотка в 0 → запись включена → запуск трека.
   * Тишина до старта отрезается в offscreen (trimLead), поэтому первое окно начинается ровно с начала песни.
   */
  private restartFromZero(_wall: number) {
    // Всё делается кнопками SoundCloud (пауза, клик по полосе прогресса, play), а не напрямую
    // через медиа-элемент: иначе плеер сайта теряет синхронизацию и трек может не играть.
    this.restarting = true;
    this.awaitFirstPlay = true;
    if (readPlayer().playing) clickPlayControl(); // пауза
    setTimeout(() => {
      const q0 = readPlayer();
      if ((q0.exact ?? q0.pos ?? 0) > 0.3) {
        const ok = seekViaUi(0); // в начало, если трек уже успел поиграть
        this.log(`перемотка в начало кликом по полосе: ${ok ? 'выполнена' : 'ПОЛОСА НЕ НАЙДЕНА'}`);
      }
      if (this.speed > 1) setMediaSpeed(this.speed); // скорость применится при запуске
      setTimeout(() => {
        const q = readPlayer();
        const now = Date.now();
        const start = q.exact ?? q.pos ?? 0; // фактическая позиция (если перемотка не сработала — с неё)
        this.clock = new PlaybackClock();
        if (this.speed > 1) this.clock.setRate(this.speed, now);
        this.clock.updateExact(start, false, now);
        this.lastExact = start;
        this.lastAdvance = now;
        this.playing = true; // запись включаем до запуска: тишина в начале отрежется
        this.set({ pos: start, lines: [], coverage: [] });
        this.newEpoch({ invalidatePrev: true, flush: false, trimLead: true });
        setTimeout(() => {
          const before = readPlayer();
          if (!before.playing) clickPlayControl(); // запуск
          this.log(`перезапуск с начала: позиция ${start.toFixed(1)}, play ${before.playing ? 'не нужен' : 'нажат'}, скорость ×${this.speed}`);
          this.lastAdvance = Date.now();
          this.restarting = false;
          this.armPlayCheck(readPlayer());
        }, 300);
      }, 300);
    }, 200);
  }

  /** Часы по точному времени плеера (если доступно) или по целым секундам. */
  private updateClock(p: ReturnType<typeof readPlayer>, wall: number) {
    if (p.exact !== null) {
      // Трек подгружается (время стоит, хотя кнопка «играет») — считаем это паузой,
      // чтобы не записывать тишину вместо песни и не сбить тайминги.
      if (p.exact !== this.lastExact) {
        this.lastExact = p.exact;
        this.lastAdvance = wall;
      }
      const moving = p.playing && wall - this.lastAdvance < 400;
      this.playing = moving;
      if (moving) this.clock.setRate(p.rate, wall);
      return this.clock.updateExact(p.exact, moving, wall);
    }
    return this.clock.update(p.pos!, p.playing, wall);
  }

  private listeningMessage() {
    return this.speed > 1 ? t('listeningFast', { x: String(this.speed).replace('.', ',') }) : t('listeningTrack');
  }

  /** Режим ссылки: нажимает play, пока нужный трек не заиграет. */
  private autoplay(p: ReturnType<typeof readPlayer>) {
    if (this.autoplayDone) return;
    const ours = isSameTrack(p.trackId, this.linkPath);
    if (ours && p.playing) {
      this.autoplayDone = true;
      this.log(`трек заиграл: позиция=${(p.exact ?? p.pos ?? 0).toFixed(1)} длительность=${p.duration ?? '?'} точное время=${p.exact !== null}`);
      this.set({ message: this.listeningMessage() });
      this.lookupDuringScan(p);
      return;
    }
    const now = Date.now();
    if (now - this.lastClick < 2000) return;
    // В нижнем плеере играет другой трек (SoundCloud подгружает в новую вкладку последний
    // прослушанный) — сначала ставим его на паузу, потом запускаем наш кнопкой на странице.
    if (!ours && p.playing) {
      clickPlayControl();
      this.lastClick = now;
      this.log(`в плеере играет другой трек (${p.trackId ?? '—'}) — пауза`);
      return;
    }
    if (this.clicks >= MAX_AUTOPLAY_CLICKS) {
      this.set({ message: t('pressPlay') });
      return;
    }
    const clicked = ours ? clickPlayControl() : clickHeroPlay();
    this.log(`автозапуск: ${ours ? 'play в нижнем плеере' : 'play на странице трека'} ${clicked ? 'нажат' : 'КНОПКА НЕ НАЙДЕНА'} (трек в плеере: ${p.trackId ?? '—'}, играет: ${p.playing})`);
    // Пауза 2 с и между неудачными попытками (раньше при ненайденной кнопке — 10 раз в секунду).
    this.lastClick = now;
    if (clicked) this.clicks++;
    else if (++this.misses === 3) {
      // Ищем дальше (раз в 2 с), но просим нажать play вручную — дальше трек подхватится сам.
      this.set({ message: t('pressPlay') });
      this.log('кнопка play не найдена — прошу нажать play вручную');
    }
  }

  /**
   * Переход на трек внутри SoundCloud (как клик по ссылке на сайте): страница не перезагружается,
   * захват звука вкладки продолжается. Если сайт всё же перезагрузит страницу,
   * задание подхватится заново через CONTENT_READY.
   */
  private openInPage(url: string) {
    if (this.onTrackPage()) return; // уже на странице трека: запустим кнопкой на ней
    // Возврата на прежнюю страницу больше нет: переходы туда-обратно путали вкладку.
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
  }

  /** Открыта ли страница трека по ссылке (без учёта регистра, хвоста и параметров). */
  private onTrackPage() {
    const here = location.pathname.toLowerCase().replace(/\/+$/, '');
    return !!this.linkPath && here === this.linkPath.toLowerCase().replace(/\/+$/, '');
  }

  /** Расширение обновили — эта копия скрипта больше не может с ним общаться: молча останавливаемся. */
  private shutdownOrphan() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.finishing = true; // больше ничего не запускать
  }

  private tick() {
    if (!extensionAlive()) return this.shutdownOrphan();
    if (this.finishing || !this.cacheReady || this.restarting) return;
    const p = readPlayer();
    if (this.state.mode === 'link') this.autoplay(p);

    if (p.pos === null || p.trackId === null) {
      this.set({ pos: null, message: this.state.mode === 'link' ? this.state.message : t('playInPlayer') });
      return;
    }
    const wall = Date.now();
    this.playing = p.playing;

    // Режим ссылки: во время распознавания заиграл другой трек — его звук не записываем,
    // ждём, пока вернётся трек по ссылке, и продолжаем с того же места.
    if (this.state.mode === 'link' && this.away) {
      if (isSameTrack(p.trackId, this.linkPath) && p.playing) {
        this.away = false;
        if (this.speed > 1) setMediaSpeed(this.speed);
        // Чуть раньше места остановки: перекрытие склеится без пропусков. Если перемотка
        // не сработает, трек просто распознается заново с текущего места.
        const dur = p.duration ?? this.state.duration;
        if (dur && !this.safe) seekViaUi(Math.max(0, this.lastOurPos - 2) / dur);
        this.log(`вернулся трек по ссылке, продолжение с ${Math.max(0, this.lastOurPos - 2).toFixed(1)}`);
        this.set({ message: this.listeningMessage() });
      }
      return;
    }

    if (p.trackId !== this.trackId) {
      if (this.state.mode === 'link') {
        if (this.linkStarted && !isSameTrack(p.trackId, this.linkPath)) {
          this.onOtherTrack();
          return;
        }
        // В нижнем плеере пока другой трек: ждём, пока заиграет наш.
        if (!isSameTrack(p.trackId, this.linkPath)) return;
        this.linkStarted = true;
      }
      this.trackId = p.trackId;
      for (const k of this.epochs.keys()) this.epochs.set(k, { valid: false });
      this.clock = new PlaybackClock();
      this.lastExact = -1;
      this.lastAdvance = wall;
      if (this.state.mode === 'link' && this.speedSetting !== 1) {
        // Распознавание по ссылке: трек играет без звука, поэтому его можно ускорить.
        // «Авто» подбирает скорость по длительности, чтобы уложиться примерно в 25 секунд.
        this.speed = pickSpeed(this.speedSetting, p.duration);
        // AudioShake чувствителен к качеству: выше ×4 Chrome срезает верхние частоты — в «Авто» не поднимаемся выше.
        if (this.config.audioshakeKey && this.speedSetting === 0) this.speed = Math.min(this.speed, AUTO_MAX_SPEED_AUDIOSHAKE);
        if (this.speed > 1) {
          setMediaSpeed(this.speed);
          this.clock.setRate(this.speed, wall);
        }
      }
      this.updateClock(p, wall);
      const hit = this.state.mode === 'karaoke' ? this.cache[trackKey(p.trackId)] : undefined;
      this.fromCache = !!hit;
      this.saved = false;
      this.set({
        lines: hit ? (hit.source === 'lrclib' ? hit.lines : dropTitleEcho(hit.lines, { title: hit.title, artist: hit.artist })).map((l) => ({ start: l.start, end: l.end, text: l.text, words: l.words ?? [] })) : [],
        coverage: hit ? [{ start: 0, end: hit.duration ?? 1e9 }] : [],
        title: p.title,
        artist: p.artist,
        artwork: p.artwork,
        duration: p.duration,
        playing: p.playing,
        fromCache: !!hit,
        synced: hit ? hit.synced !== false : true,
        source: hit ? (hit.source ?? 'scan') : null,
        message:
          this.state.mode === 'karaoke'
            ? hit
              ? hit.synced === false
                ? t('unsynced')
                : t('karaoke')
              : t('searching')
            : this.state.message,
        pos: this.clock.now(wall),
      });
      // Режим ссылки: перематываем трек в начало и включаем запись до старта — так
      // первые слова не теряются. Нужен доступ к медиа-элементу (точное время).
      if (this.state.mode === 'link' && p.exact !== null && !this.safe) this.restartFromZero(wall);
      else {
        this.newEpoch({ invalidatePrev: true, flush: false });
        if (this.state.mode === 'link') this.armPlayCheck(p);
      }
      if (this.state.mode === 'karaoke' && !hit) this.lookupLyrics(p);
      return;
    }

    const ev = this.updateClock(p, wall);
    if (ev === 'play' && this.awaitFirstPlay) {
      // Трек стартовал с начала, а запись уже идёт (эпоха открыта в restartFromZero).
      this.awaitFirstPlay = false;
    } else if (ev === 'seek') {
      // По ссылке «скачок» времени — это обычно подгрузка трека на ускорении или возврат после
      // чужого трека. Уже записанный звук остаётся верным (позиции считаются по истории часов),
      // поэтому распознанное до скачка не выбрасываем.
      if (this.state.mode === 'link') {
        this.log(`скачок времени до ${(p.exact ?? p.pos ?? 0).toFixed(1)} — запись продолжается`);
        this.newEpoch({ invalidatePrev: false, flush: true });
      } else this.newEpoch({ invalidatePrev: true, flush: false });
    }
    else if (ev === 'pause') this.newEpoch({ invalidatePrev: false, flush: true });
    else if (ev === 'play') this.newEpoch({ invalidatePrev: false, flush: false });
    if (this.state.mode === 'link' && this.autoplayDone) {
      if (ev === 'pause') this.set({ message: t('pausedRec') });
      else if (ev === 'play') this.set({ message: this.listeningMessage() });
    }

    const pos = this.clock.now(wall);
    this.set({
      pos,
      playing: p.playing,
      title: p.title,
      artist: p.artist,
      artwork: p.artwork,
      duration: p.duration ?? this.state.duration,
    });

    if (this.state.mode === 'link' && this.linkStarted) this.lastOurPos = pos;
    // Ускорение: если трек «встал» (SoundCloud не успевает подгружать) — снижаем скорость.
    // После страховки: если трек всё ещё стоит, ещё несколько раз нажимаем play (раз в 3 секунды).
    if (this.state.mode === 'link' && this.retryPlayUntil) {
      if (p.playing && p.exact !== null ? wall - this.lastAdvance < 400 : p.playing) this.retryPlayUntil = 0;
      else if (wall > this.retryPlayUntil) {
        this.retryPlayUntil = 0;
        this.log('повторы play не помогли — нужен ручной запуск');
        this.set({ message: t('pressPlay') });
      } else if (isSameTrack(p.trackId, this.linkPath) && wall - this.lastClick > 3000) {
        this.lastClick = wall;
        clickPlayControl();
        this.log('страховка: повторно нажат play');
      }
    }
    // Страховка: трек так и не пошёл после запуска — перестаём управлять плеером.
    if (this.state.mode === 'link' && this.playCheckFrom && !this.away) {
      const raw = p.exact ?? p.pos ?? 0;
      if (raw - this.checkPos > 0.5) this.playCheckFrom = 0; // пошёл
      else if (wall - this.playCheckFrom > 7000) this.fallbackToSimple(p);
    }
    if (this.state.mode === 'link' && !this.safe && this.speed > 1 && this.autoplayDone && p.playing && p.exact !== null && wall - this.lastAdvance > 3000) {
      this.log(`трек встал на ×${this.speed} — снижаю скорость`);
      this.speed = this.speed > 3 ? 3 : 1;
      setMediaSpeed(this.speed);
      this.lastAdvance = wall;
      this.playing = false;
      this.newEpoch({ invalidatePrev: false, flush: true }); // хвост на прежней скорости
      this.playing = true;
      this.newEpoch({ invalidatePrev: false, flush: false }); // дальше — на новой
      this.set({ message: t('slowedDown', { x: this.speed }) });
    }
    // Режим ссылки: трек доигран до конца.
    if (this.state.mode === 'link' && p.duration && pos >= p.duration - 1) this.finish().catch(() => {});
  }

  /** Режим ссылки: останавливает трек, дожидается последних результатов и сохраняет текст. */
  private async finish() {
    if (this.finishing) return;
    this.finishing = true;
    this.log(`конец трека: строк ${this.state.lines.length}`);
    this.set({ status: 'transcribing', message: t('finishing') });

    if (readPlayer().playing) clickPlayControl();
    if (this.speed > 1) setMediaSpeed(1);
    this.playing = false;
    this.newEpoch({ invalidatePrev: false, flush: true });

    // Финальный проход: весь записанный трек одним запросом (полный контекст песни).
    // Запускается сразу, не дожидаясь предварительных кусков: они распознаются параллельно,
    // а после финального результата уже не нужны.
    const viaAudioshake = !!this.config.audioshakeKey;
    this.set({ message: viaAudioshake ? t('audioshakePass') : t('finalPass') });
    this.log(`финальный проход: ${viaAudioshake ? 'AudioShake' : 'Whisper'}`);
    const finalDone = new Promise<void>((res) => {
      this.finalWaiter = res;
      setTimeout(res, viaAudioshake ? 300000 : 90000);
    });
    chrome.runtime.sendMessage({ type: 'FINAL_PASS' }).catch(() => {});
    await finalDone;
    if (!this.finalApplied) {
      // Финальный результат не пришёл или оказался хуже — дожидаемся предварительных кусков.
      this.log('финальный результат не принят — жду предварительные куски');
      await new Promise<void>((res) => {
        this.idleWaiter = res;
        setTimeout(res, 30000);
      });
    }
    // Второй вариант для DeepSeek — текст по предварительным кускам.
    this.altText = this.previewText || null;
    const finalText = this.state.lines.map((l) => l.text).join('\n');
    if (finalText === this.altText) this.altText = null; // второй вариант ничего не добавляет

    // Есть готовый текст без таймингов — берём его (он точнее распознавания), а время — из распознавания.
    const ref = this.referenceText();
    if (ref) {
      const al = alignLyrics(ref.lines.map((l) => l.text), this.state.lines);
      this.log(`синхронизация готового текста (${ref.source}): ${al ? `совпало ${Math.round(al.matched * 100)}% слов` : 'слишком мало совпадений — оставляю распознанный текст'}`);
      if (al) {
        this.set({ lines: al.lines as never });
        this.alignedFrom = ref.source as SavedResult['source'];
      }
    }

    // Ключ DeepSeek задан — исправляем неверно услышанные слова перед сохранением.
    if (this.config.deepseekKey && this.state.lines.length > 0 && !this.alignedFrom) {
      this.set({ message: t('correcting') });
      const res = await chrome.runtime
        .sendMessage({
          type: 'CORRECT_LYRICS',
          lines: this.state.lines.map((l) => ({ text: l.text })),
          title: this.state.title,
          artist: this.state.artist,
          alternative: this.altText,
        })
        .catch(() => null);
      const fixed = res?.ok ? applyCorrection(this.state.lines, res.raw) : null;
      if (fixed) {
        this.corrected = true;
        this.set({ lines: fixed });
      }
    }

    await this.saveResult();
    this.set({ status: 'idle', message: t('done') });
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }).catch(() => {});
  }

  private async saveResult() {
    if (this.saved) return;
    this.saved = true;
    const dur = this.state.duration;
    const result: SavedResult = {
      url: this.linkUrl ?? (this.trackId ? `https://soundcloud.com${this.trackId}` : null),
      title: this.state.title,
      artist: this.state.artist,
      artwork: this.state.artwork,
      duration: dur,
      lines: dropTitleEcho(this.state.lines, { title: this.state.title, artist: this.state.artist })
        .filter((l) => !dur || l.start < dur + 0.5)
        .map((l) => ({ start: l.start, end: l.end, text: l.text, words: l.words })),
      createdAt: Date.now(),
      source: this.alignedFrom ?? 'scan',
      alignedBy: this.alignedFrom ? 'audio' : undefined,
      synced: true,
      corrected: this.corrected,
      engine: this.engine,
    };
    try {
      const r = await chrome.storage.local.get('results');
      const all = (r.results as Record<string, SavedResult> | undefined) ?? {};
      if (this.trackId && result.lines.length > 0) all[trackKey(this.trackId)] = result;
      this.cache = pruneCache(all);
      await chrome.storage.local.set({ results: this.cache, lastResult: result });
    } catch {
      /* хранилище недоступно — не страшно */
    }
  }

  /** Караоке: трека нет в сохранённых — ищем готовый текст в LRCLIB (через фоновый скрипт). */
  private lookupLyrics(p: ReturnType<typeof readPlayer>) {
    const key = trackKey(p.trackId!);
    if (this.lookedUp.has(key)) {
      this.set({ message: t('notRecognized') });
      return;
    }
    this.lookedUp.add(key);
    chrome.runtime
      .sendMessage({ type: 'LOOKUP_TRACK', path: key, title: p.title, artist: p.artist, artwork: p.artwork, duration: p.duration })
      .then((res) => {
        // Если нашли — фоновый скрипт сохранил текст, и reloadCache() подхватит его сам.
        if (!res?.ok && this.trackId && trackKey(this.trackId) === key) this.set({ message: t('notRecognized') });
      })
      .catch(() => this.set({ message: t('notRecognized') }));
  }

  /**
   * Режим ссылки: готового текста в начале не нашли (например, не удалось узнать название трека) —
   * ищем ещё раз по названию из плеера. Нашёлся текст с таймингами — распознавать незачем,
   * показываем его. Без таймингов — он пригодится в конце: подгоним его под распознанный звук.
   */
  private lookupDuringScan(p: ReturnType<typeof readPlayer>) {
    const key = this.linkPath ? trackKey(this.linkPath) : p.trackId ? trackKey(p.trackId) : null;
    if (!key || this.cache[key] || this.lookedUp.has(key) || !p.title) return;
    this.lookedUp.add(key);
    this.log(`ищу готовый текст по названию из плеера: «${p.title}» — ${p.artist ?? '?'}`);
    chrome.runtime
      .sendMessage({ type: 'LOOKUP_TRACK', path: key, title: p.title, artist: p.artist, artwork: p.artwork, duration: p.duration })
      .then(async (res) => {
        if (!res?.ok || this.state.mode !== 'link' || this.finishing) return;
        const r = await chrome.storage.local.get('results').catch(() => ({}) as Record<string, unknown>);
        const hit = (r.results as Record<string, SavedResult> | undefined)?.[key];
        if (!hit) return;
        this.cache[key] = hit;
        this.log(`найден готовый текст: ${hit.source}, ${hit.synced ? 'с таймингами' : 'без таймингов'}, строк ${hit.lines.length}`);
        if (hit.synced && hit.lines.length > 0) {
          this.saved = true; // распознанное сохранять не нужно
          await chrome.storage.local.set({ lastResult: hit }).catch(() => {});
          this.set({ message: t('foundReady') });
          chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }).catch(() => {});
        }
      })
      .catch(() => {});
  }

  /** Готовый текст без таймингов для этого трека (Genius и т.п.) — его подгоним под звук. */
  private referenceText(): SavedResult | null {
    const key = this.linkPath ? trackKey(this.linkPath) : this.trackId ? trackKey(this.trackId) : null;
    const r = key ? this.cache[key] : undefined;
    return r && r.source && r.source !== 'scan' && r.synced === false && !r.alignedBy && r.lines.length > 0 ? r : null;
  }

  /** Хранилище обновилось (например, закончилось распознавание по ссылке в другой вкладке). */
  reloadCache(results: Record<string, SavedResult> | undefined) {
    this.cache = results ?? {};
    // Караоке на ещё не распознанном треке: пробуем подхватить появившийся текст.
    if (this.state.active && this.state.mode === 'karaoke' && !this.fromCache) this.trackId = null;
  }

  onChunk(msg: ChunkResultMessage) {
    if (this.state.mode !== 'link') return;
    const info = this.epochs.get(msg.epoch);
    if (!info || !info.valid) return;
    const startPos = this.clock.positionAt(msg.startWall);
    if (startPos === null) return;

    const trackStart = startPos + this.config.syncOffsetMs / 1000;
    const shift = (s: RawSegment): RawSegment => ({
      ...s,
      start: s.start + trackStart,
      end: s.end + trackStart,
      words: (s.words ?? []).map((w) => ({ ...w, start: w.start + trackStart, end: w.end + trackStart })),
    });
    let incoming = dropRepeatedRuns(cleanSegments(msg.response.segments.map(shift))).filter(
      (l) => !isTitleEcho(l.text, { title: this.state.title, artist: this.state.artist }), // модель вставила название песни
    );
    if (info.cutoff !== undefined) incoming = incoming.filter((l) => l.start < info.cutoff!);
    const win: Range = { start: trackStart, end: trackStart + msg.durationSec };
    if (msg.final) {
      this.log(`финальный результат (${msg.engine ?? 'whisper'}): сегментов ${msg.response.segments.length}`);
      // Финальный проход заменяет строки по кускам, но только если он не хуже по объёму текста
      // (пустой или обрезанный ответ не должен стереть уже распознанное).
      const inWin = this.state.lines.filter((l) => (l.start + l.end) / 2 >= win.start && (l.start + l.end) / 2 <= win.end);
      const words = (ls: { text: string }[]) => ls.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
      if (words(incoming) < words(inWin) * 0.5) return;
      if (!this.finalApplied) this.previewText = this.state.lines.map((l) => l.text).join('\n');
      this.finalApplied = true;
    } else if (this.finalApplied) {
      return; // предварительный кусок пришёл после финального результата — он только хуже
    }
    const { lines, trusted } = mergeChunk(this.state.lines, incoming, win, {
      edge: this.config.overlapSec / 2,
      first: msg.first,
      last: msg.last,
    });
    this.set({ lines, coverage: addRange(this.state.coverage, trusted) });
    if (msg.final && msg.engine) this.engine = msg.engine;
  }
}
