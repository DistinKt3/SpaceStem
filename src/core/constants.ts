/**
 * Single source of truth for physical and astronomical constants. Every value cites its source.
 * Citation keys refer to public/data/citations.json.
 */

/** Speed of light in vacuum, exact by SI definition (BIPM SI Brochure, 9th ed., 2019). */
export const SPEED_OF_LIGHT_M_PER_S = 299_792_458;

/** Astronomical unit, exact (IAU 2012 Resolution B2). */
export const AU_M = 149_597_870_700;

/** Julian year in seconds (IAU: 365.25 days of 86400 s). */
export const JULIAN_YEAR_S = 365.25 * 86_400;

/** Light-year: distance light travels in one Julian year (IAU). */
export const LIGHT_YEAR_M = SPEED_OF_LIGHT_M_PER_S * JULIAN_YEAR_S;

/** Parsec: 648000/π au (IAU 2015 Resolution B2). */
export const PARSEC_M = (648_000 / Math.PI) * AU_M;

/** Newtonian constant of gravitation, CODATA 2018 (m^3 kg^-1 s^-2). */
export const G_SI = 6.674_30e-11;

/** Seconds per day. */
export const DAY_S = 86_400;

/** Julian date of the J2000.0 epoch (2000 Jan 1.5 TT). */
export const J2000_JD = 2_451_545.0;

/** Nominal solar radius, IAU 2015 Resolution B3 (Prša et al. 2016). */
export const SUN_RADIUS_M = 6.957e8;

/** Nominal solar luminosity, IAU 2015 Resolution B3 (W). */
export const SUN_LUMINOSITY_W = 3.828e26;

/** Nominal solar effective temperature, IAU 2015 Resolution B3 (K). */
export const SUN_TEFF_K = 5772;

/** Nominal Earth equatorial radius, IAU 2015 Resolution B3 (m). */
export const EARTH_RADIUS_EQ_M = 6.3781e6;

/** Nominal Jupiter equatorial radius, IAU 2015 Resolution B3 (m). */
export const JUPITER_RADIUS_EQ_M = 7.1492e7;

/** Absolute visual magnitude of the Sun (Willmer 2018, ApJS 236, 47): M_V = 4.81. */
export const SUN_ABS_MAG_V = 4.81;

/** Leap seconds: TAI − UTC = 37 s since 2017-01-01 (IERS Bulletin C). Valid until IERS announces another. */
export const TAI_MINUS_UTC_S = 37;

/** TT − TAI, exact by definition (IAU 1991). */
export const TT_MINUS_TAI_S = 32.184;
