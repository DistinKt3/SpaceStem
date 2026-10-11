/**
 * Generative ambient score: a pure, seeded pattern generator. Nothing here touches Web Audio; the player in
 * music.ts turns these events into sound. Same seed -> same score on every machine (integer-hash RNG from core/rng).
 *
 * Shape of the music:
 * - A slow loop of eight pad chords in one calm mode (lydian, ionian, dorian, mixolydian or aeolian), two or three
 *   bars each at roughly 45-55 bpm, so one loop lasts about 80-130 s. Chords never use a diminished triad.
 * - Four upper pad voices move by the smallest steps between chords (voice leading), including across the loop seam,
 *   so the loop joins without a jump. A soft bass note doubles each chord root.
 * - Sparse bell motifs (2-4 notes) over about a third of the chords. Bells vary per loop cycle (hash of seed, cycle and
 *   chord) while the harmony repeats, so the score evolves without ever drifting off its key.
 * - Per-chord "brightness" drives the pad filter for slow timbral motion.
 */
import { Rng, hashInts, toUnit } from '../../core/rng';

export interface ModeDef {
  /** i18n suffix: audio.mode.<name>. */
  readonly name: string;
  /** Semitone offsets of the seven scale degrees from the tonic. */
  readonly steps: readonly number[];
}

export const MODES: readonly ModeDef[] = [
  { name: 'lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { name: 'ionian', steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'aeolian', steps: [0, 2, 3, 5, 7, 8, 10] },
];

export interface ScoreChord {
  /** Seconds from the start of the loop. */
  readonly start: number;
  readonly dur: number;
  /** Scale degree of the chord root, 0..6. */
  readonly degree: number;
  /** Pitch classes of the chord (root first). */
  readonly pcs: readonly number[];
  /** Upper pad voices, MIDI note numbers, ascending. */
  readonly notes: readonly number[];
  /** Bass note (chord root), MIDI. */
  readonly bass: number;
  /** 0..1, pad filter openness while this chord sounds. */
  readonly brightness: number;
}

export interface ScoreBell {
  /** Seconds from the start of the loop. */
  readonly t: number;
  readonly midi: number;
  /** 0..1. */
  readonly vel: number;
  /** -1..1 stereo position. */
  readonly pan: number;
}

export interface Score {
  readonly seed: number;
  /** MIDI note of the tonic in the bass octave (38..45). */
  readonly tonic: number;
  readonly mode: ModeDef;
  readonly barSeconds: number;
  readonly loopSeconds: number;
  readonly chords: readonly ScoreChord[];
}

export const PAD_LOW = 53;
export const PAD_HIGH = 77;
export const BELL_LOW = 72;
export const BELL_HIGH = 91;
const CHORDS_PER_LOOP = 8;

export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const pc = (m: number): number => ((m % 12) + 12) % 12;

function stepOf(mode: ModeDef, degree: number): number {
  return mode.steps[((degree % 7) + 7) % 7]!;
}

/** Interval in semitones (0..11) from scale degree d up to degree d + k. */
function interval(mode: ModeDef, d: number, k: number): number {
  return pc(stepOf(mode, d + k) - stepOf(mode, d));
}

export function isDiminished(mode: ModeDef, degree: number): boolean {
  return interval(mode, degree, 4) !== 7;
}

/** Chord pitch classes for a degree: triad plus an optional colour tone (add9, 7th or sus2), chosen by `roll`. */
export function chordPitchClasses(mode: ModeDef, tonicPc: number, degree: number, roll: number): number[] {
  const root = pc(tonicPc + stepOf(mode, degree));
  const third = pc(tonicPc + stepOf(mode, degree + 2));
  const fifth = pc(tonicPc + stepOf(mode, degree + 4));
  const ninth = pc(tonicPc + stepOf(mode, degree + 1));
  const seventh = pc(tonicPc + stepOf(mode, degree + 6));
  const ninthOk = interval(mode, degree, 1) === 2; // a whole step; a minor ninth would clash
  if (roll < 0.15 && ninthOk) return [root, ninth, fifth]; // sus2
  if (roll < 0.65 && ninthOk) return [root, third, fifth, ninth]; // add9
  if (roll < 0.9) return [root, third, fifth, seventh]; // 7th chord (maj7 / m7 / dominant 7)
  return [root, third, fifth];
}

/** Every 4-note voicing of `pcs` within the pad range that is open enough to sound calm. */
function candidateVoicings(pcs: readonly number[]): number[][] {
  const pool: number[] = [];
  for (let m = PAD_LOW; m <= PAD_HIGH; m++) if (pcs.includes(pc(m))) pool.push(m);
  const out: number[][] = [];
  const n = pool.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const v = [pool[a]!, pool[b]!, pool[c]!, pool[d]!];
          if (v[1]! - v[0]! < 2 || v[2]! - v[1]! < 2 || v[3]! - v[2]! < 2) continue;
          if (v[3]! - v[0]! > 24) continue;
          // Every chord tone except the root (the bass carries it) must be present.
          const have = new Set(v.map(pc));
          if (!pcs.slice(1).every((p) => have.has(p))) continue;
          out.push(v);
        }
  return out;
}

