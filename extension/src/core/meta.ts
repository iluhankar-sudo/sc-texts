/**
 * Название и исполнитель трека, когда официальный oEmbed SoundCloud не ответил:
 * из HTML страницы трека или, в крайнем случае, из самой ссылки.
 */

export interface PageMeta {
  title: string;
  uploader: string | null;
  artwork: string | null;
  duration: number | null;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .trim();

function metaContent(html: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`, 'i');
  const m = re1.exec(html) ?? re2.exec(html);
  return m?.[1] ? decode(m[1]) : null;
}

/** Метаданные из HTML страницы трека SoundCloud (og:title, twitter:audio:artist_name, <title>, длительность). */
export function metaFromHtml(html: string): PageMeta | null {
  let title = metaContent(html, 'og:title') ?? metaContent(html, 'twitter:title');
  let uploader = metaContent(html, 'twitter:audio:artist_name') ?? metaContent(html, 'soundcloud:user');
  if (uploader && /^https?:/.test(uploader)) uploader = null;
  // <title>Название by Исполнитель | Listen online for free on SoundCloud</title>
  const docTitle = /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  if (docTitle) {
    const t = decode(docTitle).replace(/\s*\|\s*[^|]*SoundCloud.*$/i, '').replace(/^Stream\s+/i, '');
    const by = /^(.*)\s+by\s+(.+)$/i.exec(t);
    if (by) {
      title ??= by[1]!.trim();
      uploader ??= by[2]!.trim();
    } else title ??= t;
  }
  if (!title) return null;
  const artwork = metaContent(html, 'og:image');
  // "duration":214567 в данных страницы (мс)
  const dur = /"duration"\s*:\s*(\d{4,8})/.exec(html)?.[1];
  return { title, uploader, artwork, duration: dur ? Math.round(Number(dur) / 1000) : null };
}

/** Последний шанс: «/okishslay3r/song-for-love-feat-kinderlil» → «okishslay3r», «song for love feat kinderlil». */
export function metaFromPath(path: string | null): PageMeta | null {
  const parts = (path ?? '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const words = (s: string) => decodeURIComponent(s).replace(/[-_]+/g, ' ').replace(/\s+\d{5,}$/, '').trim();
  const title = words(parts[1]!);
  if (!title) return null;
  return { title, uploader: words(parts[0]!), artwork: null, duration: null };
}
