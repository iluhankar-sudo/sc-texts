/** Mono downsampling Float32 → Int16 with averaging (a simple low-pass filter) to dstRate. */
export function toMono16k(input: Float32Array, srcRate: number, dstRate = 16000): Int16Array {
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s0 = Math.floor(i * ratio);
    const s1 = Math.min(input.length, Math.max(s0 + 1, Math.ceil((i + 1) * ratio)));
    let sum = 0;
    for (let j = s0; j < s1; j++) sum += input[j]!;
    const v = Math.max(-1, Math.min(1, sum / (s1 - s0)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/**
 * Audio for Whisper: mono 16 kHz, without bass and with levelled volume.
 * - High-pass ~120 Hz (2nd-order Butterworth): kick and bass carry almost no voice but "clog" the model.
 * - Peak normalization to -1 dBFS (gain at most x8): quiet tracks are recognized as well as loud ones.
 */
export function toAsrPcm(input: Float32Array, srcRate: number, dstRate = 16000): Int16Array {
  const f = toMonoFloat(input, srcRate, dstRate);
  highPass(f, dstRate, 120);
  let peak = 0;
  for (let i = 0; i < f.length; i++) {
    const a = Math.abs(f[i]!);
    if (a > peak) peak = a;
  }
  const gain = peak > 1e-4 ? Math.min(8, 0.89 / peak) : 1;
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]! * gain));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** Downsampling with averaging (a simple low-pass filter), result in Float32. */
export function toMonoFloat(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s0 = Math.floor(i * ratio);
    const s1 = Math.min(input.length, Math.max(s0 + 1, Math.ceil((i + 1) * ratio)));
    let sum = 0;
    for (let j = s0; j < s1; j++) sum += input[j]!;
    out[i] = sum / (s1 - s0);
  }
  return out;
}

/** High-pass filter (biquad, 2nd-order Butterworth) - in place. */
export function highPass(x: Float32Array, sampleRate: number, cutoff: number): Float32Array {
  const w = (2 * Math.PI * cutoff) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
  return x;
}

/** WAV (PCM16, mono). */
export function encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i]!, true);
  return buf;
}

export function concatFloat32(blocks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

/** Index of the first non-silent sample or -1 (the tab is still silent: the track hasn't started). */
export function firstNonSilent(block: Float32Array, threshold = 1e-4): number {
  for (let i = 0; i < block.length; i++) if (Math.abs(block[i]!) > threshold) return i;
  return -1;
}
