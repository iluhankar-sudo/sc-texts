/** Saved lyrics per track (for karaoke without re-recognition). */

export interface CachedLine {
  start: number;
  end: number;
  text: string;
  words?: { word: string; start: number; end: number; prob: number }[];
  chorus?: boolean;
  raw?: string;
}

export interface CachedResult {
  url: string | null;
  title: string | null;
  artist: string | null;
  artwork: string | null;
  duration: number | null;
  lines: CachedLine[];
  createdAt: number;
  /** Where the lyrics come from: recognized from audio or a ready source. */
  source?: 'scan' | 'lrclib' | 'genius' | 'netease' | 'kugou';
  /** The user pinned the lyrics to the track: for this link they are shown right away, without lookup or recognition. */
  pinned?: boolean;
  /** Ready lyrics without timings whose timings were fitted to the recognized audio. */
  alignedBy?: 'audio';
  /** Whether there are line timings (without them karaoke doesn't highlight lines). */
  synced?: boolean;
  /** The lyrics were fixed by a language model. */
  corrected?: boolean;
  /** Which engine recognized the final lyrics. */
  engine?: 'whisper' | 'audioshake';
  /** 2 - recognition timings corrected for capture latency (older ones were recorded slightly late). */
  timing?: number;
  /** The lyrics were edited by hand. */
  edited?: boolean;
}

export const CACHE_LIMIT = 30;

/** Track key from the player path: /artist/track in lowercase, without a trailing slash. */
export function trackKey(trackId: string): string {
  return trackId.toLowerCase().split('?')[0]!.replace(/\/+$/, '');
}

/** Keeps the max most recent entries. */
export function pruneCache<T extends { createdAt: number; pinned?: boolean }>(map: Record<string, T>, max = CACHE_LIMIT): Record<string, T> {
  // Pinned lyrics are never evicted; the limit applies to the rest.
  const entries = Object.entries(map).sort((a, b) => b[1].createdAt - a[1].createdAt);
  const pinned = entries.filter(([, v]) => v.pinned);
  const rest = entries.filter(([, v]) => !v.pinned).slice(0, max);
  return Object.fromEntries([...pinned, ...rest]);
}

/** Share of the track duration covered by recognized windows. */
export function coveredRatio(ranges: { start: number; end: number }[], duration: number): number {
  if (!duration || duration <= 0) return 0;
  let covered = 0;
  for (const r of ranges) covered += Math.max(0, Math.min(r.end, duration) - Math.max(r.start, 0));
  return Math.min(1, covered / duration);
}
