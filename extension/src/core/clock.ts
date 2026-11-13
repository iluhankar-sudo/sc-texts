export type ClockEvent = 'none' | 'seek' | 'play' | 'pause';

interface Anchor {
  wall: number;
  pos: number;
  playing: boolean;
  /** Playback rate (track seconds per second). */
  rate: number;
}

/**
 * Playback clock. The SoundCloud player shows time to the second,
 * so the position is refined at the moments the whole second changes (~100 ms polling gives ±0.1 s)
 * and interpolated in between. It keeps a history of anchors to later find the track
 * position at an arbitrary past moment (the start of an audio window).
 */
export class PlaybackClock {
  private anchor: Anchor = { wall: 0, pos: 0, playing: false, rate: 1 };
  private playing = false;
  private rate = 1;
  private ready = false;
  private lastObserved = -1;
  private history: Anchor[] = [];

  update(observed: number, playing: boolean, wall: number): ClockEvent {
    if (!this.ready) {
      this.ready = true;
      this.playing = playing;
      this.lastObserved = observed;
      this.setAnchor(observed + 0.5, wall);
      return 'none';
    }
    if (playing !== this.playing) {
      const est = this.now(wall);
      this.playing = playing;
      this.lastObserved = observed;
      if (!playing) {
        this.setAnchor(est, wall);
        return 'pause';
      }
      this.setAnchor(observed + 0.5, wall);
      return 'play';
    }
    if (!playing) {
      if (Math.abs(observed + 0.5 - this.anchor.pos) > 1.5) {
        this.lastObserved = observed;
        this.setAnchor(observed + 0.5, wall);
        return 'seek';
      }
      return 'none';
    }
    const est = this.now(wall);
    if (Math.abs(observed + 0.5 - est) > 2.0) {
      this.lastObserved = observed;
      this.setAnchor(observed + 0.5, wall);
      return 'seek';
    }
    if (observed !== this.lastObserved) {
      const tickEdge = observed === this.lastObserved + 1;
      this.lastObserved = observed;
      this.setAnchor(tickEdge ? observed : observed + 0.5, wall);
    }
    return 'none';
  }

  /** Current position estimate. */
  now(wall: number): number {
    const a = this.anchor;
    return a.playing ? a.pos + ((wall - a.wall) / 1000) * a.rate : a.pos;
  }

  /** Changes the playback rate (the position up to this moment is kept). */
  setRate(rate: number, wall: number) {
    if (!(rate > 0) || rate === this.rate) return;
    const pos = this.now(wall);
    this.rate = rate;
    if (this.ready) this.setAnchor(pos, wall);
  }

  /** Exact time from the media element: the anchor is set from it on every poll. */
  updateExact(pos: number, playing: boolean, wall: number): ClockEvent {
    if (!this.ready) {
      this.ready = true;
      this.playing = playing;
      this.setAnchor(pos, wall);
      return 'none';
    }
    if (playing !== this.playing) {
      this.playing = playing;
      this.setAnchor(pos, wall);
      return playing ? 'play' : 'pause';
    }
    const jump = Math.abs(pos - this.now(wall)) > 1.0;
    // Write to the history at most every 250 ms (and on jumps) so it covers long windows.
    if (jump || (playing && wall - this.anchor.wall >= 250) || (!playing && pos !== this.anchor.pos)) this.setAnchor(pos, wall);
    return jump ? 'seek' : 'none';
  }

  /** Track position at moment wall (ms, Date.now) from the anchor history; null if there is no history. */
  positionAt(wall: number): number | null {
    let found: Anchor | null = null;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i]!.wall <= wall) {
        found = this.history[i]!;
        break;
      }
    }
    if (!found) {
      // A moment slightly before the first anchor (an audio chunk arrived before the first time report):
      // count back from the first anchor if it is no more than 2 seconds away.
      const first = this.history[0];
      if (!first || first.wall - wall > 2000) return null;
      return first.playing ? Math.max(0, first.pos - ((first.wall - wall) / 1000) * first.rate) : first.pos;
    }
    return found.playing ? found.pos + ((wall - found.wall) / 1000) * found.rate : found.pos;
  }

  private setAnchor(pos: number, wall: number) {
    this.anchor = { wall, pos, playing: this.playing, rate: this.rate };
    this.history.push(this.anchor);
    if (this.history.length > 3000) this.history.splice(0, this.history.length - 3000);
  }
}
