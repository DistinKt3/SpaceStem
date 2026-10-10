/**
 * Time scales. The game clock runs in UTC (milliseconds since the Unix epoch, as Date.now()). Ephemerides are
 * indexed by TDB; we use TT ≈ TDB (difference < 2 ms, irrelevant at our precision).
 */
import { DAY_S, J2000_JD, TAI_MINUS_UTC_S, TT_MINUS_TAI_S } from './constants';

/** Julian date of the Unix epoch, 1970-01-01T00:00:00Z. */
const UNIX_EPOCH_JD = 2_440_587.5;

/** UTC Unix milliseconds -> Julian date (UTC). */
export function unixMsToJdUtc(ms: number): number {
  return UNIX_EPOCH_JD + ms / 86_400_000;
}

/** UTC Unix milliseconds -> Julian date (TT ≈ TDB). Uses the current leap-second count. */
export function unixMsToJdTdb(ms: number): number {
  return unixMsToJdUtc(ms) + (TAI_MINUS_UTC_S + TT_MINUS_TAI_S) / DAY_S;
}

/** UTC Unix milliseconds -> TDB seconds since J2000.0. */
export function unixMsToTdbSecondsSinceJ2000(ms: number): number {
  return (unixMsToJdTdb(ms) - J2000_JD) * DAY_S;
}

/** TDB seconds since J2000 -> UTC Unix milliseconds. */
export function tdbSecondsSinceJ2000ToUnixMs(t: number): number {
  const jdTdb = J2000_JD + t / DAY_S;
  const jdUtc = jdTdb - (TAI_MINUS_UTC_S + TT_MINUS_TAI_S) / DAY_S;
  return (jdUtc - UNIX_EPOCH_JD) * 86_400_000;
}

/**
 * Earth Rotation Angle (IERS Conventions 2010, eq. 5.15), radians, from UT1 Julian date (UT1 ≈ UTC within 0.9 s).
 */
export function earthRotationAngle(jdUt1: number): number {
  const tu = jdUt1 - J2000_JD;
  const turns = 0.779_057_273_264 + 1.002_737_811_911_354 * tu;
  return 2 * Math.PI * (turns - Math.floor(turns));
}
