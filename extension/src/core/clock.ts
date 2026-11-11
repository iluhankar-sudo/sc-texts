export type ClockEvent = 'none' | 'seek' | 'play' | 'pause';

interface Anchor {
  wall: number;
  pos: number;
  playing: boolean;
  /** Скорость воспроизведения (секунд трека за секунду). */
  rate: number;
}

/**
 * Часы воспроизведения. Плеер SoundCloud показывает время с точностью до секунды,
 * поэтому позиция уточняется по моментам смены целой секунды (опрос ~100 мс даёт ±0.1 с),
 * а между ними интерполируется. Хранит историю якорей, чтобы позже узнать позицию
 * трека в произвольный прошлый момент (начало аудиоокна).
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

  /** Текущая оценка позиции. */
  now(wall: number): number {
    const a = this.anchor;
    return a.playing ? a.pos + ((wall - a.wall) / 1000) * a.rate : a.pos;
  }

  /** Меняет скорость воспроизведения (позиция до этого момента сохраняется). */
  setRate(rate: number, wall: number) {
    if (!(rate > 0) || rate === this.rate) return;
    const pos = this.now(wall);
    this.rate = rate;
    if (this.ready) this.setAnchor(pos, wall);
  }

  /** Точное время из медиа-элемента: якорь ставится по нему на каждом опросе. */
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
    // В историю пишем не чаще раза в 250 мс (и при скачках), чтобы она покрывала длинные окна.
    if (jump || (playing && wall - this.anchor.wall >= 250) || (!playing && pos !== this.anchor.pos)) this.setAnchor(pos, wall);
    return jump ? 'seek' : 'none';
  }

  /** Позиция трека в момент wall (мс, Date.now) по истории якорей; null, если истории нет. */
  positionAt(wall: number): number | null {
    let found: Anchor | null = null;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i]!.wall <= wall) {
        found = this.history[i]!;
        break;
      }
    }
    if (!found) {
      // Момент чуть раньше первой отметки (кусок звука пришёл раньше первого сообщения о времени):
      // отсчитываем назад от первой отметки, если до неё не больше 2 секунд.
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
