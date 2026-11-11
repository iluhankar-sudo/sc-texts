import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readPlayer, SELECTORS } from '../src/content/player.ts';

/** Минимальная заглушка Document: селектор → элемент. */
function fakeDoc(map: Record<string, { text?: string; attrs?: Record<string, string>; classes?: string[] }>) {
  const el = (d: { text?: string; attrs?: Record<string, string>; classes?: string[] }) => ({
    textContent: d.text ?? '',
    getAttribute: (n: string) => d.attrs?.[n] ?? null,
    classList: { contains: (c: string) => (d.classes ?? []).includes(c) },
  });
  return {
    querySelector: (sel: string) => (map[sel] ? el(map[sel]!) : null),
    querySelectorAll: () => [],
  } as unknown as Document;
}

test('readPlayer reads time, duration, state and track', () => {
  const doc = fakeDoc({
    [SELECTORS.timePassedVisible]: { text: '1:23' },
    [SELECTORS.durationVisible]: { text: '3:45' },
    [SELECTORS.playButton]: { classes: ['playControl', 'playing'] },
    [SELECTORS.titleLink]: { attrs: { href: '/artist/track?in=x', title: 'Track name' } },
  });
  assert.deepEqual(readPlayer(doc), {
    trackId: '/artist/track',
    title: 'Track name',
    artist: null,
    artwork: null,
    pos: 83,
    duration: 225,
    playing: true,
    exact: null,
    rate: 1,
  });
});

test('readPlayer falls back to aria-valuenow and reports paused/empty', () => {
  const doc = fakeDoc({
    [SELECTORS.progress]: { attrs: { 'aria-valuenow': '42.7' } },
    [SELECTORS.playButton]: { classes: ['playControl'] },
  });
  const p = readPlayer(doc);
  assert.equal(p.pos, 42);
  assert.equal(p.playing, false);
  assert.equal(p.trackId, null);
});

import { artworkUrl } from '../src/content/player.ts';

test('artworkUrl extracts and upsizes SoundCloud artwork', () => {
  assert.equal(
    artworkUrl('background-image: url("https://i1.sndcdn.com/artworks-abc-t50x50.jpg");'),
    'https://i1.sndcdn.com/artworks-abc-t500x500.jpg',
  );
  assert.equal(artworkUrl('url(&quot;https://i1.sndcdn.com/avatars-x-large.jpg&quot;)'), 'https://i1.sndcdn.com/avatars-x-t500x500.jpg');
  assert.equal(artworkUrl('https://i1.sndcdn.com/artworks-y-t120x120.png'), 'https://i1.sndcdn.com/artworks-y-t500x500.png');
  assert.equal(artworkUrl('url("https://example.com/a.jpg")'), null);
  assert.equal(artworkUrl(null), null);
});
