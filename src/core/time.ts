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

/**
 * J2000.0 (2000-01-01T12:00:00 TT) as a Unix-millisecond UTC timestamp: 11:58:55.816 UTC, when TAI−UTC was 32 s.
 */
const J2000_UNIX_MS_UTC = 946_727_935_816;
/** Leap seconds inserted between J2000 and now (TAI−UTC was 32 s at J2000). */
const LEAP_SINCE_J2000_S = TAI_MINUS_UTC_S - 32;

/**
 * UTC Unix milliseconds -> TDB (≈TT) seconds since J2000.0, computed in milliseconds to keep sub-ms precision.
 * Valid after the last leap second (2017-01-01), which covers the game's ephemeris window.
 */
export function unixMsToTdbSecondsSinceJ2000(ms: number): number {
  return (ms - J2000_UNIX_MS_UTC) / 1000 + LEAP_SINCE_J2000_S;
}

/** TDB seconds since J2000 -> UTC Unix milliseconds (inverse of the above). */
export function tdbSecondsSinceJ2000ToUnixMs(t: number): number {
  return (t - LEAP_SINCE_J2000_S) * 1000 + J2000_UNIX_MS_UTC;
}

/**
 * Earth Rotation Angle (IERS Conventions 2010, eq. 5.15), radians, from UT1 Julian date (UT1 ≈ UTC within 0.9 s).
 */
export function earthRotationAngle(jdUt1: number): number {
  const tu = jdUt1 - J2000_JD;
  const turns = 0.779_057_273_264 + 1.002_737_811_911_354 * tu;
  return 2 * Math.PI * (turns - Math.floor(turns));
}
