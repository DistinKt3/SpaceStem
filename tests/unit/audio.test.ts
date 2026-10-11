/**
 * Pure audio logic: the seeded score generator, state-to-sound mappings, captions, sample generation and the
 * measurement tools. Web Audio rendering itself is verified in Chromium by tests/e2e/audio.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { AUDIO_CUES, AudioEngine, type AudioState } from '../../src/game/audio/audioEngine';
import { bandEnergyFraction, clickScore, countNonFinite, fft, peak, rms, spectralCentroid } from '../../src/game/audio/analysis';
import { ALL_CAPTION_KEYS, CUE_CAPTIONS, CaptionGate, STATE_CAPTIONS, StateCaptioner, type CaptionDef } from '../../src/game/audio/captions';
import { impulseResponse, makeLoopable, noise, padSpectrum, softClipCurve } from '../../src/game/audio/dsp';
import {
  DEFAULT_STATE,
  cabinMix,
  engineMix,
  heatMix,
  hyperMix,
  rcsMix,
  sanitizeDt,
  sanitizeState,
  volumeToGain,
  windIntensity,
  windMix,
} from '../../src/game/audio/mappings';
import {
  BELL_HIGH,
  BELL_LOW,
  MODES,
  PAD_HIGH,
  PAD_LOW,
  bellsForCycle,
  chordIndexAt,
  composeScore,
  instrumentBlips,
  isDiminished,
  midiToHz,
  scoreWindow,
  voiceLeadingDistance,
  type Score,
} from '../../src/game/audio/score';
import { hasKey, keySources, t } from '../../src/game/i18n';

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 1);
const pc = (m: number): number => ((m % 12) + 12) % 12;
const scalePcs = (s: Score): Set<number> => new Set(s.mode.steps.map((x) => pc(s.tonic + x)));
const st = (p: Partial<AudioState>): AudioState => ({ ...DEFAULT_STATE, ...p });

describe('audio score generator', () => {
  it('is a pure function of the seed', () => {
    for (const seed of [0, 1, 7, 123456, 0xffffffff]) {
      expect(JSON.stringify(composeScore(seed))).toBe(JSON.stringify(composeScore(seed)));
      expect(JSON.stringify(bellsForCycle(composeScore(seed), 3))).toBe(JSON.stringify(bellsForCycle(composeScore(seed), 3)));
    }
  });

  it('different seeds give different music', () => {
    const sigs = new Set(SEEDS.map((s) => {
      const sc = composeScore(s);
      return `${sc.tonic}|${sc.mode.name}|${sc.chords.map((c) => c.degree).join('')}`;
    }));
    expect(sigs.size).toBeGreaterThan(30);
    expect(new Set(SEEDS.map((s) => composeScore(s).mode.name)).size).toBe(MODES.length);
  });

  it('builds a calm, slow, diatonic loop of eight chords', () => {
    for (const seed of SEEDS) {
      const s = composeScore(seed);
      const scale = scalePcs(s);
      expect(s.chords).toHaveLength(8);
      expect(s.loopSeconds).toBeGreaterThan(70);
      expect(s.loopSeconds).toBeLessThan(140);
      expect(s.chords[0]!.degree).toBe(0);
      expect(s.chords[7]!.degree).not.toBe(0); // the loop returns to I
      let t0 = 0;
      for (const c of s.chords) {
        expect(c.start).toBeCloseTo(t0, 9);
        t0 += c.dur;
        expect(c.dur).toBeGreaterThan(7);
        expect(isDiminished(s.mode, c.degree)).toBe(false);
        expect(c.notes).toHaveLength(4);
        for (let i = 0; i < 4; i++) {
          const m = c.notes[i]!;
          expect(m).toBeGreaterThanOrEqual(PAD_LOW);
          expect(m).toBeLessThanOrEqual(PAD_HIGH);
          expect(scale.has(pc(m))).toBe(true);
          if (i > 0) expect(m - c.notes[i - 1]!).toBeGreaterThanOrEqual(2); // open voicing, no clusters
        }
        expect(c.bass).toBeGreaterThanOrEqual(36);
        expect(c.bass).toBeLessThan(48);
        expect(pc(c.bass)).toBe(c.pcs[0]);
        expect(c.brightness).toBeGreaterThanOrEqual(0.2);
        expect(c.brightness).toBeLessThanOrEqual(0.85);
      }
      expect(s.loopSeconds).toBeCloseTo(t0, 9);
    }
  });

  it('voice-leads smoothly, including across the loop seam', () => {
    for (const seed of SEEDS) {
      const s = composeScore(seed);
      for (let i = 0; i < s.chords.length; i++) {
        const a = s.chords[i]!.notes;
        const b = s.chords[(i + 1) % s.chords.length]!.notes;
        expect(voiceLeadingDistance(a, b), `seed ${seed} chord ${i}`).toBeLessThanOrEqual(11);
        for (let v = 0; v < 4; v++) expect(Math.abs(a[v]! - b[v]!)).toBeLessThanOrEqual(6);
      }
    }
  });

  it('bells are sparse, in key, in register, and evolve from cycle to cycle', () => {
    let total = 0;
    let differ = 0;
    for (const seed of SEEDS) {
      const s = composeScore(seed);
      const scale = scalePcs(s);
      for (let cycle = 0; cycle < 5; cycle++) {
        const bells = bellsForCycle(s, cycle);
        total += bells.length;
        for (let i = 0; i < bells.length; i++) {
          const b = bells[i]!;
          expect(b.t).toBeGreaterThanOrEqual(0);
          expect(b.t).toBeLessThan(s.loopSeconds);
          expect(b.midi).toBeGreaterThanOrEqual(BELL_LOW);
          expect(b.midi).toBeLessThanOrEqual(BELL_HIGH);
          expect(scale.has(pc(b.midi))).toBe(true);
          expect(b.vel).toBeGreaterThan(0);
          expect(b.vel).toBeLessThanOrEqual(1);
          if (i > 0) expect(b.t).toBeGreaterThanOrEqual(bells[i - 1]!.t);
        }
      }
      if (JSON.stringify(bellsForCycle(s, 0)) !== JSON.stringify(bellsForCycle(s, 1))) differ++;
    }
    const perMinute = total / SEEDS.length / 5 / (100 / 60);
    expect(perMinute).toBeGreaterThan(2); // there are some
    expect(perMinute).toBeLessThan(12); // but sparse: well under one note every five seconds
    expect(differ).toBeGreaterThan(SEEDS.length * 0.8);
  });

  it('windows tile the timeline exactly and repeat the harmony every loop', () => {
    const s = composeScore(11);
    const L = s.loopSeconds;
    const whole = scoreWindow(s, 0, 3 * L);
    const parts = [0, 0.7, 13.1, L - 0.01, L + 5, 2 * L, 2.5 * L, 3 * L];
    const pieces = parts.slice(1).map((b, i) => scoreWindow(s, parts[i]!, b));
    expect(pieces.flatMap((p) => p.chords.map((c) => c.at))).toEqual(whole.chords.map((c) => c.at));
    expect(pieces.flatMap((p) => p.bells.map((b) => b.at))).toEqual(whole.bells.map((b) => b.at));
    expect(whole.chords).toHaveLength(24);
    for (let i = 0; i < 8; i++) {
      expect(whole.chords[i + 8]!.at).toBeCloseTo(whole.chords[i]!.at + L, 9);
      expect(whole.chords[i + 8]!.notes).toEqual(whole.chords[i]!.notes);
    }
    expect(chordIndexAt(s, 0)).toBe(0);
    expect(chordIndexAt(s, L - 0.001)).toBe(7);
    expect(chordIndexAt(s, L + s.chords[3]!.start + 0.01)).toBe(3);
    expect(scoreWindow(s, Number.NaN, 5)).toEqual({ chords: [], bells: [] });
  });

  it('avionics blips are deterministic, sparse and tile across windows', () => {
    const a = instrumentBlips(5, 0, 120);
    expect(instrumentBlips(5, 0, 120)).toEqual(a);
    expect([...instrumentBlips(5, 0, 50), ...instrumentBlips(5, 50, 120)]).toEqual(a);
    expect(a.length).toBeGreaterThan(8);
    expect(a.length).toBeLessThan(40);
  });

  it('maps MIDI notes to frequency', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 9);
    expect(midiToHz(57)).toBeCloseTo(220, 9);
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3);
  });
});

describe('audio state mappings (honest silence)', () => {
  it('sanitizes NaN, infinities, out-of-range values and unknown modes', () => {
    const s = sanitizeState({ thrust: Number.NaN, rcs: 7, speedFraction: -1, hyperspeed: Infinity, atmosphereDensity: -0.5, airspeed: -Infinity, scoopHeat: 2, mode: 'warp' as AudioState['mode'], landed: 1 as unknown as boolean });
    expect(s).toEqual({ ...DEFAULT_STATE, rcs: 1, scoopHeat: 1 });
    expect(sanitizeState(undefined)).toEqual(DEFAULT_STATE);
    expect(sanitizeState({ airspeed: 1e9 }).airspeed).toBe(20_000);
    expect(sanitizeDt(Number.NaN)).toBe(0);
    expect(sanitizeDt(-1)).toBe(0);
    expect(sanitizeDt(10)).toBe(0.25);
  });

  it('wind is zero in vacuum or still air and grows with density x airspeed', () => {
    expect(windIntensity(0, 5000)).toBe(0);
    expect(windIntensity(1, 0)).toBe(0);
    expect(windMix(st({ atmosphereDensity: 0, airspeed: 3000 })).gain).toBe(0);
    expect(windIntensity(0.006, 100)).toBeLessThan(0.01); // Mars-thin air barely whispers
    let prev = 0;
    for (const v of [5, 20, 50, 100, 200, 400]) {
      const w = windIntensity(1, v);
      expect(w).toBeGreaterThan(prev);
      expect(w).toBeLessThan(1);
      prev = w;
    }
    expect(windIntensity(0.5, 100)).toBeCloseTo(windIntensity(1, 50), 12);
    expect(windIntensity(Number.NaN, 100)).toBe(0);
  });

  it('the engine is silent at zero thrust, grows with thrust and stays low-passed (felt through the hull)', () => {
    for (const mode of ['thrusters', 'impulse', 'cruise', 'hyperspeed'] as const) {
      const off = engineMix(st({ mode }));
      expect(off.rumbleGain + off.noiseGain + off.toneGain).toBe(0);
      let prev = -1;
      for (const thrust of [0.1, 0.3, 0.6, 1]) {
        const m = engineMix(st({ mode, thrust, speedFraction: 1 }));
        const level = m.rumbleGain + m.noiseGain + m.toneGain;
        expect(level).toBeGreaterThan(prev);
        prev = level;
        expect(m.hullCutoff).toBeLessThanOrEqual(800);
        expect(m.noiseCutoff).toBeLessThanOrEqual(600);
        expect(m.toneHz).toBeLessThan(200);
      }
    }
    // In hyperspeed the main engine recedes under the hyperspeed drone.
    expect(engineMix(st({ mode: 'hyperspeed', thrust: 1 })).noiseGain).toBeLessThan(engineMix(st({ mode: 'thrusters', thrust: 1 })).noiseGain);
  });

  it('other layers: silent at rest, active when driven', () => {
    expect(rcsMix(st({})).gain).toBe(0);
    expect(rcsMix(st({ rcs: 1 })).gain).toBeGreaterThan(0);
    expect(heatMix(st({ scoopHeat: 0.2 })).groanGain).toBe(0);
    expect(heatMix(st({ scoopHeat: 1 })).groanGain).toBeGreaterThan(0);
    const h0 = hyperMix(st({}));
    expect(h0.spoolGain + h0.droneGain).toBe(0);
    expect(hyperMix(st({ hyperspeed: 0.5, mode: 'hyperspeed' })).droneGain).toBe(0);
    expect(hyperMix(st({ hyperspeed: 0.5, mode: 'hyperspeed' })).spoolGain).toBeGreaterThan(0);
    expect(hyperMix(st({ hyperspeed: 1, mode: 'hyperspeed' })).droneGain).toBeGreaterThan(0);
    expect(hyperMix(st({ hyperspeed: 0.4 })).spoolHz).toBeGreaterThan(hyperMix(st({ hyperspeed: 0.1 })).spoolHz);
    // The cabin is always on.
    expect(cabinMix(st({})).humGain).toBeGreaterThan(0);
    expect(cabinMix(st({ landed: true })).humGain).toBeGreaterThan(0);
  });

  it('volume sliders map to gain with a square law and clamp', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBe(1);
    expect(volumeToGain(0.5)).toBe(0.25);
    expect(volumeToGain(2)).toBe(1);
    expect(volumeToGain(-1)).toBe(0);
    expect(volumeToGain(Number.NaN)).toBe(0);
  });
});

describe('audio captions', () => {
  it('every cue and state change has an English caption in en.audio.json', () => {
    for (const cue of AUDIO_CUES) expect(CUE_CAPTIONS[cue]).toBeDefined();
    expect(Object.keys(CUE_CAPTIONS).sort()).toEqual([...AUDIO_CUES].sort());
    for (const key of ALL_CAPTION_KEYS) {
      expect(hasKey(key), key).toBe(true);
      expect(t(key)).toMatch(/^\[.+\]$/);
    }
    for (const d of [...Object.values(CUE_CAPTIONS), ...Object.values(STATE_CAPTIONS)]) {
      expect(d.duration).toBeGreaterThanOrEqual(1.2);
      expect(d.duration).toBeLessThanOrEqual(5);
    }
  });

  it('all audio strings live in en.audio.json under the audio. prefix', () => {
    const mine = keySources().filter((k) => k.file.endsWith('en.audio.json'));
    expect(mine.length).toBeGreaterThan(50);
    for (const { key } of mine) expect(key.startsWith('audio.')).toBe(true);
    for (const cue of AUDIO_CUES) expect(hasKey(`audio.cue.${cue}`)).toBe(true);
    for (const m of MODES) expect(hasKey(`audio.mode.${m.name}`)).toBe(true);
    for (let i = 0; i < 12; i++) expect(hasKey(`audio.note.${i}`)).toBe(true);
  });

  const run = (frames: [number, Partial<AudioState>][], dt = 1 / 60): string[] => {
    const c = new StateCaptioner();
    const out: string[] = [];
    for (const [n, p] of frames) for (let i = 0; i < n; i++) out.push(...c.update(dt, st(p)).map((d: CaptionDef) => d.key.replace('audio.caption.', '')));
    return out;
  };

  it('engine start/stop is captioned once, with hysteresis against jitter', () => {
    const jitter: [number, Partial<AudioState>][] = [];
    for (let i = 0; i < 300; i++) jitter.push([1, { thrust: i % 2 ? 0.07 : 0.03 }]);
    expect(run(jitter)).toEqual(['engineStart']);
    expect(run([[30, { thrust: 0.5 }], [20, { thrust: 0 }], [30, { thrust: 0.5 }]])).toEqual(['engineStart']); // short blip off: no stop
    expect(run([[30, { thrust: 0.5 }], [60, { thrust: 0 }]])).toEqual(['engineStart', 'engineStop']);
    expect(run([[30, { thrust: 0.5 }], [30, { thrust: 0.95 }], [30, { thrust: 0.5 }]])).toEqual(['engineStart', 'engineSurge']);
    expect(run([[10, { thrust: 1 }]])).toEqual(['engineSurge']);
  });

  it('wind rises, roars and dies away only where there is air', () => {
    const frames: [number, Partial<AudioState>][] = [];
    for (let v = 0; v <= 300; v += 5) frames.push([2, { atmosphereDensity: 1, airspeed: v }]);
    for (let v = 300; v >= 0; v -= 5) frames.push([2, { atmosphereDensity: 1, airspeed: v }]);
    expect(run(frames)).toEqual(['windRising', 'windStrong', 'windFading']);
    expect(run([[200, { atmosphereDensity: 0, airspeed: 3000 }]])).toEqual([]);
  });

  it('hyperspeed spool, drone and wind-down', () => {
    const frames: [number, Partial<AudioState>][] = [];
    for (let h = 0; h <= 1.0001; h += 0.02) frames.push([2, { mode: 'hyperspeed', hyperspeed: Math.min(1, h) }]);
    frames.push([60, { mode: 'hyperspeed', hyperspeed: 1 }]);
    for (let h = 1; h >= 0; h -= 0.05) frames.push([2, { mode: 'cruise', hyperspeed: h }]);
    expect(run(frames)).toEqual(['hyperSpool', 'hyperDrone', 'hyperWindDown']);
    // Re-engaging during the wind-down is captioned; an aborted spool is not.
    expect(run([[10, { hyperspeed: 1 }], [10, { hyperspeed: 0.3 }], [10, { hyperspeed: 1 }]])).toEqual(['hyperSpool', 'hyperDrone', 'hyperWindDown', 'hyperDrone']);
    expect(run([[10, { hyperspeed: 0.3 }], [10, { hyperspeed: 0 }]])).toEqual(['hyperSpool']);
  });

  it('attitude jets and heat are rate limited / hysteretic', () => {
    expect(run([[600, { rcs: 0.5 }]])).toEqual(['rcs', 'rcs']); // 10 s at 60 Hz, 6 s cooldown
    const heat: [number, Partial<AudioState>][] = [];
    for (let i = 0; i < 100; i++) heat.push([1, { scoopHeat: i % 2 ? 0.52 : 0.45 }]);
    expect(run(heat)).toEqual(['heatStress']);
  });

  it('the caption gate drops a repeat while the same caption is on screen', () => {
    const g = new CaptionGate();
    const d = { key: 'audio.caption.uiHover', duration: 1.2 };
    expect(g.allow(d, 0)).toBe(true);
    expect(g.allow(d, 0.5)).toBe(false);
    expect(g.allow({ key: 'audio.caption.uiSelect', duration: 1 }, 0.5)).toBe(true);
    expect(g.allow(d, 1.3)).toBe(true);
  });
});

describe('audio sample generation', () => {
  it('noise loops are deterministic, finite, normalized and seamless at the wrap', () => {
    for (const color of ['white', 'pink', 'brown'] as const) {
      const a = noise(color, 48_000, 3);
      expect(a).toEqual(noise(color, 48_000, 3));
      expect(a).not.toEqual(noise(color, 48_000, 4));
      expect(countNonFinite(a)).toBe(0);
      expect(rms(a)).toBeCloseTo(0.25, 3);
      if (color !== 'white') {
        let meanStep = 0;
        for (let i = 1; i < a.length; i++) meanStep += Math.abs(a[i]! - a[i - 1]!);
        meanStep /= a.length - 1;
        expect(Math.abs(a[0]! - a[a.length - 1]!), color).toBeLessThan(6 * meanStep);
      }
    }
  });

  it('makeLoopable removes the seam a raw random walk would have', () => {
    const walk = new Float32Array(20_000);
    for (let i = 1; i < walk.length; i++) walk[i] = walk[i - 1]! + (i % 7 === 0 ? 0.05 : -0.01);
    expect(Math.abs(walk[0]! - walk[walk.length - 1]!)).toBeGreaterThan(1);
    const loop = makeLoopable(walk, 2000);
    expect(loop.length).toBe(18_000);
    expect(Math.abs(loop[0]! - loop[loop.length - 1]!)).toBeLessThan(0.1);
  });

  it('noise colours have the expected spectral tilt', () => {
    const sr = 48_000;
    expect(bandEnergyFraction(noise('white', sr, 1), sr, 0, 500)).toBeLessThan(0.05);
    expect(bandEnergyFraction(noise('brown', sr, 1), sr, 0, 500)).toBeGreaterThan(0.9);
    const pinkLow = bandEnergyFraction(noise('pink', sr, 1), sr, 0, 500);
    expect(pinkLow).toBeGreaterThan(0.2);
    expect(pinkLow).toBeLessThan(0.9);
  });

  it('the reverb impulse response decays, is decorrelated and deterministic', () => {
    const sr = 16_000;
    const [l, r] = impulseResponse(sr, { rt60: 2, predelay: 0.02, brightness: 0.5 }, 9);
    expect(l.length).toBe(Math.floor(sr * (2 * 1.05 + 0.02)));
    expect(peak(l.subarray(0, Math.floor(sr * 0.02)))).toBe(0);
    const n = l.length;
    const early = rms(l, Math.floor(sr * 0.02), Math.floor(sr * 0.2));
    const late = rms(l, n - Math.floor(sr * 0.2), n);
    expect(20 * Math.log10(early / late)).toBeGreaterThan(40);
    let num = 0;
    let dl = 0;
    let dr = 0;
    for (let i = 0; i < n; i++) {
      num += l[i]! * r[i]!;
      dl += l[i]! * l[i]!;
      dr += r[i]! * r[i]!;
    }
    expect(Math.abs(num / Math.sqrt(dl * dr))).toBeLessThan(0.3);
    expect(impulseResponse(sr, { rt60: 2, predelay: 0.02, brightness: 0.5 }, 9)[0]).toEqual(l);
  });

  it('the output safety curve is transparent below the knee and never exceeds 0.95', () => {
    const c = softClipCurve(4096, 4, 0.6, 0.95);
    const at = (x: number): number => c[Math.round(((x / 4 + 1) / 2) * (c.length - 1))]!;
    expect(at(0.3)).toBeCloseTo(0.3, 2);
    expect(at(-0.5)).toBeCloseTo(-0.5, 2);
    expect(peak(c)).toBeLessThanOrEqual(0.95);
    expect(at(4)).toBeGreaterThan(0.94);
    for (let i = 1; i < c.length; i++) expect(c[i]!).toBeGreaterThanOrEqual(c[i - 1]!);
    for (let i = 0; i < c.length; i++) expect(c[i]!).toBeCloseTo(-c[c.length - 1 - i]!, 6);
  });

  it('pad spectrum rolls off', () => {
    const { imag } = padSpectrum();
    expect(imag[1]).toBe(1);
    for (let n = 3; n < imag.length; n += 2) expect(imag[n]!).toBeLessThan(imag[n - 2]!);
  });
});

describe('audio analysis tools', () => {
  const sr = 48_000;
  const sine = (hz: number, secs: number, amp = 1): Float32Array => {
    const out = new Float32Array(Math.floor(sr * secs));
    for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
    return out;
  };

  it('measures level, peak and non-finite samples', () => {
    const s = sine(1000, 1);
    expect(rms(s)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(peak(s)).toBeCloseTo(1, 3);
    const bad = Float32Array.from([0, Number.NaN, 1, Infinity]);
    expect(countNonFinite(bad)).toBe(2);
    expect(rms(bad)).toBeCloseTo(Math.sqrt(1 / 4), 9);
  });

  it('finds frequency content', () => {
    const s = sine(1000, 1, 0.5);
    expect(bandEnergyFraction(s, sr, 900, 1100)).toBeGreaterThan(0.95);
    expect(spectralCentroid(s, sr)).toBeGreaterThan(950);
    expect(spectralCentroid(s, sr)).toBeLessThan(1050);
    const re = new Float64Array(64);
    const im = new Float64Array(64);
    for (let i = 0; i < 64; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / 64);
    fft(re, im);
    expect(re[5]).toBeCloseTo(32, 6);
    expect(Math.abs(re[6]!)).toBeLessThan(1e-9);
  });

  it('flags a click but not smooth music', () => {
    const smooth = new Float32Array(sr);
    for (let i = 0; i < sr; i++) smooth[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / sr) + 0.05 * Math.sin((2 * Math.PI * 331 * i) / sr) * (i / sr);
    expect(clickScore(smooth)).toBeLessThan(6);
    const clicked = smooth.slice();
    for (let i = 24_000; i < clicked.length; i++) clicked[i] = clicked[i]! + 0.01; // a -40 dB step
    expect(clickScore(clicked)).toBeGreaterThan(12);
  });
});

describe('AudioEngine without Web Audio (Node)', () => {
  it('is a safe no-op: never throws, stays locked', async () => {
    const captions: string[] = [];
    const e = new AudioEngine({ seed: 5, onCaption: (k) => captions.push(k) });
    expect(e.unlocked).toBe(false);
    e.update(Number.NaN, st({ thrust: Number.NaN }));
    e.update(0.016, null as unknown as AudioState);
    e.play('alert');
    e.play('nope' as unknown as 'alert');
    e.setVolumes({ master: Number.NaN, music: 2, sfx: -1 });
    e.setMuted(true);
    await expect(e.unlock()).resolves.toBeUndefined();
    expect(e.unlocked).toBe(false);
    expect(e.analyser()).toBeNull();
    expect(e.stats()).toMatchObject({ contextState: 'none', musicTime: null, activeCues: 0, lastError: null });
    expect(JSON.stringify(e.score)).toBe(JSON.stringify(composeScore(5)));
    e.dispose();
    e.dispose();
    e.update(0.016, DEFAULT_STATE);
    await expect(e.unlock()).resolves.toBeUndefined();
    expect(captions).toEqual([]);
  });

  it('survives a context factory that throws', async () => {
    const e = new AudioEngine({
      createContext: () => {
        throw new Error('no audio device');
      },
    });
    await expect(e.unlock()).resolves.toBeUndefined();
    expect(e.unlocked).toBe(false);
    expect(e.stats().lastError).toBe('no audio device');
  });
});
