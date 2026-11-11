import type { Range } from './types.ts';

/** Добавляет интервал, склеивая пересекающиеся. Возвращает новый массив. */
export function addRange(ranges: Range[], r: Range): Range[] {
  if (r.end <= r.start) return ranges;
  const all = [...ranges, r].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const x of all) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end + 0.05) last.end = Math.max(last.end, x.end);
    else out.push({ start: x.start, end: x.end });
  }
  return out;
}

export function isCovered(ranges: Range[], t: number): boolean {
  return ranges.some((r) => t >= r.start && t < r.end);
}
