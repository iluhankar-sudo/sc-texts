/** Choosing the track speed-up for link recognition. */

/** "Auto" target: fit the listening into roughly this many seconds. */
export const AUTO_TARGET_SEC = 25;
/**
 * Balancing speed and accuracy. The track plays faster without preserving pitch, and Chrome cuts frequencies
 * above (half the sample rate) / speed. At 48 kHz and x3, audio up to 8 kHz remains -
 * exactly what Whisper gets (16 kHz), so there is no loss for recognition.
 * Above x3 sibilants ("s", "sh", "ts") start to get lost and the model makes more mistakes.
 */
export const AUTO_MAX_SPEED = 3;
/** AudioShake gets fuller audio (up to 32 kHz), so "Auto" doesn't go above x2.5 for it (audio up to ~9.6 kHz). */
export const AUTO_MAX_SPEED_AUDIOSHAKE = 2.5;
export const MAX_SPEED = 8;

/**
 * setting: 0 - "Auto" (by duration), otherwise a fixed speed.
 * Returns the speed rounded to 0.5.
 */
export function pickSpeed(setting: number, durationSec: number | null): number {
  if (setting >= 1) return Math.min(MAX_SPEED, setting);
  if (!durationSec || durationSec <= 0) return 3;
  const s = Math.min(AUTO_MAX_SPEED, Math.max(2, durationSec / AUTO_TARGET_SEC));
  return Math.ceil(s * 2) / 2;
}

/** Recognition window length (track seconds): longer when sped up, for fewer requests. */
export function windowFor(baseWindowSec: number, speed: number): number {
  return speed > 1 ? Math.max(baseWindowSec, 40) : baseWindowSec;
}
