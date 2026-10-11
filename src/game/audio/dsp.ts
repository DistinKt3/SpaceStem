/**
 * Pure sample generation: seeded noise loops, the reverb impulse response, the output safety curve and oscillator
 * spectra. Everything returns plain Float32Arrays so it can be unit-tested without Web Audio.
 *
 * The long generators (noise loops, impulse response) are written as resumable "work": generators that pause every
 * few thousand samples. runSync() runs one to completion; the engine instead runs them in slices of a few
 * milliseconds between browser tasks, so starting audio never stalls the main thread. Both give identical samples.
 */
import { Rng } from '../../core/rng';

/** Float32Array backed by a plain ArrayBuffer (what Web Audio setters accept). */
export type F32 = Float32Array<ArrayBuffer>;

/** Resumable work that yields between chunks and returns T. */
export type Work<T> = Generator<undefined, T, undefined>;

/** Samples processed between pauses: well under a millisecond of work on a slow machine. */
const CHUNK = 4096;

/** Run resumable work to completion. */
export function runSync<T>(w: Work<T>): T {
  for (;;) {
    const r = w.next();
    if (r.done) return r.value;
  }
}

function* whiteWork(n: number, rng: Rng): Work<F32> {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = rng.next() * 2 - 1;
    if (i % CHUNK === CHUNK - 1) yield;
  }
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

/** Seamlessly looping noise of the given colour, `n` samples long, RMS 0.25 (resumable). */
export function* noiseWork(color: NoiseColor, n: number, seed: number): Work<F32> {
  const fade = Math.min(4096, Math.floor(n / 8));
  const rng = new Rng(seed);
  const w = yield* whiteWork(n + fade, rng);
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
      if (i % CHUNK === CHUNK - 1) yield;
    }
  } else {
    // Leaky integrator: -6 dB/octave above ~8 Hz, no DC drift.
    x = new Float32Array(w.length);
    let b = 0;
    for (let i = 0; i < w.length; i++) {
      b = 0.9989 * b + 0.045 * w[i]!;
      x[i] = b;
      if (i % CHUNK === CHUNK - 1) yield;
    }
    // Remove the residual mean so the loop has no DC offset.
    let mean = 0;
    for (const v of x) mean += v;
    mean /= x.length;
    for (let i = 0; i < x.length; i++) x[i] = x[i]! - mean;
    yield;
  }
  const loop = makeLoopable(x, fade);
  yield;
  return normalizeRms(loop, 0.25);
}

/** Seamlessly looping noise of the given colour, `n` samples long, RMS 0.25. */
export const noise = (color: NoiseColor, n: number, seed: number): F32 => runSync(noiseWork(color, n, seed));

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
export function* impulseResponseWork(sampleRate: number, shape: ReverbShape, seed: number): Work<[F32, F32]> {
  const len = Math.max(1, Math.floor(sampleRate * (shape.rt60 * 1.05 + shape.predelay)));
  const pre = Math.floor(sampleRate * shape.predelay);
  const k = Math.log(1000) / shape.rt60; // amplitude e^(-k t) reaches -60 dB at rt60
  // Per-sample decay factors, so the loop multiplies instead of calling exp() twice per sample.
  const decay = Math.exp(-k / sampleRate);
  const darken = Math.exp(-2.2 / sampleRate);
  const bright = 0.85 * shape.brightness + 0.05;
  function* make(chSeed: number): Work<F32> {
    const rng = new Rng(chSeed);
    const out = new Float32Array(len);
    let lp = 0;
    let env = 1;
    let tilt = 1;
    const fadeIn = Math.floor(sampleRate * 0.012);
    for (let i = pre; i < len; i++) {
      // One-pole low-pass coefficient sliding from bright to dark over the tail.
      const a = 0.08 + bright * tilt;
      lp += a * (rng.next() * 2 - 1 - lp);
      out[i] = lp * env * Math.min(1, (i - pre + 1) / fadeIn);
      env *= decay;
      tilt *= darken;
      if (i % CHUNK === CHUNK - 1) yield;
    }
    // Early reflections: a handful of taps in the first 80 ms.
    for (let r = 0; r < 9; r++) {
      const at = pre + Math.floor(sampleRate * (0.007 + 0.075 * rng.next()));
      if (at < len) out[at] = out[at]! + (rng.next() < 0.5 ? -1 : 1) * (0.35 - r * 0.03);
    }
    return out;
  }
  const l = yield* make(seed ^ 0x1111);
  const r = yield* make(seed ^ 0x2222);
  return [l, r];
}

/** Stereo impulse response (see impulseResponseWork). */
export const impulseResponse = (sampleRate: number, shape: ReverbShape, seed: number): [F32, F32] =>
  runSync(impulseResponseWork(sampleRate, shape, seed));

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
