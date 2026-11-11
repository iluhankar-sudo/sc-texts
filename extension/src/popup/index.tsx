import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { normalizeConfig } from '../core/config.ts';
import { activeIndex, upcomingIndex, wordIndex } from '../core/sync.ts';
import type { CaptureState, Language, Line } from '../core/types.ts';

interface Snapshot {
  active: boolean;
  status: CaptureState;
  message: string;
  lines: Line[];
  pos: number | null;
  title: string | null;
}

const STATUS_LABEL: Record<CaptureState, string> = {
  idle: 'Выключено',
  listening: 'Слушаю',
  transcribing: 'Распознаю',
  lagging: 'Не успевает',
  error: 'Ошибка',
};

const LANGS: { id: Language; label: string }[] = [
  { id: 'auto', label: 'Авто' },
  { id: 'ru', label: 'RU' },
  { id: 'en', label: 'EN' },
];

const isSoundCloud = (url?: string) => !!url && /^https:\/\/soundcloud\.com\//.test(url);

function App() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [captureTab, setCaptureTab] = useState<number | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [lang, setLang] = useState<Language>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tabRef = useRef<chrome.tabs.Tab | null>(null);

  useEffect(() => {
    void (async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabRef.current = t ?? null;
      setTab(t ?? null);
      setLang(normalizeConfig(await chrome.storage.local.get(null)).language);
    })();
  }, []);

  useEffect(() => {
    const tick = async () => {
      const cap = (await chrome.storage.session.get('capture')).capture as { tabId: number } | undefined;
      setCaptureTab(cap?.tabId ?? null);
      const t = tabRef.current;
      if (t?.id !== undefined && isSoundCloud(t.url)) {
        try {
          setSnap(((await chrome.tabs.sendMessage(t.id, { type: 'GET_STATE' })) as Snapshot) ?? null);
        } catch {
          setSnap(null);
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 200);
    return () => window.clearInterval(id);
  }, []);

  const onSC = isSoundCloud(tab?.url);
  const capturing = tab?.id !== undefined && captureTab === tab.id;
  const otherTab = captureTab !== null && !capturing;

  const start = useCallback(async () => {
    if (tab?.id === undefined) return;
    setBusy(true);
    setError('');
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const r = await chrome.runtime.sendMessage({ type: 'POPUP_START', tabId: tab.id, streamId });
      if (r?.error) setError(r.error);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [tab]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({ type: 'POPUP_STOP' });
      setSnap(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const pickLang = (l: Language) => {
    setLang(l);
    void chrome.storage.local.set({ language: l });
  };

  const live = capturing && snap?.active === true;
  const status: CaptureState = live ? snap!.status : 'idle';
  const lines = live ? snap!.lines : [];
  const pos = live ? snap!.pos : null;

  const idx = pos === null ? -1 : activeIndex(lines, pos);
  const focus = idx >= 0 ? idx : pos === null ? -1 : Math.max(0, (upcomingIndex(lines, pos) === -1 ? lines.length : upcomingIndex(lines, pos)) - 1);
  const word = idx >= 0 && pos !== null ? wordIndex(lines[idx]!.words, pos) : -1;

  const focusRef = useRef<HTMLDivElement | null>(null);
  const prevFocus = useRef(-2);
  useEffect(() => {
    if (focus !== prevFocus.current) {
      prevFocus.current = focus;
      focusRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });

  const title = live ? snap!.title : null;
  let subtitle: string;
  if (!onSC) subtitle = 'Откройте soundcloud.com';
  else if (otherTab) subtitle = 'Захват идёт в другой вкладке';
  else if (!live) subtitle = capturing ? 'Подключаюсь…' : 'Готово к запуску';
  else subtitle = snap!.status === 'listening' || snap!.status === 'transcribing' ? STATUS_LABEL[status] : snap!.message || STATUS_LABEL[status];

  let empty: { icon: string; head: string; text: string } | null = null;
  if (!onSC) empty = { icon: '♪', head: 'Это не SoundCloud', text: 'Перейдите на soundcloud.com и включите трек.' };
  else if (!live) empty = { icon: '♪', head: 'Текст песни появится здесь', text: 'Включите трек в плеере и нажмите «Начать».' };
  else if (lines.length === 0) empty = { icon: '…', head: 'Слушаю трек', text: snap!.message || 'Первые строки появятся через 10–15 секунд.' };

  const errorText = status === 'error' ? snap!.message : error;

  return (
    <>
      <div className="head">
        <img className="logo" src="icons/48.png" alt="" />
        <div className="brand">
          <h1>AI Lyrics</h1>
          <p>Субтитры к трекам SoundCloud</p>
        </div>
        <button className="icon-btn" aria-label="Настройки" title="Настройки" onClick={() => chrome.runtime.openOptionsPage()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </div>

      <div className={`card now${live ? ' live' : ''}`}>
        <div className="eq" aria-hidden="true"><i /><i /><i /><i /></div>
        <div className="meta">
          <div className="name">{title ?? 'Сейчас играет'}</div>
          <div className="sub">
            <span className={`dot ${status}`} />
            <span>{subtitle}</span>
          </div>
        </div>
      </div>

      <div className="controls">
        {capturing || otherTab ? (
          <button className="btn stop" onClick={() => void stop()} disabled={busy}>
            ■ Остановить
          </button>
        ) : (
          <button className="btn" onClick={() => void start()} disabled={busy || !onSC} aria-disabled={busy || !onSC}>
            ▶ Начать
          </button>
        )}
        <div className="seg" role="group" aria-label="Язык песни">
          {LANGS.map((l) => (
            <button key={l.id} aria-pressed={lang === l.id} onClick={() => pickLang(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {errorText && <div className="notice bad">{errorText}</div>}
      {capturing && !live && !errorText && snap === null && (
        <div className="notice">Если подключение не идёт, обновите страницу SoundCloud (F5).</div>
      )}
      {live && status === 'lagging' && <div className="notice">{snap!.message}</div>}

      <div className="lyrics-wrap">
        {empty ? (
          <div className="empty">
            <div className="note" aria-hidden="true">{empty.icon}</div>
            <b>{empty.head}</b>
            <span>{empty.text}</span>
          </div>
        ) : (
          <div className="lyrics" aria-live="polite">
            <div className="pad" />
            {lines.map((l, i) => (
              <div
                key={`${l.start}-${i}`}
                ref={i === focus ? focusRef : undefined}
                className={`ly${i === idx ? ' on' : ''}${i < focus ? ' past' : ''}`}
              >
                {i === idx && l.words.length > 0
                  ? l.words.map((w, k) => (
                      <span key={k} className={`w${k <= word ? ' on' : ''}`}>
                        {k > 0 ? ' ' : ''}
                        {w.word}
                      </span>
                    ))
                  : l.text}
              </div>
            ))}
            <div className="pad" />
          </div>
        )}
      </div>

      <div className="foot">Текст идёт с задержкой около 10–15 секунд. Язык применится при следующем запуске.</div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