/** A voicing's own cost (register, spread, doubled tones); movement is added by voiceLoop. */
function voicingCost(v: readonly number[]): number {
  const mean = (v[0]! + v[1]! + v[2]! + v[3]!) / 4;
  let cost = 0.35 * Math.abs(mean - 65);
  // Prefer compact voicings, but let smooth motion win over a strict span limit.
  cost += 0.6 * Math.max(0, v[3]! - v[0]! - 16);
  const distinct = new Set(v.map(pc)).size;
  cost += (4 - distinct) * 1.5;
  return cost;
}

/**
 * Globally smoothest voicings around the whole loop (a cycle): dynamic programming over every candidate voicing per
 * chord, minimising voice movement plus each voicing's own cost, with the seam (last -> first) included. Exact for
 * the best few first-chord voicings; ~10^5 operations per score.
 */
function voiceLoop(pcsList: readonly (readonly number[])[]): number[][] {
  const fallback = [PAD_LOW + 4, PAD_LOW + 7, PAD_LOW + 11, PAD_LOW + 14];
  const cands = pcsList.map((pcs) => {
    const c = candidateVoicings(pcs);
    return c.length > 0 ? c : [fallback];
  });
  const n = cands.length;
  const local = cands.map((cs) => cs.map(voicingCost));
  const starts = cands[0]!.map((_, j) => j).sort((a, b) => local[0]![a]! - local[0]![b]! || a - b).slice(0, 16);
  let bestCost = Infinity;
  let bestPath: number[] = [];
  for (const s0 of starts) {
    let cost = [local[0]![s0]!];
    let prevIdx = [s0];
    const back: number[][] = [];
    for (let i = 1; i < n; i++) {
      const cs = cands[i]!;
      const next: number[] = [];
      const arg: number[] = [];
      for (let k = 0; k < cs.length; k++) {
        let best = Infinity;
        let bj = 0;
        for (let j = 0; j < prevIdx.length; j++) {
          const c = cost[j]! + voiceLeadingDistance(cands[i - 1]![prevIdx[j]!]!, cs[k]!);
          if (c < best - 1e-9) {
            best = c;
            bj = j;
          }
        }
        next.push(best + local[i]![k]!);
        arg.push(bj);
      }
      back.push(arg);
      cost = next;
      prevIdx = cs.map((_, k) => k);
    }
    for (let k = 0; k < cost.length; k++) {
      const total = cost[k]! + voiceLeadingDistance(cands[n - 1]![k]!, cands[0]![s0]!);
      if (total < bestCost - 1e-9) {
        bestCost = total;
        const path = [k];
        for (let i = n - 2; i >= 1; i--) path.unshift(back[i]![path[0]!]!);
        bestPath = [s0, ...path];
      }
    }
  }
  return bestPath.map((k, i) => cands[i]![k]!);
}

