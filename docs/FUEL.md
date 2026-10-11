# Hyper-fuel and star scooping

**Status:** M6 module, 2026-10-11. Code: `src/game/ship/fuel.ts` (model), `src/game/ship/fuelGauge.ts` (HUD widget),
`fuel.html` + `src/spike/fuelDemo.ts` (lab page). Tests: `tests/unit/fuel.test.ts`, `tests/e2e/fuel.spec.ts`.

The universe is real; the drive is fiction. This loop follows that rule:

| Part | Status | Where it comes from |
|---|---|---|
| Star luminosity, radius, effective temperature | **Real** (Measured or Inferred, as the star's own provenance says) | Body catalogue (`bodies.json`, HYG via `inferStar`) |
| Incident stellar flux at the ship | **Real physics** | F = L / (4 pi d^2) |
| Hyper-fuel tank, scoop band, scoop rate | **Game mechanic (fiction)** | This document |
| Hull heat scale, its limit and warnings | **Game mechanic (fiction)**, shaped like real radiative balance | This document |
| Jump cost | **Game mechanic (fiction)** | This document |

Every player-facing text about the loop says "game mechanic" (the gauge header, its accessible name, the refusal
message, the lab page). Nothing here is presented as a measured fact.

## 1. Stellar flux (real)

The scoop and the hull react to one physical quantity, the bolometric flux at the ship's distance `d` from the star's
centre, in units of the solar constant:

```
F = L / (4 pi d^2) / S0          (dimensionless; the Sun at 1 au gives 1.000)
```

| Constant | Value | Source |
|---|---|---|
| `S0`, solar constant | 1361 W/m^2 | Kopp & Lean 2011, *Geophys. Res. Lett.* 38, L01706, doi:10.1029/2010GL045777 (1360.8 +/- 0.5 W/m^2), rounded to the IAU 2015 Resolution B3 nominal value |
| `L_sun` | 3.828e26 W | IAU 2015 Resolution B3 (Prša et al. 2016), `src/core/constants.ts` |
| `sigma`, Stefan-Boltzmann | 5.670374419e-8 W m^-2 K^-4 | CODATA 2018 (exact in the 2019 SI) |

- `L = luminositySun x L_sun`. When a star has no valid luminosity, `L = 4 pi R^2 sigma T_eff^4` is used instead.
- Inside the photosphere the distance is clamped to the radius (the ship's collision keeps it outside anyway).
- With these constants the Sun at 1 au gives 1.0001 (the IAU defines `L_sun` from 1361 W/m^2 at 1 au).
- At the photosphere `F = sigma T_eff^4 / S0`: about 46,200 for the Sun. At the same distance **in stellar radii** a
  star gives `(T_eff / 5772 K)^4` times the Sun's flux, which is why hot stars are fast and dangerous to skim and cool
  dwarfs must be approached much closer (in radii).

## 2. Scoop (fiction)

```
inBand  = F >= 1,000                                   (scoopMinFlux)
open    = 0.5 + 0.5 x |throttle|                       (scoopIdleFactor = 0.5)
rate    = min(1/12, (1/240) x F / 1,000) x open        (fraction of the tank per second)
```

- The scoop works only while in the band, outside the photosphere, not landed and not in hyperspeed.
- At the band edge and full throttle a tank fills in 240 s; the rate grows linearly with flux up to a full tank in
  12 s. The cap is reached at F = 20,000, which is exactly the hull-limit flux below: the fastest safe scoop is at the
  edge of what the hull tolerates.
- Throttle widens the scoop ("skimming" through the corona fills faster than hovering). Zero throttle gives half rate.
- 'scoop-start' and 'scoop-stop' fire on transitions; 'tank-full' fires when the tank reaches 100 % (followed by
  'scoop-stop', since a full tank stops scooping).

## 3. Hull heat (fiction, Stefan-Boltzmann shaped)

Heat `h` is the hull temperature as a fraction of a fictional hull limit. A lumped body that absorbs a share of the
incident flux and radiates as `T^4` obeys `C dT/dt = a F - e sigma T^4`. Normalised to the limit it becomes:

```
dh/dt = (F / F_limit - h^4) / tau          F_limit = 20,000   tau = 12 s
h_eq  = (F / F_limit)^(1/4)                (equilibrium: the black-body temperature law)
```

- `h` is clamped to 0..1. Above `F_limit` the equilibrium would pass the limit, so heat reaches 1.0 in finite time.
- Cooling with no flux follows `1/h^3 = 1/h0^3 + 3 t / tau`: from 1.0 to 0.85 in 2.5 s, from 0.9 to 0.65 in 9 s,
  slower as the hull gets cold (radiative cooling weakens as T^4).
- For scale only: a black sphere at 1 au sits at 278 K, and this model puts it at heat 0.084, so heat 1.0 would
  correspond to about 3,300 K. No real hull material is implied; the limit is a game number.
- Integration: fixed substeps of at most 0.1 s with Heun's method (second order), so results do not depend on the
  frame rate (unit-tested at 60 fps vs 10 fps). Updates longer than 3,600 s are truncated. Fully deterministic.

### Warning levels

| Level | Heat | Event | Clears below | Player sees |
|---|---|---|---|---|
| Warning | 0.70 | `heat-warning` | 0.65 | Gauge "Hot" (amber, triangle outline icon), cockpit status Alert, `scoop-warning` cue |
| Critical | 0.90 | `heat-critical` | 0.85 | Gauge "Critical" (red, filled triangle), cockpit status red, `heat-critical` cue |
| Emergency | 1.00 | `heat-emergency` | 0.95 | Gauge "Emergency" (octagon), forced emergency climb, HUD line "Emergency climb" |

Levels rise straight to the highest one reached and emit **one** event (the highest); they fall one level at a time
with the 0.05 hysteresis, so a value sitting at a threshold never repeats events.

### Reference stars (measured parameters, distances in stellar radii from the centre)

| Star | R (R_sun) | L (L_sun) | T_eff (K) | Source | Surface flux | Band edge | Warning | Critical | Limit |
|---|---|---|---|---|---|---|---|---|---|
| Sun | 1 | 1 | 5772 | IAU 2015 B3 nominal | 46,200 | 6.80 | 3.10 | 1.88 | 1.52 |
| alpha Cen A | 1.2234 | 1.521 | 5795 | Kervella et al. 2017, A&A 597, A137 (Sect. 4.3) | 47,000 | 6.86 | 3.13 | 1.89 | 1.53 |
| Proxima Cen | 0.146 | 0.00151 | 2980 | Ribas et al. 2017, A&A 603, A58 | 3,280 | 1.81 | never | never | never |
| Sirius A | 1.713 | 24.7 | 9845 | Davis et al. 2011, PASA 28, 58 | 389,000 | 19.7 | 9.00 | 5.45 | 4.41 |

Proxima Centauri's photosphere gives only heat 0.64, so it can be scooped safely, but only within 1.8 radii and at
best a tank every 73 s. Sirius A opens the band at 20 radii and reaches the hull limit at 4.4 radii.

| Flux (x S0) | Equilibrium heat | Rate, full throttle | Empty to full |
|---|---|---|---|
| 1,000 | 0.47 | 25 %/min | 240 s |
| 2,000 | 0.56 | 50 %/min | 120 s |
| 4,800 | 0.70 (warning) | 120 %/min | 50 s |
| 13,100 | 0.90 (critical) | 328 %/min | 18 s |
| 20,000 | 1.00 (limit) | 500 %/min | 12 s |

## 4. Jump cost (fiction)

```
cost(d) = max(0.04, (d / 50 ly)^0.75)        fraction of a full tank
```

- A full tank reaches exactly 50 ly. Below 0.68 ly every jump costs the 4 % minimum.
- The exponent 0.75 makes cost grow more slowly than distance (sublinear), so one long jump is cheaper than two short
  ones of the same total; refuelling at stars on the way is what makes long trips possible.
- Distance is the ship-to-target-star distance when the jump is engaged (the same number the gauge's marker uses).
- Invalid distances (NaN, infinite) cost Infinity, so `canJump` is false.

| Destination (from Sol) | Distance | Cost |
|---|---|---|
| Proxima Centauri | 4.25 ly | 15.7 % |
| alpha Centauri A/B | 4.37 ly | 16.1 % |
| Sirius | 8.60 ly | 26.7 % |
| 25 ly | | 59.5 % |
| 50 ly | | 100 % |

Distances: alpha Cen from the parallax 747.17 mas (Kervella et al. 2016, as used by Kervella et al. 2017); Sirius
379.21 mas (van Leeuwen 2007, as used by Davis et al. 2011).

## 5. Low fuel

`fuel-low` fires once when the tank drops below 20 % (about one jump to alpha Centauri left) and re-arms above 25 %.
It also fires on the first update after loading a save that is already low.

## 6. API summary

```ts
const fuel = new FuelSystem({ hyperFuel: 1, heat: 0 });     // defaults: full tank, cold hull
fuel.jumpCost(ly); fuel.canJump(ly); fuel.consumeJump(ly);
const events = fuel.update(dt, env /* StarEnv | null */, { mode, throttle, landed });
fuel.scooping; fuel.fluxSolar; fuel.heatState; fuel.scoopRate; fuel.secondsToFull; fuel.equilibriumHeat;
fuel.toJSON();  FuelSystem.fromJSON(raw);                    // { version: 1, hyperFuel, heat }
loadFuel(); saveFuel(fuel);                                  // localStorage 'knownsky.fuel', guarded
```

Events come back in a fixed order: scoop-start, tank-full, scoop-stop, the heat event, fuel-low. Pure helpers
(`fluxSolar`, `scoopRate`, `equilibriumHeat`, `distanceForFlux`, `jumpCost`, `rangeFor`, `heatStateFor`) are exported
for the lab page and tests. `fromJSON` sanitises field by field (corrupt or missing values fall back to a full tank
and a cold hull; values are clamped to 0..1).

## 7. Gauge

`new FuelGauge(parent, { placement: 'hud' | 'inline' })`, then `update({ hyperFuel, heat, scooping, nextJumpCost,
secondsToFull?, heatState? })` each frame. It writes to the DOM only when something visible changes.

- Fuel bar with the next jump: a hatched segment marks the share the jump would use and a tick (with a small
  triangle) marks what is left; when the tank is short the segment becomes a dashed outline up to the cost, the tick
  turns to the danger colour and the line reads "✕ Next jump needs 27%".
- Heat bar with ticks at 70 % and 90 %; the state is a word plus an icon of a different shape per level.
- "Scooping · full in 25 s" chip while scooping; "Low" flag under 20 %.
- Accessibility: a `section` with an accessible name that says "game mechanic"; both bars are `role="meter"` with
  `aria-valuetext`; one polite live region announces state changes only (scooping started/stopped, tank full, heat
  level up or back to normal, low fuel, jump becomes affordable or not). Colours are the theme tokens, so the
  colour-blind palettes apply; every state also has a word or shape. Sizes are rem (text scaling). Animations stop
  under `prefers-reduced-motion` and `html[data-reduced-motion='true']` (the game setting).
- Placement 'hud' pins it top-right of the HUD root; on screens shorter than 36 rem it tightens its spacing.

## 8. Integration (summary)

`ShipController` owns a `FuelSystem` (loaded from storage, `?fuel=` overrides) and a `FuelGauge` in the HUD root. Each
frame it updates the system with the primary star (`sys.primaryStar`) and the ship's mode, throttle and landed state;
it refuses hyperspeed with `fuel.error.insufficient` when `canJump` is false and consumes the cost when the jump
engages; on `heat-emergency` it takes the controls for at least 4 s (and while the hull stays critical), turns the
nose radially away from the star and climbs in cruise at full throttle, then throttles back. Audio: `scoopHeat` =
heat; cues `scoop-warning`, `heat-critical`, `fuel-low`. The cockpit status uses the heat level (0.5 warning,
0.8 critical, 1 emergency). Saves happen on jumps, scoop stop, tank full, every 5 s and on `pagehide`. The exact code
is in the module's hand-off notes (shared-file requests).

## 9. Open questions

- Refund on an aborted spool: the cost is charged when the jump engages; a teleport during the 3 s spool loses it.
- Fuel is per browser (localStorage), like settings; the ship position is not saved yet, so a reload returns to Earth
  orbit with the saved tank.
- Tuning (band edge, rate, `F_limit`, jump range) has not been playtested.
