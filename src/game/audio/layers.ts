/**
 * Continuous sound layers driven by ship state. Each layer builds its nodes only while it is audible and tears them
 * down after a few seconds of silence, so CPU is spent only on what can be heard (in deep space: just the cabin; when
 * the effects are muted: nothing). All level changes are parameter glides, never jumps, so nothing clicks.
 *
 * Hull-borne sounds (engine, hyperspeed drone) are dark on purpose, but laptop and phone speakers reproduce almost
 * nothing below 150 Hz. Each therefore also has a quieter component in the 150-600 Hz band (an octave "body" with
 * harmonics, a hull-panel resonance), so the ear hears the low fundamental even where the speaker cannot play it.
 */
import type { AudioState } from './audioEngine';
import { cabinMix, engineMix, heatMix, hyperMix, rcsMix, windMix } from './mappings';
import { NodeGroup, Target, kRate, type Kit } from './nodes';

const SILENT = 1e-4;
const TEARDOWN_AFTER_S = 5;
/** Level of the hyperspeed drone's octave body relative to its sub. */
const DRONE_BODY = 0.65;

/** Key-aware fundamentals (tuning.ts), so the cabin hum and the drone sit in the score's key. */
export interface LayerTuning {
  readonly humHz: number;
  readonly droneHz: number;
}
export const DEFAULT_TUNING: LayerTuning = { humHz: 55, droneHz: 36.71 };

export abstract class Layer {
  protected group: NodeGroup | null = null;
  protected readonly out: GainNode;
  private quietFor = 0;
  private lastNow = Number.NaN;

  constructor(
    protected readonly kit: Kit,
    dest: AudioNode,
    protected readonly tuning: LayerTuning = DEFAULT_TUNING,
  ) {
    this.out = kit.ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(dest);
  }

  /** Target loudness for the state (0 = silent); drives the build/teardown lifecycle. */
  protected abstract level(s: AudioState): number;
  protected abstract build(g: NodeGroup, now: number): void;
  protected abstract apply(s: AudioState, now: number): void;

  get active(): boolean {
    return this.group !== null;
  }

  /**
   * Apply the state at audio time `now` (the layer measures elapsed time on the audio clock). With `audible` false
   * (effects muted or at zero volume) the layer counts as silent and is torn down after a few seconds; it is rebuilt,
   * fading in, when sound returns.
   */
  update(s: AudioState, now: number, audible = true): void {
    const dt = Number.isFinite(this.lastNow) ? Math.max(0, now - this.lastNow) : 0;
    this.lastNow = now;
    const lvl = audible ? this.level(s) : 0;
    if (lvl > SILENT) {
      this.quietFor = 0;
      if (!this.group) {
        const g = new NodeGroup(this.kit.ctx);
        this.group = g;
        this.build(g, now);
        g.start(now);
      }
    } else if (this.group) {
      this.quietFor += dt;
      if (this.quietFor >= TEARDOWN_AFTER_S) {
        const g = this.group;
        this.group = null;
        g.stop(now + 0.05);
        g.onEnded(() => g.disconnect());
        return;
      }
    }
    if (this.group && audible) this.apply(s, now);
  }

  dispose(now: number): void {
    this.group?.kill(now);
    this.group = null;
    this.out.disconnect();
  }

  protected offset(): number {
    return this.kit.rng.next() * 4;
  }
}

/** Interior: power hum, life-support air and avionics cooling. Always on. */
export class CabinLayer extends Layer {
  private hum!: Target;
  private air!: Target;
  private fan!: Target;

  protected level(): number {
    return 1;
  }