/** Sum of absolute semitone moves between two voicings (sorted voices). */
export function voiceLeadingDistance(a: readonly number[], b: readonly number[]): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d += Math.abs(a[i]! - b[i]!);
  return d;
}

/** Next chord degree from a weighted walk over usable degrees (no repeats, prefers I, IV, V, vi, ii). */
function nextDegree(rng: Rng, mode: ModeDef, prev: number, last: boolean): number {
  const weights: Record<number, number> = { 0: 3, 1: 1.6, 2: 1, 3: 3, 4: 2.2, 5: 2.6, 6: 0.6 };
  const opts: [number, number][] = [];
  for (let d = 0; d < 7; d++) {
    if (d === prev || isDiminished(mode, d)) continue;
    if (last && d === 0) continue; // the loop returns to I, so the last chord must lead into it
    opts.push([d, weights[d]!]);
  }
  const total = opts.reduce((s, [, w]) => s + w, 0);
  let r = rng.next() * total;
  for (const [d, w] of opts) {
    r -= w;
    if (r <= 0) return d;
  }
  return opts[opts.length - 1]![0];
}

/** Compose the loop for a seed. Pure: same seed -> identical score. */
export function composeScore(seed: number): Score {
  const s = seed >>> 0;
  const rng = new Rng(hashInts(s, 0x5c0e));
  const mode = MODES[rng.int(0, MODES.length)]!;
  const tonicPc = [2, 4, 5, 7, 9][rng.int(0, 5)]!;
  const tonic = 36 + tonicPc;
  const barSeconds = 4 * (60 / rng.range(46, 54));

  const degrees: number[] = [0];
  for (let i = 1; i < CHORDS_PER_LOOP; i++) degrees.push(nextDegree(rng, mode, degrees[i - 1]!, i === CHORDS_PER_LOOP - 1));
  const bars = degrees.map((_, i) => (i === 0 ? 3 : rng.next() < 0.3 ? 3 : 2));
  const pcsList = degrees.map((d) => chordPitchClasses(mode, tonicPc, d, rng.next()));

  const voicings = voiceLoop(pcsList);

  // Slow brightness walk that comes back toward its starting value at the end of the loop.
  const bright: number[] = [];
  let b = 0.45;
  for (let i = 0; i < CHORDS_PER_LOOP; i++) {
    bright.push(b);
    b = Math.min(0.85, Math.max(0.2, b + rng.range(-0.22, 0.22)));
  }
  bright[CHORDS_PER_LOOP - 1] = (bright[CHORDS_PER_LOOP - 1]! + bright[0]!) / 2;

  const chords: ScoreChord[] = [];
  let t = 0;
  degrees.forEach((degree, i) => {
    const pcs = pcsList[i]!;
    const dur = bars[i]! * barSeconds;
    const bass = 36 + pcs[0]!; // root in the octave above C2
    chords.push({ start: t, dur, degree, pcs, notes: voicings[i]!, bass, brightness: bright[i]! });
    t += dur;
  });
  return { seed: s, tonic, mode, barSeconds, loopSeconds: t, chords };
}

