/** "1:23" → 83, "1:02:03" → 3723, иначе null. */
export function parseClock(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /(\d+):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (m[3] !== undefined) return a * 3600 + b * 60 + Number(m[3]);
  return a * 60 + b;
}
