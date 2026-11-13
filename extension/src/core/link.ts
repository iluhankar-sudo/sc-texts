/** Parsing SoundCloud track links. */

export interface TrackLink {
  /** Normalized URL that we open in the tab. */
  url: string;
  /** Lowercase track path (/artist/track), or null for on.soundcloud.com short links. */
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

/** Whether this track is playing in the player (trackId is the player's path, may have a tail). */
export function isSameTrack(trackId: string | null, path: string | null): boolean {
  if (!trackId) return false;
  if (!path) return true; // short link: the path isn't known in advance
  const t = trackId.toLowerCase().replace(/\/+$/, '');
  if (t === path || t.startsWith(`${path}/`)) return true;
  // SoundCloud sometimes shows "/undefined/track-name" in the bottom player (the artist name
  // hasn't loaded yet) - then compare only the track name.
  const [, artist, track] = t.split('/');
  const [, wantArtist, wantTrack] = path.split('/');
  return (artist === 'undefined' || artist === '') && !!track && track === wantTrack && !!wantArtist;
}

/**
 * Track URL from the page a short link leads to (if the redirect didn't give it right away):
 * <link rel="canonical"> or <meta property="og:url">.
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
