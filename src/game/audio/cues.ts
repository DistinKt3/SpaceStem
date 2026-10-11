/**
 * One-shot cues. Each recipe builds a short node graph at audio time `t`, schedules its envelopes and returns the
 * time it falls silent. UI cues are short, soft and pitched in a consonant register; ship cues carry their sound
 * through the hull (low-passed). Every onset has an attack of at least 1 ms, so nothing clicks.
 */
import type { AudioCue } from './audioEngine';
import { NodeGroup, envelope, type Kit } from './nodes';
import { midiToHz } from './score';

export interface CueTarget {
  readonly kit: Kit;
  /** Dry effects bus. */
  readonly dry: AudioNode;
  /** Reverb send. */
  readonly wet: AudioNode;
  /** Score tonic (MIDI), so musical cues sit in the score's key. */
  readonly tonic: number;
  /** Score mode steps, for the codex arpeggio. */
  readonly steps: readonly number[];
}

interface Out {
  /** Node the recipe feeds; routed to dry and (with `wet`) to the reverb send. */
  readonly bus: GainNode;
}

type Recipe = (g: NodeGroup, t: number, o: Out, x: CueTarget) => number;

interface Ping {
  hz: number;
  wave?: PeriodicWave | OscillatorType;
  attack?: number;
  hold?: number;
  decay: number;
  peak: number;
  pan?: number;
  /** Glide the pitch to this frequency over the note. */
  glideTo?: number;
  glideTime?: number;
}

/** A single enveloped tone. Returns its end time. */
function ping(g: NodeGroup, o: Out, t: number, p: Ping): number {
  const osc = g.osc(p.wave ?? 'sine', p.hz);
  if (p.glideTo !== undefined) {
    osc.frequency.setValueAtTime(p.hz, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.glideTo), t + (p.glideTime ?? p.decay));
  }
  const env = g.gain(0);
  const end = envelope(env.gain, t, p.attack ?? 0.004, p.hold ?? 0, p.decay, p.peak);
  osc.connect(env);
  if (p.pan !== undefined && p.pan !== 0) env.connect(g.pan(p.pan)).connect(o.bus);
  else env.connect(o.bus);
  return end;
}

/** A filtered noise burst. */
function burst(
  g: NodeGroup,
  o: Out,
  t: number,
  buf: AudioBuffer,
  f: { type: BiquadFilterType; hz: number; q?: number; toHz?: number; sweep?: number },
  e: { attack: number; hold?: number; decay: number; peak: number },
  offset = 0,
): number {
  const src = g.noise(buf, offset);
  const filt = g.filter(f.type, f.hz, f.q ?? Math.SQRT1_2);
  if (f.toHz !== undefined) {
    filt.frequency.setValueAtTime(f.hz, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(10, f.toHz), t + (f.sweep ?? e.decay));
  }
  const env = g.gain(0);
  const end = envelope(env.gain, t, e.attack, e.hold ?? 0, e.decay, e.peak);
  src.connect(filt).connect(env).connect(o.bus);
  return end;
}

/** FM bell, like the score's, for musical UI moments. */
function bell(g: NodeGroup, o: Out, t: number, hz: number, peak: number, decay: number, pan = 0): number {
  const car = g.osc('sine', hz);
  const mod = g.osc('sine', hz * 3.5);
  const idx = g.gain(0);
  mod.connect(idx);
  g.link(idx, car.frequency);
  idx.gain.setValueAtTime(hz * 1.2, t);
  idx.gain.exponentialRampToValueAtTime(hz * 0.04, t + decay * 0.5);
  const env = g.gain(0);
  const end = envelope(env.gain, t, 0.005, 0, decay, peak);
  car.connect(env);
  if (pan !== 0) env.connect(g.pan(pan)).connect(o.bus);
  else env.connect(o.bus);
  return end;
}

