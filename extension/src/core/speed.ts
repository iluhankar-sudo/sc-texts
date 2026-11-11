/** Подбор ускорения трека при распознавании по ссылке. */

/** Цель режима «Авто»: уложить прослушивание примерно в столько секунд. */
export const AUTO_TARGET_SEC = 25;
/**
 * Баланс скорости и точности. Трек играет быстрее без сохранения тона, и Chrome срезает частоты
 * выше (половина частоты дискретизации) / скорость. При 48 кГц на ×3 остаётся звук до 8 кГц —
 * ровно столько, сколько получает Whisper (16 кГц), то есть потерь для распознавания нет.
 * Выше ×3 начинают теряться шипящие («с», «ш», «ц»), и модель ошибается чаще.
 */
export const AUTO_MAX_SPEED = 3;
/** AudioShake получает звук полнее (до 32 кГц), поэтому для него «Авто» не выше ×2,5 (звук до ~9,6 кГц). */
export const AUTO_MAX_SPEED_AUDIOSHAKE = 2.5;
export const MAX_SPEED = 8;

/**
 * setting: 0 — «Авто» (по длительности), иначе фиксированная скорость.
 * Возвращает скорость, округлённую до 0.5.
 */
export function pickSpeed(setting: number, durationSec: number | null): number {
  if (setting >= 1) return Math.min(MAX_SPEED, setting);
  if (!durationSec || durationSec <= 0) return 3;
  const s = Math.min(AUTO_MAX_SPEED, Math.max(2, durationSec / AUTO_TARGET_SEC));
  return Math.ceil(s * 2) / 2;
}

/** Длина окна распознавания (секунды трека): при ускорении — длиннее, чтобы было меньше запросов. */
export function windowFor(baseWindowSec: number, speed: number): number {
  return speed > 1 ? Math.max(baseWindowSec, 40) : baseWindowSec;
}
