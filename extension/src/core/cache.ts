/** Сохранённые тексты треков (для караоке без повторного распознавания). */

export interface CachedLine {
  start: number;
  end: number;
  text: string;
  words?: { word: string; start: number; end: number; prob: number }[];
}

export interface CachedResult {
  url: string | null;
  title: string | null;
  artist: string | null;
  artwork: string | null;
  duration: number | null;
  lines: CachedLine[];
  createdAt: number;
  /** Откуда текст: распознан по звуку или взят из LRCLIB. */
  source?: 'scan' | 'lrclib' | 'genius' | 'netease' | 'kugou';
  /** Пользователь закрепил текст за треком: по этой ссылке он показывается сразу, без поиска и распознавания. */
  pinned?: boolean;
  /** Готовый текст без таймингов, которому тайминги подобраны по распознанному звуку. */
  alignedBy?: 'audio';
  /** Есть ли тайминги строк (без них караоке не подсвечивает строки). */
  synced?: boolean;
  /** Текст исправлен языковой моделью (DeepSeek). */
  corrected?: boolean;
  /** Кто распознал финальный текст. */
  engine?: 'whisper' | 'audioshake';
  /** 2 — тайминги распознавания с поправкой на задержку захвата звука (старые записаны чуть позже). */
  timing?: number;
  /** Текст исправлен вручную. */
  edited?: boolean;
}

export const CACHE_LIMIT = 30;

/** Ключ трека по пути из плеера: /artist/track в нижнем регистре, без хвостового слэша. */
export function trackKey(trackId: string): string {
  return trackId.toLowerCase().split('?')[0]!.replace(/\/+$/, '');
}

/** Оставляет max самых свежих записей. */
export function pruneCache<T extends { createdAt: number; pinned?: boolean }>(map: Record<string, T>, max = CACHE_LIMIT): Record<string, T> {
  // Закреплённые тексты не вытесняются никогда; лимит — для остальных.
  const entries = Object.entries(map).sort((a, b) => b[1].createdAt - a[1].createdAt);
  const pinned = entries.filter(([, v]) => v.pinned);
  const rest = entries.filter(([, v]) => !v.pinned).slice(0, max);
  return Object.fromEntries([...pinned, ...rest]);
}

/** Доля длительности трека, покрытая распознанными окнами. */
export function coveredRatio(ranges: { start: number; end: number }[], duration: number): number {
  if (!duration || duration <= 0) return 0;
  let covered = 0;
  for (const r of ranges) covered += Math.max(0, Math.min(r.end, duration) - Math.max(r.start, 0));
  return Math.min(1, covered / duration);
}