  protected build(g: NodeGroup, _now: number): void {
    const { kit } = this;
    const humBus = g.gain(0);
    // Slightly inharmonic partials beat slowly against each other, like a real transformer hum. The fundamental is a
    // scale tone of the score (tuning.ts), between about 46 and 65 Hz.
    const f = this.tuning.humHz;
    [
      [1, 1],
      [2.0064, 0.42],
      [2.9964, 0.16],
      [4.02, 0.05],
    ].forEach(([r, a]) => g.osc(kit.warm, f * r!).connect(g.gain(a)).connect(humBus));
    const wobble = g.osc('sine', 0.21);
    const wobbleDepth = g.gain(0.006);
    wobble.connect(wobbleDepth);
    g.link(wobbleDepth, humBus.gain);
    humBus.connect(g.filter('lowpass', 400, 0.6)).connect(this.out);

    const airBus = g.gain(0);
    g.noise(kit.pink, this.offset()).connect(g.filter('lowpass', 420, 0.5)).connect(g.filter('highpass', 60)).connect(airBus).connect(this.out);

    const fanBus = g.gain(0);
    g.noise(kit.pink, this.offset()).connect(g.filter('bandpass', 1650, 1.4)).connect(fanBus).connect(this.out);
    const fanLfo = g.osc('sine', 0.13);
    const fanDepth = g.gain(0.003);
    fanLfo.connect(fanDepth);
    g.link(fanDepth, fanBus.gain);

    this.hum = new Target(humBus.gain, 1.2);
    this.air = new Target(airBus.gain, 1.5);
    this.fan = new Target(fanBus.gain, 1.5);
  }

  protected apply(s: AudioState, now: number): void {
    const m = cabinMix(s);
    this.hum.set(m.humGain, now);
    this.air.set(m.airGain, now);
    this.fan.set(m.fanGain, now);
  }
}

/** Main engine, felt through the hull: sub rumble, low-passed roar and a tonal drive hum. */
export class EngineLayer extends Layer {
  private rumbleGain!: Target;
  private rumbleHz!: Target;
  private noiseGain!: Target;
  private noiseCut!: Target;
  private toneGain!: Target;
  private toneHz!: Target;
  private toneHz2!: Target;
  private hullCut!: Target;
  private flutter!: Target;
  private resoGain!: Target;
  private resoHz!: Target;

  protected level(s: AudioState): number {
    const m = engineMix(s);
    return m.rumbleGain + m.noiseGain + m.toneGain + m.resoGain;
  }

  protected build(g: NodeGroup, _now: number): void {
    const { kit } = this;
    const hull = g.filter('lowpass', 400, 0.5);
    hull.connect(this.out);

    const rumble = g.osc(kit.warm, 40);
    const rumbleGain = g.gain(0);
    rumble.connect(rumbleGain).connect(hull);

    const noiseCut = g.filter('lowpass', 150, 0.9);
    const noiseGain = g.gain(0);
    const roar = g.noise(kit.pink, this.offset());
    roar.connect(noiseCut).connect(noiseGain).connect(hull);
    // Combustion flutter: a little fast amplitude modulation on the roar.
    const flutterLfo = g.osc('sine', 5.3);
    const flutter = g.gain(0);
    flutterLfo.connect(flutter);
    g.link(flutter, noiseGain.gain);
    // Hull-panel resonance: a band of the same roar a little higher up, so small speakers carry the engine too.
    const reso = g.filter('bandpass', 220, 1.4);
    const resoGain = g.gain(0);
    roar.connect(reso).connect(resoGain).connect(hull);

    const toneGain = g.gain(0);
    const toneLp = g.filter('lowpass', 720, 0.7);
    const t1 = g.osc(kit.pad, 90);
    const t2 = g.osc(kit.pad, 90);
    t1.connect(toneLp);
    t2.connect(toneLp);
    toneLp.connect(toneGain).connect(hull);

    kRate(rumble.frequency, noiseCut.frequency, t1.frequency, t2.frequency, hull.frequency, reso.frequency);
    this.rumbleGain = new Target(rumbleGain.gain, 0.12);
    this.rumbleHz = new Target(rumble.frequency, 0.25);
    this.noiseGain = new Target(noiseGain.gain, 0.12);
    this.noiseCut = new Target(noiseCut.frequency, 0.2);
    this.toneGain = new Target(toneGain.gain, 0.2);
    this.toneHz = new Target(t1.frequency, 0.3);
    this.toneHz2 = new Target(t2.frequency, 0.3);
    this.hullCut = new Target(hull.frequency, 0.2);
    this.flutter = new Target(flutter.gain, 0.2);
    this.resoGain = new Target(resoGain.gain, 0.12);
    this.resoHz = new Target(reso.frequency, 0.25);
  }

