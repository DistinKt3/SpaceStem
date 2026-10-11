/**
 * Key-aware pitches for every tonal sound outside the score: the codex and hyperspeed-exit cues, the avionics blips,
 * the cabin hum and the hyperspeed drone all sit in the score's key, so the ship never clashes with its own music.
 * Pure functions of the score's tonic and mode, unit-tested. (Warning tones keep fixed pitches on purpose: an alarm
 * should stand apart from the music and sound the same in every save.)
 */
import { midiToHz } from './score';

export interface MusicalKey {
  /** Tonic as a MIDI note (any octave). */
  readonly tonic: number;
  /** Semitone offsets of the seven scale degrees (score.mode.steps). */
  readonly steps: readonly number[];
}

export const pitchClass = (m: number): number => ((Math.round(m) % 12) + 12) % 12;

/** Pitch classes of the key's scale. */
export function scalePitchClasses(k: MusicalKey): Set<number> {
  return new Set(k.steps.map((s) => pitchClass(k.tonic + s)));
}

/** True when the MIDI note belongs to the key's scale. */
export const inKey = (k: MusicalKey, midi: number): boolean => scalePitchClasses(k).has(pitchClass(midi));

/** The lowest MIDI note at or above `lo` with pitch class `pc`. */
export function noteAtOrAbove(pc: number, lo: number): number {
  return lo + ((((pc - lo) % 12) + 12) % 12);
}

const degree = (k: MusicalKey, d: number, fallback: number): number => k.steps[d] ?? fallback;

/**
 * Hyperspeed exit shimmer, highest note first: the tonic triad spread over two octaves (root, third, fifth, octave,
 * tenth, twelfth). The root sits between A#5 and A6, so the top note stays below about 5.3 kHz for any tonic. The
 * third comes from the mode, so minor modes stay minor. Six distinct pitches, all in the scale.
 */
export function exitShimmerNotes(k: MusicalKey): number[] {
  const root = noteAtOrAbove(pitchClass(k.tonic), 82);
  const third = degree(k, 2, 4);
  const fifth = degree(k, 4, 7);
  return [12 + fifth, 12 + third, 12, fifth, third, 0].map((o) => root + o);
}

/** Codex unlock arpeggio, rising: tonic, third, fifth and ninth around D6 to A6. */
export function codexNotes(k: MusicalKey): number[] {
  const root = noteAtOrAbove(pitchClass(k.tonic), 84);
  return [root, root + degree(k, 2, 4), root + degree(k, 4, 7), root + 12 + degree(k, 1, 2)];
}

/** Avionics blip pitches (Hz): scale degrees 1, 2, 3, 5 and 6 with the tonic between C6 and B6 (1.0 to 3.3 kHz). */
export function blipFrequencies(k: MusicalKey): number[] {
  const root = noteAtOrAbove(pitchClass(k.tonic), 84);
  return [0, 1, 2, 4, 5].map((d) => midiToHz(root + degree(k, d, [0, 2, 4, 5, 7, 9, 11][d]!)));
}

/**
 * Cabin power hum fundamental (Hz): the tonic or the fifth, whichever lies nearest to A1 (55 Hz), so the hum stays
 * between about 46 and 65 Hz (a plausible electrical hum) and is consonant with the score.
 */
export function humFrequency(k: MusicalKey): number {
  const target = 33; // A1
  let best = target;
  let bestDist = Infinity;
  for (const pc of [pitchClass(k.tonic), pitchClass(k.tonic + degree(k, 4, 7))]) {
    for (const m of [noteAtOrAbove(pc, target - 6), noteAtOrAbove(pc, target - 6) + 12]) {
      const d = Math.abs(m - target);
      if (d < bestDist) {
        bestDist = d;
        best = m;
      }
    }
  }
  return midiToHz(best);
}

/** Hyperspeed drone fundamental (Hz): the tonic between D1 and C#2 (37 to 69 Hz). */
export function droneFrequency(k: MusicalKey): number {
  return midiToHz(noteAtOrAbove(pitchClass(k.tonic), 26));
}
