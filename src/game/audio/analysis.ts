/**
 * Signal measurements for verifying rendered audio without listening: level, peak, non-finite samples, click
 * detection, band energy and a spectrogram. Pure functions over sample arrays (used by tests and the Audio Lab).
 */

type Samples = ArrayLike<number>;

export function rms(x: Samples, from = 0, to = x.length): number {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(x.length, Math.floor(to));
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) {
    const v = x[i]!;
    if (Number.isFinite(v)) s += v * v;
  }
  return Math.sqrt(s / (b - a));
}

export function peak(x: Samples): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]!);
    if (v > p) p = v;
  }
  return p;
}

export function countNonFinite(x: Samples): number {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i]!)) n++;
  return n;
}

export function fractionAbove(x: Samples, level: number): number {
  if (x.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > level) n++;
  return n / x.length;
}

export function subtract(a: Samples, b: Samples): Float32Array {
  const n = Math.min(a.length, b.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i]! - b[i]!;
  return out;
}

export function mixDown(l: Samples, r: Samples): Float32Array {
  const n = Math.min(l.length, r.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * (l[i]! + r[i]!);
  return out;
}

/**
 * Click detector. A click is a near-instant discontinuity: in the second difference of the signal it is one or two
 * samples far above their neighbourhood. Returns the largest crest factor (peak / local RMS of the second difference)
 * over 512-sample windows whose spike is above -80 dBFS. Smooth music and noise stay below ~6; a sample-level step
 * of -40 dBFS on a quiet mix scores well above 10.
 */
export function clickScore(x: Samples, win = 512): number {
  const n = x.length;
  if (n < 3) return 0;
  const d = new Float32Array(n);
  for (let i = 2; i < n; i++) d[i] = x[i]! - 2 * x[i - 1]! + x[i - 2]!;
  let worst = 0;
  const hop = win / 2;
  for (let start = 2; start + win <= n; start += hop) {
    let s = 0;
    let p = 0;
    for (let i = start; i < start + win; i++) {
      const v = d[i]!;
      s += v * v;
      const a = Math.abs(v);
      if (a > p) p = a;
    }
    if (p < 1e-4) continue;
    const local = Math.sqrt(s / win);
    const crest = p / Math.max(local, 1e-9);
    if (crest > worst) worst = crest;
  }
  return worst;
}

/** In-place iterative radix-2 FFT (length must be a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Hann-windowed power spectra of consecutive frames. */
export function powerFrames(x: Samples, size = 2048, hop = size / 2): Float64Array[] {
  const frames: Float64Array[] = [];
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  for (let start = 0; start + size <= x.length; start += hop) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = (x[start + i]! || 0) * win[i]!;
    fft(re, im);
    const p = new Float64Array(size / 2);
    for (let k = 0; k < size / 2; k++) p[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    frames.push(p);
  }
  return frames;
}

/** Fraction of total spectral energy between lo and hi Hz. */
export function bandEnergyFraction(x: Samples, sampleRate: number, lo: number, hi: number, size = 2048): number {
  const frames = powerFrames(x, size);
  const binHz = sampleRate / size;
  let band = 0;
  let total = 0;
  for (const p of frames)
    for (let k = 1; k < p.length; k++) {
      const f = k * binHz;
      total += p[k]!;
      if (f >= lo && f < hi) band += p[k]!;
    }
  return total > 0 ? band / total : 0;
}

/** Energy-weighted mean frequency (Hz). */
export function spectralCentroid(x: Samples, sampleRate: number, size = 2048): number {
  const frames = powerFrames(x, size);
  const binHz = sampleRate / size;
  let num = 0;
  let den = 0;
  for (const p of frames)
    for (let k = 1; k < p.length; k++) {
      num += k * binHz * p[k]!;
      den += p[k]!;
    }
  return den > 0 ? num / den : 0;
}

/**
 * The strongest spectral peaks of a short excerpt (Hz, loudest first): one Hann-windowed FFT zero-padded to at least
 * four times the excerpt, local maxima refined by parabolic interpolation of the log power. A peak within 3% of a
 * louder one counts as part of it (window sidelobes, beating twins). Only peaks at or above `minHz` are reported.
 */
export function spectralPeaks(x: Samples, sampleRate: number, count: number, minHz = 0): number[] {
  const n = x.length;
  if (n < 16 || count <= 0) return [];
  let size = 1;
  while (size < n * 4) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) {
    const v = x[i]!;
    re[i] = (Number.isFinite(v) ? v : 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  fft(re, im);
  const half = size / 2;
  const db = new Float64Array(half);
  for (let k = 0; k < half; k++) db[k] = 10 * Math.log10(re[k]! * re[k]! + im[k]! * im[k]! + 1e-30);
  const binHz = sampleRate / size;
  const cands: { hz: number; p: number }[] = [];
  for (let k = Math.max(1, Math.ceil(minHz / binHz)); k < half - 1; k++) {
    const a = db[k - 1]!;
    const b = db[k]!;
    const c = db[k + 1]!;
    if (b > a && b >= c) {
      const den = a - 2 * b + c;
      const off = den !== 0 ? (0.5 * (a - c)) / den : 0;
      cands.push({ hz: (k + off) * binHz, p: b - 0.25 * (a - c) * off });
    }
  }
  cands.sort((u, v) => v.p - u.p);
  const out: number[] = [];
  for (const cand of cands) {
    if (out.some((h) => Math.abs(cand.hz - h) < 0.03 * h)) continue;
    out.push(cand.hz);
    if (out.length >= count) break;
  }
  return out;
}

/** Spectrogram in dBFS per frame (for display). */
export function spectrogramDb(x: Samples, size = 1024, hop = 256): { frames: Float32Array[]; bins: number } {
  const norm = (size / 4) * (size / 4); // Hann coherent gain^2 for a full-scale sine
  const frames = powerFrames(x, size, hop).map((p) => {
    const out = new Float32Array(p.length);
    for (let k = 0; k < p.length; k++) out[k] = 10 * Math.log10(p[k]! / norm + 1e-14);
    return out;
  });
  return { frames, bins: size / 2 };
}
