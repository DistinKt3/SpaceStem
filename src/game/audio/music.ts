/**
 * Plays the generative score (score.ts) with a look-ahead scheduler: pad chords (detuned voice pairs spread left and
 * right, slow attack, long overlapping release), a soft bass, FM bells, a pad filter that follows each chord's
 * brightness plus two slow LFOs, and gentle detune drift. Everything is scheduled on the audio clock, so timing is
 * sample-accurate and the loop seam is inaudible.
 */
import { hashInts, toUnit } from '../../core/rng';
import { padCutoff } from './mappings';
import { NodeGroup, envelope, type Kit } from './nodes';
import { chordIndexAt, midiToHz, scoreWindow, type Score, type ScoreChord } from './score';

/** Seconds of music scheduled ahead of the audio clock. */
export const LOOKAHEAD_S = 2.5;
const PAD_ATTACK = 2.6;
/** Seconds to -60 dB: long, overlapping tails (time constant ~1.3 s). */
const PAD_RELEASE = 9;
const PAD_VOICE_PEAK = 0.032;
const BASS_PEAK = 0.075;
const BELL_PEAK = 0.06;

export class ScorePlayer {
  /** Audio time of score time 0 (NaN before start; negative when started with an offset). */
  private origin = Number.NaN;
  private scheduledUntil = 0;
  private wasEnabled = false;
  private readonly live = new Set<NodeGroup>();
  /** Chord instances currently sounding, by `cycle:index`, so a resume never doubles a chord. */
  private readonly liveChords = new Set<string>();
  private readonly fixed: NodeGroup;
  private readonly padL: StereoPannerNode;
  private readonly padR: StereoPannerNode;
  private readonly padFilter: BiquadFilterNode;
  private readonly bassIn: GainNode;
  private readonly bellBus: GainNode;
  private readonly detuneUp: GainNode;
  private readonly detuneDown: GainNode;

  constructor(
    private readonly kit: Kit,
    dry: AudioNode,
    wet: AudioNode,
    readonly score: Score,
  ) {
    const g = new NodeGroup(kit.ctx);
    this.fixed = g;
    this.padFilter = g.filter('lowpass', padCutoff(score.chords[0]?.brightness ?? 0.5), 0.6);
    this.padL = g.pan(-0.45);
    this.padR = g.pan(0.45);
    this.bassIn = g.gain(1);
    this.padL.connect(this.padFilter);
    this.padR.connect(this.padFilter);
    this.bassIn.connect(this.padFilter);
    const padOut = g.gain(1);
    this.padFilter.connect(padOut);
    padOut.connect(dry);
    padOut.connect(g.gain(0.55)).connect(wet);

    // Filter motion: two slow, unrelated LFOs on the cutoff.
    const lfo1 = g.osc('sine', 0.031);
    const lfo2 = g.osc('sine', 0.0113);
    const d1 = g.gain(260);
    const d2 = g.gain(170);
    lfo1.connect(d1);
    lfo2.connect(d2);
    g.link(d1, this.padFilter.frequency);
    g.link(d2, this.padFilter.frequency);

    // Gentle detune drift, opposite on left and right voices.
    const drift = g.osc('sine', 0.083);
    this.detuneUp = g.gain(3.5);
    this.detuneDown = g.gain(-3.5);
    drift.connect(this.detuneUp);
    drift.connect(this.detuneDown);

    this.bellBus = g.gain(1);
    const bellLp = g.filter('lowpass', 5200, 0.5);
    this.bellBus.connect(bellLp);
    bellLp.connect(g.gain(0.5)).connect(dry);
    bellLp.connect(g.gain(0.9)).connect(wet);
  }

  /** Begin the score at audio time `at`, `offset` seconds into the score (previews and tests start mid-loop). */
  start(at: number, offset = 0): void {
    if (this.started) return;
    const off = Number.isFinite(offset) ? Math.max(0, offset) : 0;
    this.origin = at - off;
    this.scheduledUntil = at;
    this.fixed.start(at);
  }

  get started(): boolean {
    return Number.isFinite(this.origin);
  }

  /** Seconds of score time at audio time `now` (null before start). */
  time(now: number): number | null {
    return this.started ? Math.max(0, now - this.origin) : null;
  }

