// sc texts: script in the SoundCloud page context (world: MAIN).
// 1) Speeds up playback during link recognition (without preserving pitch,
//    so the extension can precisely "stretch" the audio back before recognition).
// 2) Reports the exact playback time (currentTime) instead of whole seconds from the player.
(() => {
  if (window.__scTextsHook) return;
  window.__scTextsHook = true;
  const media = new Set();
  let rate = 1;
  let lastActive = null; // the last element that played (SoundCloud keeps it outside the DOM)

  const apply = (m) => {
    try {
      m.preservesPitch = rate === 1;
      if (m.playbackRate !== rate) m.playbackRate = rate;
    } catch (_) {}
  };
  const track = (m) => {
    if (media.has(m)) return;
    media.add(m);
    // SoundCloud may reset the rate - restore the one we need.
    m.addEventListener('ratechange', () => {
      if (rate !== 1 && m.playbackRate !== rate) apply(m);
    });
    m.addEventListener('playing', () => {
      lastActive = m;
    });
    apply(m);
  };

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    track(this);
    lastActive = this;
    apply(this); // the right speed right at start, before the first sound
    return origPlay.apply(this, args);
  };

  const current = () => {
    document.querySelectorAll('audio, video').forEach(track);
    // First whatever is playing now; otherwise the last one that played (even paused at the start).
    for (const m of media) if (!m.paused) return m;
    if (lastActive && media.has(lastActive)) return lastActive;
    for (const m of media) if (m.isConnected) return m;
    return null;
  };

  window.addEventListener('sctexts:speed', (e) => {
    rate = Math.min(16, Math.max(1, Number(e.detail) || 1));
    current();
    media.forEach(apply);
  });

  // Link recognition: pause the track at the very start, then play it -
  // so recording starts before the track and the first words are not lost.
  window.addEventListener('sctexts:control', (e) => {
    let d;
    try {
      d = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    const m = current();
    if (!m) return;
    if (d.action === 'prepare') {
      if (d.speed) rate = Math.min(16, Math.max(1, Number(d.speed) || 1));
      apply(m);
      try { m.pause(); } catch (_) {}
      try { m.currentTime = 0; } catch (_) {}
    } else if (d.action === 'seek') {
      apply(m);
      try { m.currentTime = Math.max(0, Number(d.time) || 0); } catch (_) {}
    } else if (d.action === 'play') {
      try {
        const r = m.play();
        if (r && r.catch) r.catch(() => {});
      } catch (_) {}
    }
  });

  window.addEventListener('sctexts:query', () => {
    const m = current();
    const detail = m
      ? JSON.stringify({ time: m.currentTime, paused: m.paused, rate: m.playbackRate, duration: m.duration })
      : '';
    window.dispatchEvent(new CustomEvent('sctexts:time', { detail }));
  });
})();