  protected apply(s: AudioState, now: number): void {
    const m = engineMix(s);
    this.rumbleGain.set(m.rumbleGain, now);
    this.rumbleHz.set(m.rumbleHz, now);
    this.noiseGain.set(m.noiseGain, now);
    this.noiseCut.set(m.noiseCutoff, now);
    this.toneGain.set(m.toneGain, now);
    this.toneHz.set(m.toneHz, now);
    this.toneHz2.set(m.toneHz * 1.004, now); // slow beating between the two drive tones
    this.resoGain.set(m.resoGain, now);
    this.resoHz.set(m.resoHz, now);
    this.hullCut.set(m.hullCutoff, now);
    this.flutter.set(m.noiseGain * (s.mode === 'thrusters' ? 0.22 : 0.08), now);
  }
}

/** Attitude jets: short valve hiss through the hull, fast attack and release. */
export class RcsLayer extends Layer {
  private gainT!: Target;
  private center!: Target;

  protected level(s: AudioState): number {
    return rcsMix(s).gain;
  }

  protected build(g: NodeGroup, _now: number): void {
    const bp = g.filter('bandpass', 900, 0.9);
    const gain = g.gain(0);
    g.noise(this.kit.white, this.offset()).connect(bp).connect(g.filter('lowpass', 2400, 0.6)).connect(gain).connect(this.out);
    kRate(bp.frequency);
    this.gainT = new Target(gain.gain, 0.03);
    this.center = new Target(bp.frequency, 0.05);
  }

  protected apply(s: AudioState, now: number): void {
    const m = rcsMix(s);
    // Fast attack, slightly slower release.
    this.gainT.set(m.gain, now, m.gain > 0 ? 0.012 : 0.05);
    this.center.set(m.centerHz, now);
  }
}

/** Wind: only where there is air. Broad body plus a narrow whistle, slow gusts. */
export class WindLayer extends Layer {
  private gainT!: Target;
  private gustT!: Target;
  private bodyHz!: Target;
  private whistleHz!: Target;
  private whistleGain!: Target;
  private cutoff!: Target;
  private pitchSwing!: Target;

  protected level(s: AudioState): number {
    return windMix(s).gain;
  }

  protected build(g: NodeGroup, _now: number): void {
    const { kit } = this;
    const body = g.filter('bandpass', 400, 0.55);
    const whistle = g.filter('bandpass', 900, 5);
    const whistleGain = g.gain(0);
    const lp = g.filter('lowpass', 1500, 0.5);
    const gain = g.gain(0);
    g.noise(kit.pink, this.offset()).connect(body).connect(lp);
    g.noise(kit.white, this.offset()).connect(whistle).connect(whistleGain).connect(lp);
    lp.connect(gain).connect(this.out);

    // Two slow, unrelated LFOs make irregular gusts (amplitude and whistle pitch).
    const l1 = g.osc('sine', 0.13);
    const l2 = g.osc('sine', 0.051);
    const gust = g.gain(0);
    l1.connect(gust);
    l2.connect(gust);
    g.link(gust, gain.gain);
    const pitchSwing = g.gain(0);
    l1.connect(pitchSwing);
    g.link(pitchSwing, whistle.frequency);
    this.pitchSwing = new Target(pitchSwing.gain, 0.4);

    kRate(body.frequency, whistle.frequency, lp.frequency);
    this.gainT = new Target(gain.gain, 0.35);
    this.gustT = new Target(gust.gain, 0.35);
    this.bodyHz = new Target(body.frequency, 0.4);
    this.whistleHz = new Target(whistle.frequency, 0.4);
    this.whistleGain = new Target(whistleGain.gain, 0.4);
    this.cutoff = new Target(lp.frequency, 0.4);
  }

  protected apply(s: AudioState, now: number): void {
    const m = windMix(s);
    this.gainT.set(m.gain, now);
    // Two LFOs summed swing +-2x the depth: keep the total below the base gain so it never inverts.
    this.gustT.set(m.gain * m.gust * 0.45, now);
    this.bodyHz.set(m.bodyHz, now);
    this.whistleHz.set(m.whistleHz, now);
    this.whistleGain.set(m.whistleGain, now);
    this.cutoff.set(m.cutoff, now);
    this.pitchSwing.set(m.whistleHz * 0.12, now);
  }
}

/** Scoop heat: low structural groan and faint ticking of hot panels. */
export class HeatLayer extends Layer {
  private groan!: Target;
  private groanHz!: Target;
  private sizzle!: Target;

  protected level(s: AudioState): number {
    const m = heatMix(s);
    return m.groanGain + m.sizzleGain;
  }

