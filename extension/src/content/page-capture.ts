/**
 * Запись звука вкладки с разрешения пользователя (системное окно Chrome «Показать эту вкладку?»).
 *
 * Обычный способ (chrome.tabCapture) требует клика по иконке расширения. Этот — кнопки на самой
 * странице: getDisplayMedia с preferCurrentTab показывает окно с одной вкладкой (этой) и кнопкой
 * «Разрешить». Звук трека для пользователя глушится (suppressLocalAudioPlayback), а сам звук
 * кусками уходит в offscreen-документ расширения — там тот же конвейер распознавания.
 */

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let port: chrome.runtime.Port | null = null;

export type PageCaptureError = 'denied' | 'noAudio' | 'failed';

/** Спросить разрешение и получить звук вкладки. Вызывать только из обработчика клика. */
export async function requestTabAudio(): Promise<MediaStreamTrack | PageCaptureError> {
  let s: MediaStream;
  try {
    s = await navigator.mediaDevices.getDisplayMedia({
      video: true, // без видео Chrome окно не покажет; видеодорожку сразу останавливаем
      audio: { suppressLocalAudioPlayback: true },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
    } as DisplayMediaStreamOptions);
  } catch (err) {
    console.warn('[sc texts] getDisplayMedia:', (err as Error)?.name, (err as Error)?.message);
    return (err as DOMException)?.name === 'NotAllowedError' ? 'denied' : 'failed';
  }
  for (const v of s.getVideoTracks()) v.stop();
  const audio = s.getAudioTracks()[0];
  if (!audio) {
    for (const tr of s.getTracks()) tr.stop();
    return 'noAudio'; // в окне Chrome сняли галочку «Звук вкладки»
  }
  stream = s;
  return audio;
}

/** Передавать звук в расширение (после того как фоновый скрипт подготовил распознавание). */
export function startStreaming(audio: MediaStreamTrack, onEnded: () => void) {
  ctx = new AudioContext();
  void ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(new MediaStream([audio]));
  // ScriptProcessor, а не AudioWorklet: модулю worklet на чужой странице может помешать её политика безопасности.
  const sp = ctx.createScriptProcessor(4096, 2, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(sp);
  sp.connect(mute);
  mute.connect(ctx.destination);
  port = chrome.runtime.connect({ name: 'sctexts-pcm' });
  port.onDisconnect.addListener(() => {
    port = null;
  });
  const sr = ctx.sampleRate;
  // Звук блока прозвучал раньше, чем сработал onaudioprocess: ScriptProcessor держит ещё один
  // буфер, плюс задержка самого захвата вкладки. Без поправки при ускорении ×2.5–3 строки
  // получали время позже настоящего (на ускорении каждая миллисекунда задержки — ~3 мс трека).
  const lagMs = (4096 / sr) * 1000 + (ctx.baseLatency || 0) * 1000 + CAPTURE_LAG_MS;
  sp.onaudioprocess = (e) => {
    if (!port) return;
    const a = e.inputBuffer.getChannelData(0);
    const b = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : a;
    const pcm = new Int16Array(a.length);
    for (let i = 0; i < a.length; i++) {
      const v = Math.max(-1, Math.min(1, (a[i]! + b[i]!) / 2));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    try {
      port.postMessage({ sr, w: Date.now() - lagMs, d: toBase64(pcm) });
    } catch {
      port = null;
    }
  };
  // Пользователь нажал «Остановить» на полоске Chrome «Вы показываете эту вкладку».
  audio.addEventListener('ended', onEnded);
}

export function stopPageCapture() {
  for (const tr of stream?.getTracks() ?? []) tr.stop();
  stream = null;
  void ctx?.close().catch(() => {});
  ctx = null;
  try {
    port?.disconnect();
  } catch {
    /* уже закрыт */
  }
  port = null;
}

export function pageCaptureActive() {
  return !!stream;
}

function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Задержка захвата звука вкладки (getDisplayMedia) до попадания в страницу, мс — оценка. */
const CAPTURE_LAG_MS = 60;