/** Bell motifs for one cycle of the loop (cycle 0, 1, 2, ...). Pure and deterministic. */
export function bellsForCycle(score: Score, cycle: number): ScoreBell[] {
  const out: ScoreBell[] = [];
  const tonicPc = pc(score.tonic);
  const beat = score.barSeconds / 4;
  score.chords.forEach((c, i) => {
    const r = new Rng(hashInts(score.seed, 0xbe11, cycle, i));
    // About a third of chords carry a motif; never two loud ones back to back on the first chord of the loop.
    if (r.next() > 0.38) return;
    // Pool: chord tones plus the mode's 2nd and 6th degree, in the bell register (consonant, pentatonic-leaning).
    const allowed = new Set<number>([...c.pcs, pc(tonicPc + stepOf(score.mode, 1)), pc(tonicPc + stepOf(score.mode, 5))]);
    const pool: number[] = [];
    for (let m = BELL_LOW; m <= BELL_HIGH; m++) if (allowed.has(pc(m))) pool.push(m);
    if (pool.length === 0) return;
    const count = r.int(2, 5);
    let idx = r.int(Math.floor(pool.length * 0.25), Math.ceil(pool.length * 0.75));
    let tt = c.start + beat * r.int(2, 6);
    const pan0 = r.range(-0.55, 0.55);
    for (let k = 0; k < count; k++) {
      if (tt >= score.loopSeconds - 0.25) break;
      out.push({ t: tt, midi: pool[idx]!, vel: r.range(0.4, 0.75) * (k === 0 ? 1 : 0.82), pan: Math.max(-0.8, Math.min(0.8, pan0 + r.range(-0.2, 0.2))) });
      const steps = [-2, -1, 1, 2, 1, -1];
      idx = Math.max(0, Math.min(pool.length - 1, idx + steps[r.int(0, steps.length)]!));
      tt += beat * [1, 1.5, 2, 3][r.int(0, 4)]!;
    }
  });
  return out.sort((a, b) => a.t - b.t);
}

export interface TimedChord extends ScoreChord {
  /** Absolute score time (seconds since the music started). */
  readonly at: number;
  readonly cycle: number;
  readonly index: number;
}
export interface TimedBell extends ScoreBell {
  readonly at: number;
}

/** All chord and bell onsets with absolute score time in [t0, t1). */
export function scoreWindow(score: Score, t0: number, t1: number): { chords: TimedChord[]; bells: TimedBell[] } {
  const chords: TimedChord[] = [];
  const bells: TimedBell[] = [];
  if (!(t1 > t0) || !Number.isFinite(t0) || !Number.isFinite(t1)) return { chords, bells };
  const L = score.loopSeconds;
  const c0 = Math.max(0, Math.floor(t0 / L));
  const c1 = Math.floor(t1 / L);
  for (let cyc = c0; cyc <= c1; cyc++) {
    const base = cyc * L;
    score.chords.forEach((c, index) => {
      const at = base + c.start;
      if (at >= t0 && at < t1) chords.push({ ...c, at, cycle: cyc, index });
    });
    for (const b of bellsForCycle(score, cyc)) {
      const at = base + b.t;
      if (at >= t0 && at < t1) bells.push({ ...b, at });
    }
  }
  return { chords, bells };
}

/** Index of the chord sounding at absolute score time t. */
export function chordIndexAt(score: Score, t: number): number {
  const local = ((t % score.loopSeconds) + score.loopSeconds) % score.loopSeconds;
  for (let i = score.chords.length - 1; i >= 0; i--) if (local >= score.chords[i]!.start) return i;
  return 0;
}

export interface Blip {
  readonly at: number;
  readonly hz: number;
  /** 1 or 2 short tones. */
  readonly count: number;
  readonly vel: number;
  /** -1..1: instruments sit around the pilot. */
  readonly pan: number;
}

/** Sparse avionics blips (instrument tones) in [t0, t1): one 1.6 s slot in four on average. Pure. */
export function instrumentBlips(seed: number, t0: number, t1: number): Blip[] {
  const SLOT = 1.6;
  const out: Blip[] = [];
  if (!(t1 > t0) || !Number.isFinite(t0) || !Number.isFinite(t1)) return out;
  for (let k = Math.max(0, Math.floor(t0 / SLOT)); k * SLOT < t1; k++) {
    const h = hashInts(seed >>> 0, 0xa710, k);
    if (toUnit(h) > 0.24) continue;
    const at = k * SLOT + toUnit(hashInts(h, 1)) * SLOT * 0.8;
    if (at < t0 || at >= t1) continue;
    const tones = [1568, 1760, 2093, 2349, 2637];
    out.push({
      at,
      hz: tones[hashInts(h, 2) % tones.length]!,
      count: toUnit(hashInts(h, 3)) < 0.35 ? 2 : 1,
      vel: 0.5 + 0.5 * toUnit(hashInts(h, 4)),
      pan: toUnit(hashInts(h, 5)) * 1.2 - 0.6,
    });
  }
  return out;
}
