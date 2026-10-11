/**
 * The mix graph: music and effects buses with their own volumes, one shared long reverb (convolver with a generated
 * impulse response), and the master chain that keeps the output safe:
 *
 *   music  -> musicVol ----------------------------\
 *   musicWet -> musicWetVol --\                     \
 *   sfx    -> sfxVol -----------------------------> sum -> mute -> master -> high-pass 20 Hz -> compressor
 *   sfxWet -> sfxWetVol ------> convolver -> return /                                              |
 *                                                          destination <- soft clip (|y| <= 0.95) <-+
 */
import { hashInts } from '../../core/rng';
import { impulseResponseWork, softClipCurve, type F32, type ReverbShape, type Work } from './dsp';
import { volumeToGain } from './mappings';
import { kitWork, type Kit } from './nodes';

export interface Volumes {
  master: number;
  music: number;
  sfx: number;
}

/** Overall loudness trim into the limiter. */
const MASTER_TRIM = 1.6;
/** WaveShaper input range: the curve covers +-CLIP_RANGE. */
const CLIP_RANGE = 4;
/** The shared long reverb. */
const REVERB: ReverbShape = { rt60: 4.8, predelay: 0.03, brightness: 0.55 };

/** Everything procedural the engine needs before it can make a sound: noise loops, waveforms, the reverb IR. */
export interface AudioAssets {
  readonly kit: Kit;
  readonly ir: readonly [F32, F32];
}

/**
 * Generate the assets for a seed as resumable work (see dsp.ts): about 30-40 ms of CPU once the code is warm, more on
 * the first, cold run. The engine runs it in slices of a few milliseconds.
 */
export function* assetsWork(ctx: BaseAudioContext, seed: number): Work<AudioAssets> {
  const kit = yield* kitWork(ctx, seed);
  const ir = yield* impulseResponseWork(ctx.sampleRate, REVERB, hashInts(seed, 0x4ef));
  return { kit, ir };
}

export class MixGraph {
  /** Dry music input. */
  readonly music: GainNode;
  /** Music reverb send. */
  readonly musicWet: GainNode;
  /** Dry effects input (cabin, engine, wind, cues). */
  readonly sfx: GainNode;
  /** Effects reverb send. */
  readonly sfxWet: GainNode;

  private readonly musicVol: GainNode;
  private readonly musicWetVol: GainNode;
  private readonly sfxVol: GainNode;
  private readonly sfxWetVol: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly reverbReturn: GainNode;
  private readonly sum: GainNode;
  private readonly mute: GainNode;
  private readonly master: GainNode;
  private readonly highpass: BiquadFilterNode;
  private readonly comp: DynamicsCompressorNode;
  private readonly clipIn: GainNode;
  private readonly shaper: WaveShaperNode;
  private analyserNode: AnalyserNode | null = null;
  private readonly all: AudioNode[] = [];

  constructor(
    readonly ctx: BaseAudioContext,
    ir: readonly [F32, F32],
    volumes: Volumes,
    muted: boolean,
  ) {
    const gain = (v: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      this.all.push(g);
      return g;
    };
    this.music = gain(1);
    this.musicWet = gain(1);
    this.sfx = gain(1);
    this.sfxWet = gain(1);
    this.musicVol = gain(volumeToGain(volumes.music));
    this.musicWetVol = gain(volumeToGain(volumes.music));
    this.sfxVol = gain(volumeToGain(volumes.sfx));
    this.sfxWetVol = gain(volumeToGain(volumes.sfx));
    this.reverbReturn = gain(0.9);
    this.sum = gain(1);
    this.mute = gain(muted ? 0 : 1);
    this.master = gain(volumeToGain(volumes.master) * MASTER_TRIM);
    this.clipIn = gain(1 / CLIP_RANGE);

    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    const [l, r] = ir;
    const irBuffer = ctx.createBuffer(2, l.length, ctx.sampleRate);
    irBuffer.copyToChannel(l, 0);
    irBuffer.copyToChannel(r, 1);
    this.convolver.buffer = irBuffer;

    this.highpass = ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = 20;
    this.highpass.Q.value = Math.SQRT1_2;

    // Gentle peak control; the soft clipper below is the hard guarantee.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -9;
    this.comp.knee.value = 6;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.25;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = softClipCurve(4096, CLIP_RANGE, 0.6, 0.95);
    this.shaper.oversample = 'none';
    this.all.push(this.convolver, this.highpass, this.comp, this.shaper);

    this.music.connect(this.musicVol).connect(this.sum);
    this.musicWet.connect(this.musicWetVol).connect(this.convolver);
    this.sfx.connect(this.sfxVol).connect(this.sum);
    this.sfxWet.connect(this.sfxWetVol).connect(this.convolver);
    this.convolver.connect(this.reverbReturn).connect(this.sum);
    this.sum.connect(this.mute).connect(this.master).connect(this.highpass).connect(this.comp).connect(this.clipIn);
    this.clipIn.connect(this.shaper).connect(ctx.destination);
  }

  setVolumes(v: Volumes, muted: boolean, now: number): void {
    const tau = 0.05;
    const set = (g: GainNode, x: number): void => {
      if (Number.isFinite(x)) g.gain.setTargetAtTime(x, now, tau);
    };
    set(this.musicVol, volumeToGain(v.music));
    set(this.musicWetVol, volumeToGain(v.music));
    set(this.sfxVol, volumeToGain(v.sfx));
    set(this.sfxWetVol, volumeToGain(v.sfx));
    set(this.master, volumeToGain(v.master) * MASTER_TRIM);
    set(this.mute, muted ? 0 : 1);
  }

  /** Quick fade of the whole output (before a teardown). */
  fadeOut(now: number): void {
    this.mute.gain.cancelScheduledValues(now);
    this.mute.gain.setTargetAtTime(0, now, 0.01);
  }

  /** Analyser tapped after the limiter (created on first use). */
  analyser(): AnalyserNode {
    if (!this.analyserNode) {
      this.analyserNode = this.ctx.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.analyserNode.smoothingTimeConstant = 0.75;
      this.shaper.connect(this.analyserNode);
      this.all.push(this.analyserNode);
    }
    return this.analyserNode;
  }

  dispose(): void {
    for (const n of this.all) n.disconnect();
  }
}
