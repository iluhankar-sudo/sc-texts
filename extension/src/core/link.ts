/** Разбор ссылки на трек SoundCloud. */

export interface TrackLink {
  /** Нормализованный адрес, который открываем во вкладке. */
  url: string;
  /** Путь трека в нижнем регистре (/artist/track) или null для коротких ссылок on.soundcloud.com. */
  path: string | null;
}

const NOT_TRACK = new Set(['sets', 'likes', 'tracks', 'albums', 'reposts', 'followers', 'following', 'popular-tracks', 'comments']);

export function parseTrackUrl(input: string): TrackLink | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host === 'on.soundcloud.com') {
    const code = u.pathname.split('/').filter(Boolean)[0];
    return code ? { url: `https://on.soundcloud.com/${code}`, path: null } : null;
  }
  if (!['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(host)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [artist, track] = parts as [string, string];
  if (NOT_TRACK.has(track.toLowerCase())) return null;
  return { url: `https://soundcloud.com/${artist}/${track}`, path: `/${artist}/${track}`.toLowerCase() };
}

/** Тот ли трек играет в плеере (trackId — путь из плеера, может содержать хвост). */
export function isSameTrack(trackId: string | null, path: string | null): boolean {
  if (!trackId) return false;
  if (!path) return true; // короткая ссылка: путь заранее неизвестен
  const t = trackId.toLowerCase().replace(/\/+$/, '');
  if (t === path || t.startsWith(`${path}/`)) return true;
  // SoundCloud иногда показывает в нижнем плеере «/undefined/название-трека» (имя исполнителя
  // ещё не подгрузилось) — тогда сверяем только название трека.
  const [, artist, track] = t.split('/');
  const [, wantArtist, wantTrack] = path.split('/');
  return (artist === 'undefined' || artist === '') && !!track && track === wantTrack && !!wantArtist;
}

/**
 * Адрес трека со страницы, на которую ведёт короткая ссылка (если перенаправление не дало его сразу):
 * <link rel="canonical"> или <meta property="og:url">.
 */
export function trackUrlFromHtml(html: string): TrackLink | null {
  const m =
    html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ??
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i) ??
    html.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:url["']/i);
  const link = m ? parseTrackUrl(m[1]!) : null;
  return link?.path ? link : null;
}
