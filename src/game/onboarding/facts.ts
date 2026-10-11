/**
 * The real science quoted by the guided opening. Every number shown on a tour card is computed here from a cited
 * constant (SI units), so the text and the physics cannot drift apart; tests/unit/onboarding.test.ts checks the
 * rounded values. Nothing here is gameplay fiction: lines that mention the ship's drive say "fiction" in their text.
 */
import { SPEED_OF_LIGHT_M_PER_S, LIGHT_YEAR_M, PARSEC_M } from '../../core/constants';
import { formatNumber } from '../i18n';

/** Earth's geocentric gravitational constant GM (m^3 s^-2), IERS Conventions (2010), Table 1.1 (Petit & Luzum 2010). */
export const EARTH_GM_M3_S2 = 3.986_004_418e14;
/** Earth's volumetric mean radius (m), NASA Earth Fact Sheet (Williams 2024). */
export const EARTH_MEAN_RADIUS_M = 6.371e6;
/** Standard acceleration of gravity (m s^-2), exact by definition (3rd CGPM, 1901). */
export const STANDARD_GRAVITY_M_S2 = 9.806_65;
/** The opening placement: 420 km above Earth (App.view('leo') in src/game/app.ts). */
export const START_ALTITUDE_M = 420_000;
/** Mean Earth-Moon distance (orbit semi-major axis, m), NASA Moon Fact Sheet (Williams 2024). */
export const MOON_MEAN_DISTANCE_M = 3.844e8;
/** Moon volumetric mean radius (m), NASA Moon Fact Sheet. */
export const MOON_MEAN_RADIUS_M = 1.737_4e6;
/** Moon equatorial surface gravity (m s^-2), NASA Moon Fact Sheet. */
export const MOON_SURFACE_GRAVITY_M_S2 = 1.62;
/**
 * Apollo 11 transit: launch 1969-07-16 13:32:00 UTC to lunar orbit insertion 1969-07-19 17:21:50 UTC
 * (NASA Apollo 11 Mission Report, MSC-00171, 1969), in seconds.
 */
export const APOLLO11_TRANSIT_S = Date.UTC(1969, 6, 19, 17, 21, 50) / 1000 - Date.UTC(1969, 6, 16, 13, 32, 0) / 1000;
/** Proxima Centauri parallax 768.0665 mas, Gaia DR3 (Gaia Collaboration, Vallenari et al. 2023, A&A 674, A1). */
export const PROXIMA_PARALLAX_MAS = 768.066_5;

/** Circular orbit speed (m/s) at an altitude above Earth's mean radius: v = sqrt(GM / r). */
export function circularSpeed(altitudeM: number): number {
  return Math.sqrt(EARTH_GM_M3_S2 / (EARTH_MEAN_RADIUS_M + altitudeM));
}

/** Circular orbit period (s) at an altitude above Earth's mean radius: T = 2 pi sqrt(r^3 / GM). */
export function orbitPeriod(altitudeM: number): number {
  const r = EARTH_MEAN_RADIUS_M + altitudeM;
  return 2 * Math.PI * Math.sqrt((r * r * r) / EARTH_GM_M3_S2);
}

/** Raw values in SI units (and the few derived ratios), for tests and documentation. */
export const FACTS = {
  startAltitudeM: START_ALTITUDE_M,
  orbitSpeedMS: circularSpeed(START_ALTITUDE_M),
  orbitPeriodS: orbitPeriod(START_ALTITUDE_M),
  moonLightTimeS: MOON_MEAN_DISTANCE_M / SPEED_OF_LIGHT_M_PER_S,
  moonDiameterM: 2 * MOON_MEAN_RADIUS_M,
  /** Mean apparent diameter of the Moon seen from Earth's centre (degrees). */
  moonAngularDiameterDeg: (2 * Math.atan(MOON_MEAN_RADIUS_M / MOON_MEAN_DISTANCE_M) * 180) / Math.PI,
  moonDistanceM: MOON_MEAN_DISTANCE_M,
  moonDistanceInEarthDiameters: MOON_MEAN_DISTANCE_M / (2 * EARTH_MEAN_RADIUS_M),
  moonGravityMS2: MOON_SURFACE_GRAVITY_M_S2,
  moonGravityFraction: MOON_SURFACE_GRAVITY_M_S2 / STANDARD_GRAVITY_M_S2,
  apolloTransitDays: APOLLO11_TRANSIT_S / 86_400,
  proximaDistanceLy: ((1000 / PROXIMA_PARALLAX_MAS) * PARSEC_M) / LIGHT_YEAR_M,
} as const;

/** Display strings for the i18n params of each card, formatted with the locale's number format. */
export function factParams(): Record<string, string> {
  const f = FACTS;
  return {
    altKm: formatNumber(f.startAltitudeM / 1000),
    orbitKmS: formatNumber(f.orbitSpeedMS / 1000, 1, 1),
    orbitMin: formatNumber(f.orbitPeriodS / 60),
    moonLightS: formatNumber(f.moonLightTimeS, 1, 1),
    moonDiameterKm: formatNumber(f.moonDiameterM / 1000),
    moonDistanceKm: formatNumber(Math.round(f.moonDistanceM / 1e5) * 100),
    moonEarths: formatNumber(f.moonDistanceInEarthDiameters),
    moonGravity: formatNumber(f.moonGravityMS2, 2, 2),
    moonGravityOneIn: formatNumber(1 / f.moonGravityFraction),
    apolloDays: formatNumber(f.apolloTransitDays),
    proximaLy: formatNumber(f.proximaDistanceLy, 1, 1),
  };
}