const RECIPES: Record<AudioCue, Recipe> = {
  'ui-hover': (g, t, o) => {
    const lp = g.filter('lowpass', 5000);
    lp.connect(o.bus);
    const sub: Out = { bus: g.gain(1) };
    sub.bus.connect(lp);
    const a = ping(g, sub, t, { hz: 2093, attack: 0.002, decay: 0.07, peak: 0.05 });
    const b = ping(g, sub, t, { hz: 3136, attack: 0.002, decay: 0.035, peak: 0.015 });
    return Math.max(a, b);
  },
  'ui-select': (g, t, o) => {
    const a = ping(g, o, t, { hz: 1318.5, attack: 0.003, decay: 0.35, peak: 0.075, pan: -0.15 });
    const b = ping(g, o, t + 0.055, { hz: 1975.5, attack: 0.003, decay: 0.5, peak: 0.06, pan: 0.15 });
    return Math.max(a, b);
  },
  'ui-back': (g, t, o) => {
    const a = ping(g, o, t, { hz: 1174.7, wave: 'triangle', attack: 0.003, decay: 0.2, peak: 0.07 });
    const b = ping(g, o, t + 0.06, { hz: 880, wave: 'triangle', attack: 0.003, decay: 0.3, peak: 0.065 });
    return Math.max(a, b);
  },
  'target-lock': (g, t, o) => {
    let end = ping(g, o, t, { hz: 700, glideTo: 1400, glideTime: 0.12, attack: 0.006, decay: 0.16, peak: 0.05 });
    end = Math.max(end, ping(g, o, t + 0.17, { hz: 1400, attack: 0.003, decay: 0.1, peak: 0.065 }));
    end = Math.max(end, ping(g, o, t + 0.27, { hz: 1400, attack: 0.003, decay: 0.1, peak: 0.065 }));
    end = Math.max(end, ping(g, o, t + 0.37, { hz: 2100, attack: 0.004, hold: 0.05, decay: 0.5, peak: 0.055 }));
    end = Math.max(end, ping(g, o, t + 0.37, { hz: 1400, attack: 0.004, hold: 0.05, decay: 0.6, peak: 0.035 }));
    return end;
  },
  'mode-change': (g, t, o, x) => {
    // A soft relay tick, then a two-chord swell.
    let end = burst(g, o, t, x.kit.white, { type: 'bandpass', hz: 1400, q: 2 }, { attack: 0.0015, decay: 0.03, peak: 0.05 });
    const lp = g.filter('lowpass', 2600);
    lp.connect(o.bus);
    const soft: Out = { bus: g.gain(1) };
    soft.bus.connect(lp);
    for (const [hz, dt, pk] of [
      [440, 0.02, 0.04],
      [659.3, 0.02, 0.03],
      [587.3, 0.16, 0.04],
      [880, 0.16, 0.03],
    ] as const)
      end = Math.max(end, ping(g, soft, t + dt, { hz, wave: 'triangle', attack: 0.03, hold: 0.06, decay: 0.55, peak: pk }));
    return end;
  },
  'hyperspeed-spool': (g, t, o, x) => {
    const lp = g.filter('lowpass', 200, 9);
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(3200, t + 2.6);
    lp.connect(g.filter('lowpass', 4000, 0.5)).connect(o.bus);
    const env = g.gain(0);
    const end = envelope(env.gain, t, 0.5, 1.9, 0.9, 0.11);
    env.connect(lp);
    for (const [from, to, w] of [
      [55, 220, 1],
      [82.5, 330, 0.5],
    ] as const) {
      const osc = g.osc(x.kit.buzz, from);
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(to, t + 2.6);
      osc.connect(g.gain(w)).connect(env);
    }
    burst(g, o, t, x.kit.pink, { type: 'bandpass', hz: 400, q: 1.5, toHz: 3000, sweep: 2.6 }, { attack: 2.2, hold: 0.2, decay: 0.6, peak: 0.05 });
    return end;
  },
  'hyperspeed-engage': (g, t, o, x) => {
    // Deep whoosh carried through the hull: falling low-pass on noise, a sub drop and a thump.
    const hull = g.filter('lowpass', 2800, 0.5);
    hull.connect(o.bus);
    const h: Out = { bus: g.gain(1) };
    h.bus.connect(hull);
    let end = burst(g, h, t, x.kit.pink, { type: 'lowpass', hz: 2400, q: 1.2, toHz: 90, sweep: 2.4 }, { attack: 0.08, decay: 2.6, peak: 0.36 });
    end = Math.max(end, burst(g, h, t, x.kit.brown, { type: 'lowpass', hz: 400, q: 0.8, toHz: 60, sweep: 2 }, { attack: 0.05, decay: 2.4, peak: 0.36 }, 1.3));
    end = Math.max(end, ping(g, h, t, { hz: 72, wave: x.kit.warm, glideTo: 28, glideTime: 1.8, attack: 0.04, decay: 2.2, peak: 0.27 }));
    end = Math.max(end, ping(g, h, t, { hz: 52, attack: 0.008, decay: 0.45, peak: 0.2 }));
    return end;
  },
  'hyperspeed-exit': (g, t, o, x) => {
    // Descending shimmer: high partials in the score's key, each gliding down an octave, staggered and spread.
    const base = midiToHz(x.tonic + 60);
    const ratios = [1, 1.5, 2, 2.5, 3, 4];
    let end = 0;
    ratios.forEach((r, i) => {
      const hz = Math.min(5200, base * r);
      end = Math.max(
        end,
        ping(g, o, t + i * 0.07, { hz, glideTo: hz / 2, glideTime: 2.4, attack: 0.05, decay: 2.5, peak: 0.04, pan: (i % 2 === 0 ? -1 : 1) * (0.2 + 0.1 * i) }),
      );
    });
    end = Math.max(end, burst(g, o, t, x.kit.white, { type: 'highpass', hz: 6000, q: 0.7, toHz: 1500, sweep: 1.4 }, { attack: 0.05, decay: 1.4, peak: 0.04 }));
    return end;
  },
  'scoop-warning': (g, t, o) => {
    const lp = g.filter('lowpass', 3000);
    lp.connect(o.bus);
    const s: Out = { bus: g.gain(1) };
    s.bus.connect(lp);
    let end = 0;
    for (let i = 0; i < 3; i++) {
      end = Math.max(end, ping(g, s, t + i * 0.4, { hz: 740, wave: 'triangle', attack: 0.012, hold: 0.1, decay: 0.09, peak: 0.07 }));
      end = Math.max(end, ping(g, s, t + i * 0.4 + 0.2, { hz: 554.4, wave: 'triangle', attack: 0.012, hold: 0.1, decay: 0.09, peak: 0.07 }));
    }
    return end;
  },
  'heat-critical': (g, t, o) => {
    const lp = g.filter('lowpass', 1900, 0.8);
    lp.connect(o.bus);
    const s: Out = { bus: g.gain(1) };
    s.bus.connect(lp);
    let end = 0;
    for (let i = 0; i < 4; i++) {
      end = Math.max(end, ping(g, s, t + i * 0.26, { hz: 880, wave: 'square', attack: 0.01, hold: 0.09, decay: 0.05, peak: 0.045 }));
      end = Math.max(end, ping(g, s, t + i * 0.26, { hz: 440, wave: 'triangle', attack: 0.01, hold: 0.09, decay: 0.06, peak: 0.04 }));
    }
    return end;
  },
  'landing-contact': (g, t, o, x) => {
    const hull = g.filter('lowpass', 1800, 0.5);
    hull.connect(o.bus);
    const h: Out = { bus: g.gain(1) };
    h.bus.connect(hull);
    let end = ping(g, h, t, { hz: 78, wave: x.kit.warm, glideTo: 38, glideTime: 0.35, attack: 0.004, decay: 0.55, peak: 0.4 });
    end = Math.max(end, burst(g, h, t, x.kit.brown, { type: 'lowpass', hz: 280, q: 0.9 }, { attack: 0.003, decay: 0.35, peak: 0.48 }, 2.1));
    // Gear struts settling: a soft metallic creak.
    end = Math.max(end, burst(g, h, t + 0.09, x.kit.white, { type: 'bandpass', hz: 950, q: 9, toHz: 760, sweep: 0.4 }, { attack: 0.05, decay: 0.4, peak: 0.05 }, 0.7));
    return end;
  },
  alert: (g, t, o) => {
    let end = 0;
    [987.8, 880, 784].forEach((hz, i) => {
      end = Math.max(end, ping(g, o, t + i * 0.2, { hz, wave: 'triangle', attack: 0.01, hold: 0.08, decay: 0.12, peak: 0.075 }));
    });
    return end;
  },
  'codex-unlock': (g, t, o, x) => {
    // Rising arpeggio in the score's key: tonic, third, fifth, ninth.
    const root = x.tonic + 48;
    const third = x.steps[2] ?? 4;
    const notes = [root, root + third, root + 7, root + 14];
    let end = 0;
    notes.forEach((m, i) => {
      end = Math.max(end, bell(g, o, t + i * 0.11, midiToHz(m), 0.06 - i * 0.006, 1.8, -0.3 + i * 0.2));
    });
    return end;
  },
  'fuel-low': (g, t, o) => {
    let end = 0;
    for (let r = 0; r < 2; r++) {
      end = Math.max(end, ping(g, o, t + r * 0.65, { hz: 392, attack: 0.015, hold: 0.12, decay: 0.12, peak: 0.08 }));
      end = Math.max(end, ping(g, o, t + r * 0.65 + 0.28, { hz: 329.6, attack: 0.015, hold: 0.12, decay: 0.18, peak: 0.08 }));
    }
    return end;
  },
};

/** Reverb send per cue (0..1). */
const WET: Record<AudioCue, number> = {
  'ui-hover': 0.05,
  'ui-select': 0.2,
  'ui-back': 0.15,
  'target-lock': 0.2,
  'mode-change': 0.25,
  'hyperspeed-spool': 0.3,
  'hyperspeed-engage': 0.35,
  'hyperspeed-exit': 0.7,
  'scoop-warning': 0.15,
  'heat-critical': 0.12,
  'landing-contact': 0.15,
  alert: 0.2,
  'codex-unlock': 0.6,
  'fuel-low': 0.2,
};

/**
 * Build and schedule a cue at audio time `t`. Returns the node group (already started and set to stop) and the time
 * the cue is silent.
 */
export function playCue(cue: AudioCue, x: CueTarget, t: number): { group: NodeGroup; end: number } {
  const g = new NodeGroup(x.kit.ctx);
  const bus = g.gain(1);
  bus.connect(x.dry);
  const wet = WET[cue];
  if (wet > 0) bus.connect(g.gain(wet)).connect(x.wet);
  const end = RECIPES[cue](g, t, { bus }, x);
  g.start(t);
  g.stop(end + 0.05);
  return { group: g, end };
}