  protected build(g: NodeGroup, _now: number): void {
    const { kit } = this;
    const bp = g.filter('bandpass', 90, 4);
    const groan = g.gain(0);
    g.noise(kit.brown, this.offset()).connect(bp).connect(groan).connect(this.out);
    const wander = g.osc('sine', 0.09);
    const wanderDepth = g.gain(18);
    wander.connect(wanderDepth);
    g.link(wanderDepth, bp.frequency);

    const sizzle = g.gain(0);
    g.noise(kit.white, this.offset(), 0.9)
      .connect(g.filter('highpass', 3200, 0.7))
      .connect(g.filter('lowpass', 7000, 0.7))
      .connect(sizzle)
      .connect(this.out);

    kRate(bp.frequency);
    this.groan = new Target(groan.gain, 0.5);
    this.groanHz = new Target(bp.frequency, 0.8);
    this.sizzle = new Target(sizzle.gain, 0.5);
  }

  protected apply(s: AudioState, now: number): void {
    const m = heatMix(s);
    this.groan.set(m.groanGain, now);
    this.groanHz.set(m.groanHz, now);
    this.sizzle.set(m.sizzleGain, now);
  }
}

/** Hyperspeed: rising resonant spool tone, then a deep drone through the hull while engaged. */
export class HyperLayer extends Layer {
  private spoolGain!: Target;
  private spoolHz!: Target;
  private spoolHz2!: Target;
  private spoolCut!: Target;
  private droneGain!: Target;
  private swell!: Target;

  protected level(s: AudioState): number {
    const m = hyperMix(s);
    return m.spoolGain + m.droneGain;
  }

  protected build(g: NodeGroup, _now: number): void {
    const { kit } = this;
    const hull = g.filter('lowpass', 2600, 0.5);
    hull.connect(this.out);

    const spoolLp = g.filter('lowpass', 300, 7);
    const spoolGain = g.gain(0);
    const s1 = g.osc(kit.buzz, 40);
    const s2 = g.osc(kit.buzz, 60);
    const s2g = g.gain(0.5);
    s1.connect(spoolLp);
    s2.connect(s2g).connect(spoolLp);
    spoolLp.connect(spoolGain).connect(hull);

    const droneGain = g.gain(0);
    const droneLp = g.filter('lowpass', 640, 0.7);
    // Sub: the score's tonic deep in the bass (tuning.ts) and a slowly beating twin.
    const f = this.tuning.droneHz;
    g.osc(kit.warm, f).connect(droneLp);
    g.osc(kit.warm, f * 1.0068).connect(droneLp);
    // Body: the same note an octave up with its overtones to about 600 Hz, well under the sub. Where a speaker cannot
    // play the sub, the ear still hears the drone at its true pitch (the missing-fundamental effect).
    const body = g.gain(DRONE_BODY);
    g.osc(kit.buzz, 2 * f, 5).connect(body);
    g.osc(kit.buzz, 2 * f, -5).connect(body);
    body.connect(droneLp);
    // Rushing texture, kept dark.
    g.noise(kit.pink, this.offset()).connect(g.gain(0.7)).connect(g.filter('lowpass', 280, 0.7)).connect(droneGain);
    droneLp.connect(droneGain).connect(hull);
    const swellLfo = g.osc('sine', 0.08);
    const swell = g.gain(0);
    swellLfo.connect(swell);
    g.link(swell, droneGain.gain);

    kRate(s1.frequency, s2.frequency, spoolLp.frequency);
    this.spoolGain = new Target(spoolGain.gain, 0.15);
    this.spoolHz = new Target(s1.frequency, 0.15);
    this.spoolHz2 = new Target(s2.frequency, 0.15);
    this.spoolCut = new Target(spoolLp.frequency, 0.15);
    this.droneGain = new Target(droneGain.gain, 0.6);
    this.swell = new Target(swell.gain, 0.6);
  }

  protected apply(s: AudioState, now: number): void {
    const m = hyperMix(s);
    this.spoolGain.set(m.spoolGain, now);
    this.spoolHz.set(m.spoolHz, now);
    this.spoolHz2.set(m.spoolHz * 1.5, now);
    this.spoolCut.set(m.spoolCutoff, now);
    this.droneGain.set(m.droneGain, now);
    this.swell.set(m.droneGain * 0.3, now);
  }
}
