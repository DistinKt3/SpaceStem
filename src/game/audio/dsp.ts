/**
 * Pure sample generation: seeded noise loops, the reverb impulse response, the output safety curve and oscillator
 * spectra. Everything returns plain Float32Arrays so it can be unit-tested without Web Audio.
 */
import { Rng } from '../../core/rng';

/** Float32Array backed by a plain ArrayBuffer (what Web Audio setters accept). */
export type F32 = Float32Array<ArrayBuffer>;

function white(n: number, rng: Rng): F32 {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.next() * 2 - 1;
  return out;
}

/** Scale to a target RMS level. */
export function normalizeRms(x: F32, target: number): F32 {
  let s = 0;
  for (const v of x) s += v * v;
  const rms = Math.sqrt(s / Math.max(1, x.length));
  if (rms > 0) {
    const k = target / rms;
    for (let i = 0; i < x.length; i++) x[i] = x[i]! * k;
  }
  return x;
}

/**
 * Make a buffer loop without a seam: the last `fade` samples are cross-faded (equal power) into the head, and the
 * result is `fade` samples shorter. Playing it with loop=true is continuous at the wrap point.
 */
export function makeLoopable(x: F32, fade: number): F32 {
  const f = Math.max(1, Math.min(fade, Math.floor(x.length / 2)));
  const n = x.length - f;
  const out = x.slice(0, n);
  for (let i = 0; i < f; i++) {
    const a = (i + 0.5) / f;
    const wIn = Math.sin((a * Math.PI) / 2);
    const wOut = Math.cos((a * Math.PI) / 2);
    out[i] = x[i]! * wIn + x[n + i]! * wOut;
  }
  return out;
}

export type NoiseColor = 'white' | 'pink' | 'brown';

/** Seamlessly looping noise of the given colour, `n` samples long, RMS 0.25. */
export function noise(color: NoiseColor, n: number, seed: number): F32 {
  const fade = Math.min(4096, Math.floor(n / 8));
  const rng = new Rng(seed);
  const w = white(n + fade, rng);
  let x: F32;
  if (color === 'white') x = w;
  else if (color === 'pink') {
    // Paul Kellet's economy pink filter (-3 dB/octave within ~1 dB above 40 Hz).
    x = new Float32Array(w.length);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < w.length; i++) {
      const v = w[i]!;
      b0 = 0.99765 * b0 + v * 0.099046;
      b1 = 0.963 * b1 + v * 0.2965164;
      b2 = 0.57 * b2 + v * 1.0526913;
      x[i] = b0 + b1 + b2 + v * 0.1848;
    }
  } else {
    // Leaky integrator: -6 dB/octave above ~8 Hz, no DC drift.
    x = new Float32Array(w.length);
    let b = 0;
    for (let i = 0; i < w.length; i++) {
      b = 0.9989 * b + 0.045 * w[i]!;
      x[i] = b;
    }
    // Remove the residual mean so the loop has no DC offset.
    let mean = 0;
    for (const v of x) mean += v;
    mean /= x.length;
    for (let i = 0; i < x.length; i++) x[i] = x[i]! - mean;
  }
  return normalizeRms(makeLoopable(x, fade), 0.25);
}

export interface ReverbShape {
  /** Seconds to decay by 60 dB. */
  rt60: number;
  /** Silence before the first reflection, seconds. */
  predelay: number;
  /** 0..1: how bright the early tail is (it always darkens over time). */
  brightness: number;
}

/**
 * Stereo impulse response for the convolver: sparse early reflections, then decorrelated exponentially decaying
 * noise that is low-passed progressively (air absorbs highs first). Deterministic for a seed.
 */
export function impulseResponse(sampleRate: number, shape: ReverbShape, seed: number): [F32, F32] {
  const len = Math.max(1, Math.floor(sampleRate * (shape.rt60 * 1.05 + shape.predelay)));
  const pre = Math.floor(sampleRate * shape.predelay);
  const k = Math.log(1000) / shape.rt60; // amplitude e^(-k t) reaches -60 dB at rt60
  const make = (chSeed: number): F32 => {
    const rng = new Rng(chSeed);
    const out = new Float32Array(len);
    let lp = 0;
    const fadeIn = Math.floor(sampleRate * 0.012);
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sampleRate;
      const env = Math.exp(-k * t) * Math.min(1, (i - pre + 1) / fadeIn);
      // One-pole low-pass coefficient sliding from bright to dark over the tail.
      const a = 0.08 + (0.85 * shape.brightness + 0.05) * Math.exp(-t * 2.2);
      lp += a * (rng.next() * 2 - 1 - lp);
      out[i] = lp * env;
    }
    // Early reflections: a handful of taps in the first 80 ms.
    for (let r = 0; r < 9; r++) {
      const at = pre + Math.floor(sampleRate * (0.007 + 0.075 * rng.next()));
      if (at < len) out[at] = out[at]! + (rng.next() < 0.5 ? -1 : 1) * (0.35 - r * 0.03);
    }
    return out;
  };
  return [make(seed ^ 0x1111), make(seed ^ 0x2222)];
}

/**
 * Output safety curve for a WaveShaperNode fed through a gain of 1/range: identity up to `knee`, then a tanh
 * shoulder that never exceeds `ceiling`. Inputs beyond +-range are held at the ceiling.
 */
export function softClipCurve(n = 4096, range = 4, knee = 0.6, ceiling = 0.95): F32 {
  const out = new Float32Array(n);
  const span = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * range;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    out[i] = Math.sign(x) * y;
  }
  return out;
}

export interface Spectrum {
  real: F32;
  imag: F32;
}

/** Harmonic amplitudes -> PeriodicWave coefficients (sine phase). */
function spectrum(amps: (n: number) => number, count: number): Spectrum {
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  for (let n = 1; n <= count; n++) imag[n] = amps(n);
  return { real, imag };
}

/** Warm pad: soft saw-like rolloff with slightly hollow even harmonics. */
export const padSpectrum = (): Spectrum => spectrum((n) => (n % 2 === 0 ? 0.6 : 1) / Math.pow(n, 1.55), 28);
/** Near-sine with a little 2nd and 3rd harmonic, for bass and hum. */
export const warmSpectrum = (): Spectrum => spectrum((n) => (n === 1 ? 1 : n === 2 ? 0.28 : n === 3 ? 0.1 : n === 4 ? 0.04 : 0), 4);
/** Bright buzzy tone for the hyperspeed spool (saw to the 40th harmonic). */
export const buzzSpectrum = (): Spectrum => spectrum((n) => 1 / n, 40);
