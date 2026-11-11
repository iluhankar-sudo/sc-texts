// sc texts: скрипт в контексте страницы SoundCloud (world: MAIN).
// 1) Ускоряет воспроизведение трека при распознавании по ссылке (без сохранения высоты тона,
//    чтобы расширение могло точно «растянуть» звук обратно перед распознаванием).
// 2) Отдаёт точное время воспроизведения (currentTime), а не целые секунды из плеера.
(() => {
  if (window.__scTextsHook) return;
  window.__scTextsHook = true;
  const media = new Set();
  let rate = 1;
  let lastActive = null; // последний элемент, который играл (SoundCloud держит его вне страницы)

  const apply = (m) => {
    try {
      m.preservesPitch = rate === 1;
      if (m.playbackRate !== rate) m.playbackRate = rate;
    } catch (_) {}
  };
  const track = (m) => {
    if (media.has(m)) return;
    media.add(m);
    // SoundCloud может сбрасывать скорость — возвращаем нужную.
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
    apply(this); // нужная скорость — сразу при запуске, до первого звука
    return origPlay.apply(this, args);
  };

  const current = () => {
    document.querySelectorAll('audio, video').forEach(track);
    // Сначала то, что играет сейчас; иначе — последний игравший (даже на паузе в начале).
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

  // Распознавание по ссылке: поставить трек на паузу в самом начале, затем запустить —
  // так запись звука начинается раньше, чем трек, и первые слова не теряются.
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
