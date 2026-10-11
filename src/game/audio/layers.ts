/**
 * Continuous sound layers driven by ship state. Each layer builds its nodes only while it is audible and tears them
 * down after a few seconds of silence, so CPU is spent only on what can be heard (in deep space: just the cabin).
 * All level changes are parameter glides, never jumps, so nothing clicks.
 */
import type { AudioState } from './audioEngine';
import { cabinMix, engineMix, heatMix, hyperMix, rcsMix, windMix } from './mappings';
import { NodeGroup, Target, type Kit } from './nodes';

const SILENT = 1e-4;
const TEARDOWN_AFTER_S = 5;

export abstract class Layer {
  protected group: NodeGroup | null = null;
  protected readonly out: GainNode;
  private quietFor = 0;
  private lastNow = Number.NaN;

  constructor(
    protected readonly kit: Kit,
    dest: AudioNode,
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

  /** Apply the state at audio time `now` (the layer measures elapsed time on the audio clock). */
  update(s: AudioState, now: number): void {
    const dt = Number.isFinite(this.lastNow) ? Math.max(0, now - this.lastNow) : 0;
    this.lastNow = now;
    const lvl = this.level(s);
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
    if (this.group) this.apply(s, now);
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
    // Slightly inharmonic partials beat slowly against each other, like a real transformer hum.
    [
      [55, 1],
      [110.35, 0.42],
      [164.8, 0.16],
      [221.1, 0.05],
    ].forEach(([hz, a]) => g.osc(kit.warm, hz!).connect(g.gain(a)).connect(humBus));
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

  protected level(s: AudioState): number {
    const m = engineMix(s);
    return m.rumbleGain + m.noiseGain + m.toneGain;
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
    g.noise(kit.pink, this.offset()).connect(noiseCut).connect(noiseGain).connect(hull);
    // Combustion flutter: a little fast amplitude modulation on the roar.
    const flutterLfo = g.osc('sine', 5.3);
    const flutter = g.gain(0);
    flutterLfo.connect(flutter);
    g.link(flutter, noiseGain.gain);

    const toneGain = g.gain(0);
    const toneLp = g.filter('lowpass', 520, 0.7);
    const t1 = g.osc(kit.pad, 90);
    const t2 = g.osc(kit.pad, 90);
    t1.connect(toneLp);
    t2.connect(toneLp);
    toneLp.connect(toneGain).connect(hull);

    this.rumbleGain = new Target(rumbleGain.gain, 0.12);
    this.rumbleHz = new Target(rumble.frequency, 0.25);
    this.noiseGain = new Target(noiseGain.gain, 0.12);
    this.noiseCut = new Target(noiseCut.frequency, 0.2);
    this.toneGain = new Target(toneGain.gain, 0.2);
    this.toneHz = new Target(t1.frequency, 0.3);
    this.toneHz2 = new Target(t2.frequency, 0.3);
    this.hullCut = new Target(hull.frequency, 0.2);
    this.flutter = new Target(flutter.gain, 0.2);
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
    const droneLp = g.filter('lowpass', 260, 0.8);
    g.osc(kit.warm, 36.7).connect(droneLp);
    g.osc(kit.warm, 36.95).connect(droneLp);
    g.noise(kit.pink, this.offset()).connect(g.gain(0.7)).connect(droneLp);
    droneLp.connect(droneGain).connect(hull);
    const swellLfo = g.osc('sine', 0.08);
    const swell = g.gain(0);
    swellLfo.connect(swell);
    g.link(swell, droneGain.gain);

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
