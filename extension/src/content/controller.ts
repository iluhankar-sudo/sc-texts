/**
 * Page controller: polls the player, keeps the playback clock,
 * manages capture "epochs" and builds lines from recognition results.
 *
 * An epoch is a continuous stretch of playback. It changes on pause, resume,
 * seek and track change. Seeking and track changes invalidate earlier results;
 * pause and resume do not (the track position continues).
 *
 * Modes:
 *  - link: the track was opened from a link, the controller starts it itself, the tab audio
 *    is recognized to the end of the track, the lyrics are saved to chrome.storage.local
 *    (results per track + lastResult), then capture stops;
 *  - karaoke: no capture or recognition - the track's saved lyrics
 *    are highlighted in sync with the player.
 */
import { PlaybackClock } from '../core/clock.ts';
import { DEFAULT_CONFIG } from '../core/config.ts';
import { reconcileChorus } from '../core/chorus.ts';
import { cleanSegments, dropRepeatedRuns, dropTitleEcho, isTitleEcho, tightenStart } from '../core/filter.ts';
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
import { estimateTimings } from '../core/lyrics.ts';

export type CaptureMode = 'karaoke' | 'link';

export interface StartOptions {
  mode: CaptureMode;
  url?: string | null;
  path?: string | null;
  /** Open the track inside SoundCloud and return to the previous page once it plays. */
  inPage?: boolean;
  /** Speed-up during recognition (link mode only): 0 - "Auto", otherwise 1-8. */
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
  /** Track position in seconds (clock estimate), or null if the player is not found. */
  pos: number | null;
  duration: number | null;
  title: string | null;
  artist: string | null;
  artwork: string | null;
  playing: boolean;
  /** The lyrics come from saved ones (the track was recognized before); no recognition is running. */
  fromCache: boolean;
  /** The lyrics have line timings (otherwise karaoke shows them without highlighting). */
  synced: boolean;
  /** Where the lyrics come from. */
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
  /** cutoff: results of the epoch after this track position are dropped (another track was playing there). */
  private epochs = new Map<number, { valid: boolean; cutoff?: number }>();
  private trackId: string | null = null;
  private playing = false;
  private timer: number | null = null;

  // link mode
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
  /** The final result was accepted: preview chunks after it are no longer needed. */
  private finalApplied = false;
  /** The lyrics come from a ready source and were synced to the audio. */
  private alignedFrom: SavedResult['source'] | null = null;
  /** Lyrics from preview chunks (before the final pass) - the second hypothesis for the AI correction. */
  private previewText = '';
  private speedSetting = 1; // setting: 0 - "Auto"
  private speed = 1; // actual track speed-up during link recognition
  private lastExact = -1;
  private lastAdvance = 0; // when the exact time last moved
  private restarting = false; // the track is being rewound to the start before recording
  private awaitFirstPlay = false; // recording is running, waiting for the track to start
  private away = false; // another track started during recognition - waiting for ours to come back
  private lastOurPos = 0; // last position of the linked track
  private corrected = false; // lyrics were fixed by the AI
  private altText: string | null = null; // lyrics from chunks - the second hypothesis for the AI correction
  private engine: 'whisper' | 'audioshake' | 'gemini' = 'whisper';
  /** How many windows Gemini has checked during playback. */
  private geminiChunks = 0;
  /** Gemini started checking at least one window (it is available). */
  private geminiTried = false;
  private safe = false; // simple mode: don't control the player (setting, or the safeguard kicked in)
  private playCheckFrom = 0; // since when we expect the track to be playing (0 - no check needed)
  private checkPos = 0;
  private retryPlayUntil = 0; // after the safeguard: keep retrying play until this moment
  private logBuf: string[] = [];
  private logTimer: number | null = null; // page to return to after the track starts

  // saved lyrics
  private cache: Record<string, SavedResult> = {};
  private cacheReady = false;
  private fromCache = false;
  private saved = false;
  private lookedUp = new Set<string>(); // tracks we already looked up ready lyrics for

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** Snapshot for the popup: the track position as of the request, not the last tick. */
  getSnapshot = () =>
    this.state.active && this.state.pos !== null && this.trackId ? { ...this.state, pos: this.clock.now(Date.now()) } : this.state;

