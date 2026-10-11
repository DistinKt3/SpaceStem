/**
 * Small Web Audio helpers shared by the layers, the score player and the cues: a node group that starts, stops and
 * disconnects everything it created, click-free envelopes, and the "kit" of shared noise buffers and waveforms.
 */
import { Rng, hashInts } from '../../core/rng';
import { buzzSpectrum, noise, padSpectrum, warmSpectrum, type F32, type Spectrum } from './dsp';

export interface Kit {
  readonly ctx: BaseAudioContext;
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly pad: PeriodicWave;
  readonly warm: PeriodicWave;
  readonly buzz: PeriodicWave;
  /** Deterministic stream for start offsets and per-instance variation. */
  readonly rng: Rng;
}

const NOISE_SECONDS = 5;

function monoBuffer(ctx: BaseAudioContext, data: F32): AudioBuffer {
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.copyToChannel(data, 0);
  return buf;
}

function wave(ctx: BaseAudioContext, s: Spectrum): PeriodicWave {
  return ctx.createPeriodicWave(s.real, s.imag, { disableNormalization: false });
}

export function createKit(ctx: BaseAudioContext, seed: number): Kit {
  const n = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  return {
    ctx,
    white: monoBuffer(ctx, noise('white', n, hashInts(seed, 1))),
    pink: monoBuffer(ctx, noise('pink', n, hashInts(seed, 2))),
    brown: monoBuffer(ctx, noise('brown', n, hashInts(seed, 3))),
    pad: wave(ctx, padSpectrum()),
    warm: wave(ctx, warmSpectrum()),
    buzz: wave(ctx, buzzSpectrum()),
    rng: new Rng(hashInts(seed, 4)),
  };
}

/**
 * Switch parameters to block-rate automation (one value per 128 samples). Used for slow glides and LFOs on filters
 * and oscillators in long-running layers: a modulated BiquadFilter otherwise recomputes its coefficients for every
 * sample. Older browsers without automationRate simply keep a-rate.
 */
export function kRate(...params: AudioParam[]): void {
  for (const p of params) {
    try {
      if ('automationRate' in p) p.automationRate = 'k-rate';
    } catch {
      // Not allowed for this parameter on this browser: keep a-rate.
    }
  }
}

/** Glide a parameter toward a value (exponential approach, time constant tau). Ignores non-finite values. */
export function glide(p: AudioParam, v: number, now: number, tau: number): void {
  if (!Number.isFinite(v) || !Number.isFinite(now)) return;
  p.setTargetAtTime(v, now, Math.max(0.001, tau));
}

/** A parameter target that is only rescheduled when it changes noticeably (keeps the automation timeline short). */
export class Target {
  private last = Number.NaN;
  constructor(
    private readonly param: AudioParam,
    private readonly tau: number,
    private readonly eps = 1e-4,
  ) {}
  set(v: number, now: number, tau = this.tau): void {
    if (!Number.isFinite(v)) return;
    if (Math.abs(v - this.last) <= this.eps * Math.max(1, Math.abs(v))) return;
    this.last = v;
    glide(this.param, v, now, tau);
  }
}

/**
 * Attack-hold-release on a gain parameter: attack from 0, exponential release to -60 dB, then an exact zero.
 * `soft` makes the attack concave (70% of the level in the first 40% of the time), which keeps overlapping pad
 * crossfades at nearly constant power. Returns the time the envelope reaches silence.
 */
export function envelope(p: AudioParam, t0: number, attack: number, hold: number, release: number, peak: number, soft = false): number {
  const a = Math.max(0.002, attack);
  const r = Math.max(0.01, release);
  const end = t0 + a + Math.max(0, hold) + r;
  p.setValueAtTime(0, t0);
  if (!(peak > 0) || !Number.isFinite(peak)) return end;
  if (soft) p.linearRampToValueAtTime(peak * 0.7, t0 + a * 0.4);
  p.linearRampToValueAtTime(peak, t0 + a);
  p.setValueAtTime(peak, t0 + a + Math.max(0, hold));
  p.exponentialRampToValueAtTime(peak * 1e-3, end);
  p.linearRampToValueAtTime(0, end + 0.02);
  return end + 0.03;
}

/** Owns a set of nodes: creates, starts, stops and disconnects them together. */
export class NodeGroup {
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly paramLinks: [AudioNode, AudioParam][] = [];
  private readonly offsets = new Map<AudioBufferSourceNode, number>();
  private stopped = false;

  constructor(readonly ctx: BaseAudioContext) {}

  add<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    if (node instanceof AudioScheduledSourceNode) this.sources.push(node);
    return node;
  }

  osc(wave: PeriodicWave | OscillatorType, hz: number, detuneCents = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    // PeriodicWave is an empty interface in lib.dom, so narrow explicitly.
    if (typeof wave === 'string') o.type = wave as OscillatorType;
    else o.setPeriodicWave(wave);
    o.frequency.value = hz;
    o.detune.value = detuneCents;
    return this.add(o);
  }

  noise(buffer: AudioBuffer, offset = 0, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = rate;
    // AudioBufferSourceNode.start(when, offset): remember the offset for start().
    this.offsets.set(s, ((offset % buffer.duration) + buffer.duration) % buffer.duration);
    return this.add(s);
  }

  gain(v = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return this.add(g);
  }

  filter(type: BiquadFilterType, hz: number, q = Math.SQRT1_2): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    return this.add(f);
  }

  pan(p: number): StereoPannerNode {
    const n = this.ctx.createStereoPanner();
    n.pan.value = Math.max(-1, Math.min(1, p));
    return this.add(n);
  }

  /** Connect a modulator to a parameter of another node and remember it, so disconnect() can undo it. */
  link(from: AudioNode, to: AudioParam): void {
    from.connect(to);
    this.paramLinks.push([from, to]);
  }

  start(at: number): void {
    for (const s of this.sources) {
      if (s instanceof AudioBufferSourceNode) s.start(at, this.offsets.get(s) ?? 0);
      else s.start(at);
    }
  }

  stop(at: number): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const s of this.sources) {
      try {
        s.stop(at);
      } catch {
        // Already stopped or never started.
      }
    }
  }

  /** Call `cb` once every source has ended. */
  onEnded(cb: () => void): void {
    let left = this.sources.length;
    if (left === 0) {
      cb();
      return;
    }
    for (const s of this.sources)
      s.addEventListener(
        'ended',
        () => {
          left--;
          if (left === 0) cb();
        },
        { once: true },
      );
  }

  disconnect(): void {
    for (const [from, to] of this.paramLinks) {
      try {
        from.disconnect(to);
      } catch {
        // Already gone.
      }
    }
    this.paramLinks.length = 0;
    for (const n of this.nodes) n.disconnect();
  }

  /** Stop now (sources) and disconnect immediately. */
  kill(now: number): void {
    this.stop(now);
    this.disconnect();
  }
}