  /**
   * Schedule everything that begins before now + LOOKAHEAD. When `enabled` is false (music muted or at zero volume)
   * the score clock keeps running but nothing is built; when it comes back the chord already sounding fades in.
   */
  pump(now: number, enabled: boolean): void {
    if (!this.started) return;
    if (!enabled) {
      // Consume the timeline only up to now, so onsets in the look-ahead window are still played on resume.
      this.wasEnabled = false;
      this.scheduledUntil = Math.max(this.scheduledUntil, now);
      return;
    }
    const from = Math.max(this.scheduledUntil, now - 0.05);
    if (!this.wasEnabled) {
      this.wasEnabled = true;
      this.resumeChord(now, from);
    }
    const horizon = now + LOOKAHEAD_S;
    if (horizon <= from) return;
    this.scheduledUntil = horizon;

    const w = scoreWindow(this.score, from - this.origin, horizon - this.origin);
    for (const c of w.chords) {
      const at = this.origin + c.at;
      const end = at + c.dur;
      const start = Math.max(at, now + 0.02);
      if (end - start < 1) continue;
      this.playChord(`${c.cycle}:${c.index}`, c, start, end, at < start ? Math.min(PAD_ATTACK, (end - start) * 0.5) : PAD_ATTACK);
    }
    for (const b of w.bells) {
      const at = this.origin + b.at;
      if (at < now) continue;
      this.playBell(b.midi, b.vel, b.pan, at);
    }
  }

  /** Fade in the chord whose onset lies before `from` (skipped while disabled, or before an offset start). */
  private resumeChord(now: number, from: number): void {
    const st = from - this.origin;
    if (st <= 0) return;
    const L = this.score.loopSeconds;
    const index = chordIndexAt(this.score, st);
    const cycle = Math.floor(st / L);
    const c = this.score.chords[index]!;
    const chordStart = this.origin + cycle * L + c.start;
    const end = chordStart + c.dur;
    const start = Math.max(now, from) + 0.02;
    if (chordStart < from && end - start > 1.5) this.playChord(`${cycle}:${index}`, c, start, end, Math.min(PAD_ATTACK, (end - start) * 0.5));
  }

  private track(g: NodeGroup, stopAt: number, onDone?: () => void): void {
    g.stop(stopAt);
    this.live.add(g);
    g.onEnded(() => {
      g.disconnect();
      this.live.delete(g);
      onDone?.();
    });
  }

  private playChord(key: string, c: ScoreChord, start: number, end: number, attack: number): void {
    if (this.liveChords.has(key)) return;
    this.liveChords.add(key);
    const { kit } = this;
    const g = new NodeGroup(kit.ctx);
    const envL = g.gain(0);
    const envR = g.gain(0);
    const envB = g.gain(0);
    envL.connect(this.padL);
    envR.connect(this.padR);
    envB.connect(this.bassIn);
    c.notes.forEach((m, i) => {
      const hz = midiToHz(m);
      const d = 3 + 5 * toUnit(hashInts(this.score.seed, m, i));
      const a = g.osc(kit.pad, hz, d);
      const b = g.osc(kit.pad, hz, -d);
      // The top voice sits a little back so the chord stays calm.
      const w = i === c.notes.length - 1 ? 0.75 : 1;
      a.connect(g.gain(w)).connect(envL);
      b.connect(g.gain(w)).connect(envR);
      g.link(this.detuneUp, a.detune);
      g.link(this.detuneDown, b.detune);
    });
    g.osc(kit.warm, midiToHz(c.bass)).connect(envB);
    this.padFilter.frequency.setTargetAtTime(padCutoff(c.brightness), start, 2.5);
    const hold = Math.max(0, end - start - attack);
    let stop = 0;
    for (const env of [envL, envR]) stop = envelope(env.gain, start, attack, hold, PAD_RELEASE, PAD_VOICE_PEAK, true);
    envelope(envB.gain, start, attack, hold, PAD_RELEASE, BASS_PEAK, true);
    g.start(start);
    this.track(g, stop + 0.05, () => this.liveChords.delete(key));
  }

  /** FM bell: inharmonic modulator ratio, decaying index, plus a quick high partial. */
  private playBell(midi: number, vel: number, pan: number, at: number): void {
    const { kit } = this;
    const g = new NodeGroup(kit.ctx);
    const hz = midiToHz(midi);
    const carrier = g.osc('sine', hz);
    const mod = g.osc('sine', hz * 3.5);
    const index = g.gain(0);
    mod.connect(index);
    g.link(index, carrier.frequency);
    index.gain.setValueAtTime(hz * 1.4, at);
    index.gain.exponentialRampToValueAtTime(hz * 0.04, at + 2.2);
    const amp = g.gain(0);
    const peak = BELL_PEAK * Math.max(0, Math.min(1, vel));
    const end = envelope(amp.gain, at, 0.006, 0, 4.2, peak);
    carrier.connect(amp);
    const partial = g.osc('sine', hz * 2.756);
    const pAmp = g.gain(0);
    envelope(pAmp.gain, at, 0.004, 0, 0.9, peak * 0.35);
    const panner = g.pan(pan);
    partial.connect(pAmp).connect(panner);
    amp.connect(panner).connect(this.bellBus);
    g.start(at);
    this.track(g, end + 0.05);
  }

  dispose(now: number): void {
    for (const g of this.live) g.kill(now);
    this.live.clear();
    this.liveChords.clear();
    this.fixed.kill(now);
  }
}