  private set(patch: Partial<PanelState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  start(config: Config, opts: StartOptions = { mode: 'karaoke' }) {
    this.config = config;
    this.clock = new PlaybackClock();
    this.trackId = null; // the first tick acts as a track change and sends RESET
    this.epochs.clear();
    this.linkUrl = opts.url ?? null;
    this.speedSetting = opts.mode === 'link' ? Math.min(8, Math.max(0, opts.speed ?? 1)) : 1;
    this.speed = 1;
    this.away = false;
    this.lastOurPos = 0;
    this.corrected = false;
    this.altText = null;
    this.engine = 'whisper';
    this.geminiChunks = 0;
    this.geminiTried = false;
    this.safe = opts.mode === 'link' && config.simpleMode;
    if (this.safe) this.speedSetting = 1;
    this.playCheckFrom = 0;
    if (opts.mode === 'link') {
      this.logBuf = [];
      this.log(`start: ${opts.url ?? '?'} speed=${opts.speed ?? 1} simple=${this.safe} model=${config.apiModel} language=${config.language}`);
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

  /** Log for "Copy report" in settings (without keys or lyrics). */
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
    if (status === 'error' || status === 'lagging') this.log(`status ${status}: ${message ?? ''}`);
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

  /** The offscreen document has processed the whole queue. */
  onIdle() {
    this.idleWaiter?.();
    this.idleWaiter = null;
  }

  /** The final pass has finished (successfully or not). */
  /** Gemini couldn't check a window (quota, mismatch, error) - only for the report. */
  onGeminiStarted() {
    this.geminiTried = true;
  }

  onGeminiNote(error: string) {
    this.log(`gemini: ${error}`);
  }

  onFinalDone() {
    this.finalWaiter?.();
    this.finalWaiter = null;
  }

  private newEpoch(opts: { invalidatePrev: boolean; flush: boolean; trimLead?: boolean }) {
    if (this.state.mode === 'karaoke') return; // karaoke does not touch capture
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
   * Link mode: another track started in the player. If ours has already finished, this is a normal end.
   * Otherwise recording pauses (the other track's audio doesn't get into the lyrics), and the linked track
   * is opened and started again; it continues from where it stopped (see the start of tick()).
   */
  private onOtherTrack() {
    this.log(`another track in the player (ours at ${this.lastOurPos.toFixed(1)} of ${this.state.duration ?? '?'})`);
    const dur = this.state.duration;
    if (dur && this.lastOurPos >= dur - 3) {
      this.finish().catch(() => {});
      return;
    }
    this.away = true;
    // The tail of the current window is still being recognized - drop everything after the switch point.
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

  /** Remember where the track should start from - for the safeguard. */
  private armPlayCheck(p: ReturnType<typeof readPlayer>) {
    this.playCheckFrom = Date.now();
    this.checkPos = p.exact ?? p.pos ?? 0;
  }

  /** The track didn't start within 7 seconds: normal speed, press play once, and then just listen. */
  private fallbackToSimple(p: ReturnType<typeof readPlayer>) {
    this.log(`SAFEGUARD: the track didn't start within 7 s (playing: ${p.playing}, position ${(p.exact ?? p.pos ?? 0).toFixed(1)}) - simple mode`);
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
   * Pause → seek to 0 → recording on → start the track.
   * Silence before the start is trimmed in offscreen (trimLead), so the first window starts exactly at the song's start.
   */
  private restartFromZero(_wall: number) {
    // Everything is done with SoundCloud's own controls (pause, click on the progress bar, play), not directly
    // through the media element: otherwise the site's player loses sync and the track may not play.
    this.restarting = true;
    this.awaitFirstPlay = true;
    if (readPlayer().playing) clickPlayControl(); // pause
    setTimeout(() => {
      const q0 = readPlayer();
      if ((q0.exact ?? q0.pos ?? 0) > 0.3) {
        const ok = seekViaUi(0); // to the start if the track has already played a bit
        this.log(`seek to start via the progress bar: ${ok ? 'done' : 'PROGRESS BAR NOT FOUND'}`);
      }
      if (this.speed > 1) setMediaSpeed(this.speed); // the speed applies on start
      setTimeout(() => {
        const q = readPlayer();
        const now = Date.now();
        const start = q.exact ?? q.pos ?? 0; // actual position (if the seek didn't work, start from there)
        this.clock = new PlaybackClock();
        if (this.speed > 1) this.clock.setRate(this.speed, now);
        this.clock.updateExact(start, false, now);
        this.lastExact = start;
        this.lastAdvance = now;
        this.playing = true; // recording turns on before the start: leading silence gets trimmed
        this.set({ pos: start, lines: [], coverage: [] });
        this.newEpoch({ invalidatePrev: true, flush: false, trimLead: true });
        setTimeout(() => {
          const before = readPlayer();
          if (!before.playing) clickPlayControl(); // start
          this.log(`restart from the beginning: position ${start.toFixed(1)}, play ${before.playing ? 'not needed' : 'pressed'}, speed x${this.speed}`);
          this.lastAdvance = Date.now();
          this.restarting = false;
          this.armPlayCheck(readPlayer());
        }, 300);
      }, 300);
    }, 200);
  }

  /** Clock from the player's exact time (if available) or whole seconds. */
  private updateClock(p: ReturnType<typeof readPlayer>, wall: number) {
    if (p.exact !== null) {
      // The track is loading (time stands still though the button shows "playing") - treat it as a pause,
      // so we don't record silence instead of the song or break the timings.
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

  /** Link mode: presses play until the right track is playing. */
  private autoplay(p: ReturnType<typeof readPlayer>) {
    if (this.autoplayDone) return;
    const ours = isSameTrack(p.trackId, this.linkPath);
    if (ours && p.playing) {
      this.autoplayDone = true;
      this.log(`track started: position=${(p.exact ?? p.pos ?? 0).toFixed(1)} duration=${p.duration ?? '?'} exact time=${p.exact !== null}`);
      this.set({ message: this.listeningMessage() });
      this.lookupDuringScan(p);
      return;
    }
    const now = Date.now();
    if (now - this.lastClick < 2000) return;
    // Another track is in the bottom player (SoundCloud loads the last played one into a new tab) -
    // pause it first, then start ours with the button on the page.
    if (!ours && p.playing) {
      clickPlayControl();
      this.lastClick = now;
      this.log(`another track is playing in the player (${p.trackId ?? '-'}) - pausing`);
      return;
    }
    if (this.clicks >= MAX_AUTOPLAY_CLICKS) {
      this.set({ message: t('pressPlay') });
      return;
    }
    const clicked = ours ? clickPlayControl() : clickHeroPlay();
    this.log(`autoplay: ${ours ? 'play in the bottom player' : 'play on the track page'} ${clicked ? 'pressed' : 'BUTTON NOT FOUND'} (track in player: ${p.trackId ?? '-'}, playing: ${p.playing})`);
    // Wait 2 s between failed attempts too (previously, with no button found, it was 10 times a second).
    this.lastClick = now;
    if (clicked) this.clicks++;
    else if (++this.misses === 3) {
      // Keep looking (every 2 s), but ask the user to press play manually - the track will be picked up after that.
      this.set({ message: t('pressPlay') });
      this.log('play button not found - asking the user to press play');
    }
  }

  /**
   * Navigate to the track inside SoundCloud (like clicking a link on the site): the page doesn't reload,
   * tab capture continues. If the site does reload the page,
   * the job is picked up again via CONTENT_READY.
   */
  private openInPage(url: string) {
    if (this.onTrackPage()) return; // already on the track page: start it with the button there
    // No more returning to the previous page: going back and forth confused the tab.
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
  }

  /** Whether the linked track's page is open (ignoring case, trailing parts and query). */
  private onTrackPage() {
    const here = location.pathname.toLowerCase().replace(/\/+$/, '');
    return !!this.linkPath && here === this.linkPath.toLowerCase().replace(/\/+$/, '');
  }

  /** The extension was updated - this script copy can no longer talk to it: stop quietly. */
  private shutdownOrphan() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.finishing = true; // don't start anything else
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

    // Link mode: another track started during recognition - don't record its audio,
    // wait for the linked track to come back and continue from the same place.
    if (this.state.mode === 'link' && this.away) {
      if (isSameTrack(p.trackId, this.linkPath) && p.playing) {
        this.away = false;
        if (this.speed > 1) setMediaSpeed(this.speed);
        // Slightly before the stop point: the overlap will be stitched without gaps. If the seek
        // doesn't work, the track is simply recognized again from the current position.
        const dur = p.duration ?? this.state.duration;
        if (dur && !this.safe) seekViaUi(Math.max(0, this.lastOurPos - 2) / dur);
        this.log(`the linked track is back, continuing from ${Math.max(0, this.lastOurPos - 2).toFixed(1)}`);
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
        // Another track is still in the bottom player: wait for ours to play.
        if (!isSameTrack(p.trackId, this.linkPath)) return;
        this.linkStarted = true;
      }
      this.trackId = p.trackId;
      for (const k of this.epochs.keys()) this.epochs.set(k, { valid: false });
      this.clock = new PlaybackClock();
      this.lastExact = -1;
      this.lastAdvance = wall;
      if (this.state.mode === 'link' && this.speedSetting !== 1) {
        // Link recognition: the track plays muted, so it can be sped up.
        // "Auto" picks the speed by duration to fit into roughly 25 seconds.
        this.speed = pickSpeed(this.speedSetting, p.duration);
        // AudioShake is sensitive to quality: above x4 Chrome cuts the high frequencies, so "Auto" doesn't go higher.
        if (this.config.audioshakeKey && this.speedSetting === 0) this.speed = Math.min(this.speed, AUTO_MAX_SPEED_AUDIOSHAKE);
        if (this.speed > 1) {
          setMediaSpeed(this.speed);
          this.clock.setRate(this.speed, wall);
        }
      }
      this.updateClock(p, wall);
      const hit = this.state.mode === 'karaoke' ? this.cacheFor(p.trackId) : undefined;
      this.fromCache = !!hit;
      // Lyrics without timings: lines are spread over the track duration (no recognition).
      const approx = !!hit && hit.synced === false && !!p.duration;
      const hitLines = hit
        ? approx
          ? estimateTimings(hit.lines.map((l) => l.text), p.duration!)
          : hit.source === 'lrclib'
            ? hit.lines
            : shiftOldScan(hit, dropTitleEcho(hit.lines, { title: hit.title, artist: hit.artist }))
        : [];
      this.saved = false;
      this.set({
        lines: hitLines.map((l) => ({ start: l.start, end: l.end, text: l.text, words: l.words ?? [] })),
        coverage: hit ? [{ start: 0, end: hit.duration ?? 1e9 }] : [],
        title: p.title,
        artist: p.artist,
        artwork: p.artwork,
        duration: p.duration,
        playing: p.playing,
        fromCache: !!hit,
        synced: hit ? hit.synced !== false || approx : true,
        source: hit ? (hit.source ?? 'scan') : null,
        message:
          this.state.mode === 'karaoke'
            ? hit
              ? approx
                ? t('karaokeApprox')
                : hit.synced === false
                  ? t('unsynced')
                  : t('karaoke')
              : t('searching')
            : this.state.message,
        pos: this.clock.now(wall),
      });
      // Link mode: rewind the track to the start and turn recording on before it starts - so
      // the first words are not lost. Requires access to the media element (exact time).
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
      // The track started from the beginning while recording is already on (epoch opened in restartFromZero).
      this.awaitFirstPlay = false;
    } else if (ev === 'seek') {
      // In link mode a time "jump" is usually the track loading at speed or coming back after
      // another track. Audio already recorded stays correct (positions come from the clock history),
      // so what was recognized before the jump is kept.
      if (this.state.mode === 'link') {
        this.log(`time jump to ${(p.exact ?? p.pos ?? 0).toFixed(1)} - recording continues`);
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
    // Speed-up: if the track "stalls" (SoundCloud can't load fast enough), lower the speed.
    // After the safeguard: if the track is still stuck, press play a few more times (every 3 seconds).
    if (this.state.mode === 'link' && this.retryPlayUntil) {
      if (p.playing && p.exact !== null ? wall - this.lastAdvance < 400 : p.playing) this.retryPlayUntil = 0;
      else if (wall > this.retryPlayUntil) {
        this.retryPlayUntil = 0;
        this.log('repeated play attempts failed - manual start needed');
        this.set({ message: t('pressPlay') });
      } else if (isSameTrack(p.trackId, this.linkPath) && wall - this.lastClick > 3000) {
        this.lastClick = wall;
        clickPlayControl();
        this.log('safeguard: play pressed again');
      }
    }
    // Safeguard: the track never started after launch - stop controlling the player.
    if (this.state.mode === 'link' && this.playCheckFrom && !this.away) {
      const raw = p.exact ?? p.pos ?? 0;
      if (raw - this.checkPos > 0.5) this.playCheckFrom = 0; // started
      else if (wall - this.playCheckFrom > 7000) this.fallbackToSimple(p);
    }
    if (this.state.mode === 'link' && !this.safe && this.speed > 1 && this.autoplayDone && p.playing && p.exact !== null && wall - this.lastAdvance > 3000) {
      this.log(`track stalled at x${this.speed} - lowering the speed`);
      this.speed = this.speed > 3 ? 3 : 1;
      setMediaSpeed(this.speed);
      this.lastAdvance = wall;
      this.playing = false;
      this.newEpoch({ invalidatePrev: false, flush: true }); // the tail at the previous speed
      this.playing = true;
      this.newEpoch({ invalidatePrev: false, flush: false }); // the rest at the new one
      this.set({ message: t('slowedDown', { x: this.speed }) });
    }
    // Link mode: the track has played to the end.
    if (this.state.mode === 'link' && p.duration && pos >= p.duration - 1) this.finish().catch(() => {});
  }

  /** Link mode: stops the track, waits for the last results and saves the lyrics. */
  private async finish() {
    if (this.finishing) return;
    this.finishing = true;
    this.log(`end of track: ${this.state.lines.length} lines`);
    this.set({ status: 'transcribing', message: t('finishing') });

    if (readPlayer().playing) clickPlayControl();
    if (this.speed > 1) setMediaSpeed(1);
    this.playing = false;
    this.newEpoch({ invalidatePrev: false, flush: true });

    // Gemini already checked the lyrics while the track played: no final pass, just wait for the last
    // windows (Whisper and Gemini) - a few seconds instead of re-sending the whole track.
    if ((this.geminiTried || this.geminiChunks > 0) && !this.config.audioshakeKey) {
      this.set({ message: t('almostDone') });
      await new Promise<void>((res) => {
        this.idleWaiter = res;
        setTimeout(res, 40000);
      });
      this.log(`gemini checked ${this.geminiChunks} windows`);
    }
    if (this.geminiChunks > 0 && !this.config.audioshakeKey) this.engine = 'gemini';
    else await this.wholeTrackPass();
    await this.afterRecognition();
  }

  /** Final pass: the whole recorded track in one request (full song context). */
  private async wholeTrackPass() {
    // It starts right away without waiting for the preview chunks: they are recognized in parallel,
    // and are no longer needed after the final result.
    const viaAudioshake = !!this.config.audioshakeKey;
    this.set({ message: viaAudioshake ? t('audioshakePass') : t('finalPass') });
    this.log(`final pass: ${viaAudioshake ? 'AudioShake' : 'Whisper'}`);
    const finalDone = new Promise<void>((res) => {
      this.finalWaiter = res;
      setTimeout(res, viaAudioshake ? 300000 : 90000);
    });
    chrome.runtime.sendMessage({ type: 'FINAL_PASS' }).catch(() => {});
    await finalDone;
    if (!this.finalApplied) {
      // The final result didn't arrive or was worse - wait for the preview chunks.
      this.log('final result not accepted - waiting for the preview chunks');
      await new Promise<void>((res) => {
        this.idleWaiter = res;
        setTimeout(res, 30000);
      });
    }
  }

  /** Chorus check, ready lyrics, AI correction, saving. */
  private async afterRecognition() {
    // The second hypothesis for the AI correction: lyrics from the preview chunks.
    this.altText = this.previewText || null;
    const finalText = this.state.lines.map((l) => l.text).join('\n');
    if (finalText === this.altText) this.altText = null; // the second hypothesis adds nothing

    // Chorus: repeats are cross-checked, errors in one repeat are fixed using the others.
    if (this.state.lines.length > 3) {
      const ch = reconcileChorus(this.state.lines);
      this.log(`chorus: ${ch.groups.length} repeated groups, ${ch.fixed} lines fixed`);
      if (ch.fixed) this.set({ lines: ch.lines });
    }

    // There are ready lyrics without timings - use them (more accurate than recognition), with timings from recognition.
    const ref = this.referenceText();
    if (ref) {
      const al = alignLyrics(ref.lines.map((l) => l.text), this.state.lines);
      this.log(`syncing ready lyrics (${ref.source}): ${al ? `${Math.round(al.matched * 100)}% of words matched` : 'too few matches - keeping the recognized lyrics'}`);
      if (al) {
        this.set({ lines: al.lines as never });
        this.alignedFrom = ref.source as SavedResult['source'];
      }
    }

    // Otherwise fix misheard words with a language model: DeepSeek with your own key, or free via Groq.
    if ((this.config.deepseekKey || this.config.mode === 'cloud') && this.state.lines.length > 0 && !this.alignedFrom && this.engine !== 'gemini') {
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
      timing: 2,
    };
    try {
      const r = await chrome.storage.local.get('results');
      const all = (r.results as Record<string, SavedResult> | undefined) ?? {};
      const prev = this.trackId ? all[trackKey(this.trackId)] : undefined;
      // Don't overwrite pinned lyrics - except when syncing those same lyrics to the audio (the pin is kept).
      if (this.trackId && result.lines.length > 0 && (!prev?.pinned || this.alignedFrom)) {
        all[trackKey(this.trackId)] = prev?.pinned ? { ...result, pinned: true } : result;
      }
      this.cache = pruneCache(all);
      await chrome.storage.local.set({ results: this.cache, lastResult: prev?.pinned && this.alignedFrom ? { ...result, pinned: true } : result });
    } catch {
      /* storage unavailable - not a problem */
    }
  }

  /** Karaoke: the track isn't saved - look up ready lyrics (via the background script). */
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
        // If found, the background script saved the lyrics and reloadCache() picks them up.
        if (!res?.ok && this.trackId && trackKey(this.trackId) === key) this.set({ message: t('notRecognized') });
      })
      .catch(() => this.set({ message: t('notRecognized') }));
  }

  /**
   * Link mode: no ready lyrics were found at the start (e.g. the track title couldn't be determined) -
   * search again by the title from the player. Found timed lyrics - no need to recognize,
   * show them. Untimed lyrics are useful at the end: we'll fit them to the recognized audio.
   */
  private lookupDuringScan(p: ReturnType<typeof readPlayer>) {
    const key = this.linkPath ? trackKey(this.linkPath) : p.trackId ? trackKey(p.trackId) : null;
    if (!key || this.cache[key] || this.lookedUp.has(key) || !p.title) return;
    this.lookedUp.add(key);
    this.log(`looking up ready lyrics by the player title: "${p.title}" - ${p.artist ?? '?'}`);
    chrome.runtime
      .sendMessage({ type: 'LOOKUP_TRACK', path: key, title: p.title, artist: p.artist, artwork: p.artwork, duration: p.duration })
      .then(async (res) => {
        if (!res?.ok || this.state.mode !== 'link' || this.finishing) return;
        const r = await chrome.storage.local.get('results').catch(() => ({}) as Record<string, unknown>);
        const hit = (r.results as Record<string, SavedResult> | undefined)?.[key];
        if (!hit) return;
        this.cache[key] = hit;
        this.log(`found ready lyrics: ${hit.source}, ${hit.synced ? 'timed' : 'untimed'}, ${hit.lines.length} lines`);
        if (hit.synced && hit.lines.length > 0) {
          this.saved = true; // no need to save the recognition
          await chrome.storage.local.set({ lastResult: hit }).catch(() => {});
          this.set({ message: t('foundReady') });
          chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }).catch(() => {});
        }
      })
      .catch(() => {});
  }

  /** Saved lyrics for the track; the SoundCloud player sometimes shows "/undefined/title" - then match by title. */
  private cacheFor(trackId: string): SavedResult | undefined {
    const direct = this.cache[trackKey(trackId)];
    if (direct) return direct;
    const k = Object.keys(this.cache).find((key) => isSameTrack(trackId, key));
    return k ? this.cache[k] : undefined;
  }

  /** Ready lyrics without timings for this track (Genius etc.) - to be fitted to the audio. */
  private referenceText(): SavedResult | null {
    const key = this.linkPath ? trackKey(this.linkPath) : this.trackId ? trackKey(this.trackId) : null;
    const r = key ? this.cache[key] : undefined;
    return r && r.source && r.source !== 'scan' && r.synced === false && !r.alignedBy && r.lines.length > 0 ? r : null;
  }

  /** Storage changed (e.g. link recognition finished in another tab). */
  reloadCache(results: Record<string, SavedResult> | undefined) {
    this.cache = results ?? {};
    // Karaoke on a not-yet-recognized track: try to pick up newly saved lyrics.
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
      (l) => !isTitleEcho(l.text, { title: this.state.title, artist: this.state.artist }), // the model inserted the song title
    );
    if (info.cutoff !== undefined) incoming = incoming.filter((l) => l.start < info.cutoff!);
    const win: Range = { start: trackStart, end: trackStart + msg.durationSec };
    if (msg.final) {
      this.log(`final result (${msg.engine ?? 'whisper'}): ${msg.response.segments.length} segments`);
      // The final pass replaces the chunk lines, but only if it is not smaller in text volume
      // (an empty or truncated reply must not erase what was already recognized).
      const inWin = this.state.lines.filter((l) => (l.start + l.end) / 2 >= win.start && (l.start + l.end) / 2 <= win.end);
      const words = (ls: { text: string }[]) => ls.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
      if (words(incoming) < words(inWin) * 0.5) return;
      if (!this.finalApplied) this.previewText = this.state.lines.map((l) => l.text).join('\n');
      this.finalApplied = true;
    } else if (this.finalApplied) {
      return; // a preview chunk arrived after the final result - it can only be worse
    }
    const { lines, trusted } = mergeChunk(this.state.lines, incoming, win, {
      edge: this.config.overlapSec / 2,
      first: msg.first,
      last: msg.last,
    });
    // The chorus is cross-checked right away, not only at the end: when a repeat is heard, it shows the same text,
    // and words heard differently are chosen by the majority of repeats.
    const ch = lines.length > 3 ? reconcileChorus(lines) : null;
    this.set({ lines: ch ? ch.lines : lines, coverage: addRange(this.state.coverage, trusted) });
    if (msg.final && msg.engine) this.engine = msg.engine;
    if (msg.gemini) this.geminiChunks++;
  }
}

/**
 * Lyrics recognized before the capture-latency fix (timing < 2) are about half a second
 * late - karaoke shifts them earlier. Ready lyrics with timings (LRCLIB, NetEase, Kugou) are left alone.
 */
const OLD_SCAN_SHIFT = 0.5;
function shiftOldScan<L extends { start: number; end: number; words?: { start: number; end: number }[] }>(
  hit: { source?: string; alignedBy?: string; timing?: number },
  lines: L[],
): L[] {
  const recognized = !hit.source || hit.source === 'scan' || hit.alignedBy === 'audio';
  if (!recognized) return lines;
  // Lines that start "on the intro" (stretched first word) start at the first sung word.
  lines = lines.map((l) => (l.words?.length ? (tightenStart(l as never) as unknown as L) : l));
  if ((hit.timing ?? 0) >= 2) return lines;
  const sh = (x: number) => Math.max(0, x - OLD_SCAN_SHIFT);
  return lines.map((l) => ({ ...l, start: sh(l.start), end: sh(l.end), words: l.words?.map((w) => ({ ...w, start: sh(w.start), end: sh(w.end) })) }));
}

