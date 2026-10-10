/**
 * Explicit units. All simulation code works in SI meters and seconds; other units exist only at the edges
 * (data files, HUD formatting). Branded types make accidental mixing a compile error.
 */
import { AU_M, LIGHT_YEAR_M, PARSEC_M, SPEED_OF_LIGHT_M_PER_S } from './constants';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Meters = Brand<number, 'm'>;
export type AstronomicalUnits = Brand<number, 'au'>;
export type LightYears = Brand<number, 'ly'>;
export type Parsecs = Brand<number, 'pc'>;
export type Seconds = Brand<number, 's'>;
export type MetersPerSecond = Brand<number, 'm/s'>;

export const meters = (v: number): Meters => v as Meters;
export const seconds = (v: number): Seconds => v as Seconds;
export const metersPerSecond = (v: number): MetersPerSecond => v as MetersPerSecond;

export const auToMeters = (v: AstronomicalUnits | number): Meters => (v * AU_M) as Meters;
export const metersToAu = (v: Meters | number): AstronomicalUnits => (v / AU_M) as AstronomicalUnits;
export const lightYearsToMeters = (v: LightYears | number): Meters => (v * LIGHT_YEAR_M) as Meters;
export const metersToLightYears = (v: Meters | number): LightYears => (v / LIGHT_YEAR_M) as LightYears;
export const parsecsToMeters = (v: Parsecs | number): Meters => (v * PARSEC_M) as Meters;
export const metersToParsecs = (v: Meters | number): Parsecs => (v / PARSEC_M) as Parsecs;
export const parsecsToLightYears = (v: Parsecs | number): LightYears => ((v * PARSEC_M) / LIGHT_YEAR_M) as LightYears;

/** Time for light to cross a distance in vacuum. */
export const lightTravelTime = (d: Meters | number): Seconds => (d / SPEED_OF_LIGHT_M_PER_S) as Seconds;
/** Speed as a fraction (or multiple) of c. */
export const toFractionOfC = (v: MetersPerSecond | number): number => v / SPEED_OF_LIGHT_M_PER_S;
