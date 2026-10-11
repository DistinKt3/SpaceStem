# Hyper-fuel and star scooping

**Status:** M6, integrated in the game, 2026-10-11. Code: `src/game/ship/fuel.ts` (model), `src/game/ship/fuelGauge.ts`
(HUD widget), `src/game/ship/shipFuel.ts` (game integration), `src/game/ship/fuelLayout.ts` (HUD placement),
`fuel.html` + `src/spike/fuelDemo.ts` (lab page, part of the build). Tests: `tests/unit/fuel.test.ts`,
`tests/unit/fuelIntegration.test.ts`, `tests/e2e/fuel.spec.ts` (lab, gauge, HUD layout), `tests/e2e/fuelGame.spec.ts`
(the real game).

The universe is real; the drive is fiction. This loop follows that rule:

| Part | Status | Where it comes from |
|---|---|---|
| Star luminosity, radius, effective temperature | **Real** (Measured or Inferred, as the star's own provenance says) | Body catalogue (`bodies.json`, HYG via `inferStar`) |
| Incident stellar flux at the ship | **Real physics** | F = L / (4 pi d^2) |
| Hyper-fuel tank, scoop band, scoop rate | **Game mechanic (fiction)** | This document |
| Hull heat scale, its limit and warnings | **Game mechanic (fiction)**, shaped like real radiative balance | This document |
| Jump cost | **Game mechanic (fiction)** | This document |

Every player-facing text about the loop says "game mechanic" (the gauge header, its accessible name and description,
the refusal message, the lab page), and the Codex entry "The drive is fiction" explains which part is real (the flux)
and which is invented (tank, scoop rate, heat limit, jump cost; a Generated fact gives the 50 ly range). Nothing here
is presented as a measured fact.

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

- `h` is clamped to 0..1. At exactly `F_limit` the heat approaches 1 asymptotically (0.5 to 0.99 takes about 15 s);
  above it the equilibrium would pass the limit, so heat reaches 1.0 in finite time.
- Cooling with no flux follows `1/h^3 = 1/h0^3 + 3 t / tau`: from 1.0 to 0.85 in 2.5 s, from 0.9 to 0.65 in 9 s,
  slower as the hull gets cold (radiative cooling weakens as T^4).
- For scale only: a black sphere at 1 au sits at 278 K, and this model puts it at heat 0.084, so heat 1.0 would
  correspond to about 3,300 K. No real hull material is implied; the limit is a game number.
- Integration: each update is split into equal substeps of at most 0.1 s (1/60 s at 60 fps) with Heun's method
  (second order), so results do not depend on the frame rate (unit-tested at 60 fps vs 10 fps; they agree to about
  1e-5). Updates longer than 3,600 s are truncated. Fully deterministic.

### Warning levels

| Level | Heat | Event | Clears below | Player sees |
|---|---|---|---|---|
| Warning | 0.70 | `heat-warning` | 0.65 | Gauge "Hot" (amber, triangle outline icon), cockpit status Alert, `scoop-warning` cue |
| Critical | 0.90 | `heat-critical` | 0.85 | Gauge "Critical" (red, filled triangle), cockpit status red, `heat-critical` cue |
| Emergency | 1.00 | `heat-emergency` | 0.95 | Gauge "Emergency" (octagon), forced emergency climb, HUD line "Emergency climb" |

Levels rise straight to the highest one reached and emit **one** event (the highest); they fall one level at a time
with the 0.05 hysteresis, so a value sitting at a threshold never repeats events. A system created or restored with a
hot hull reports its level on the first update (the reported level starts at nominal), so a hull restored at the limit
still triggers the climb; the game and the lab also start the climb from the `emergency` state itself.

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
- The cost is paid when hyperspeed engages. If the spool is aborted before the transit starts (a teleport), it is
  refunded; a transit cut short is not.
- Invalid distances (NaN, infinite, negative) cost Infinity, so `canJump` is false.

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
fuel.jumpCost(ly); fuel.canJump(ly); fuel.consumeJump(ly); fuel.refuel(amount);
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
jumpStatus?, secondsToFull?, heatState? })` each frame. It writes to the DOM only when something visible changes.

- Fuel bar with the next jump: a hatched segment marks the share the jump would use and a tick (with a small
  triangle) marks what is left; when the tank is short the segment becomes a dashed outline up to the cost, the tick
  turns to the danger colour and the line reads "✕ Next jump needs 27%".
- The line under the bar has five states (`data-jump`): `ok` ("Next jump 27% · leaves 3%"), `short`, `none` ("No star
  targeted"), `tooClose` ("Target star too close to jump to": a star closer than 0.01 ly, such as the Sun seen from
  Earth, or the star just reached) and `underway` ("Jump under way · used 27%"). While a jump is under way the gauge
  does not compare the selected target with the tank the jump has already paid from, so it never claims a paid jump
  is unaffordable.
- Heat bar with ticks at 70 % and 90 %; the state is a word plus an icon of a different shape per level.
- "Scooping · full in 25 s" chip while scooping; "Low" flag under 20 %.
- Text wraps rather than being cut off (the jump line, the "Game mechanic" tag, the scooping chip), so nothing is lost
  in a narrow container at large text.
- Accessibility: a `section` whose accessible name says "game mechanic" and whose description (`aria-describedby`)
  says what is fiction and what is real; both bars are `role="meter"` with `aria-valuetext`; one polite live region
  announces state changes only (scooping started/stopped, tank full, heat level up or back to normal, low fuel, jump
  becomes affordable or not). At the hull limit it says "Hull heat at its limit."; the host names the action
  ("Emergency climb") on its own line, so no message is spoken twice. Colours are the theme tokens, so the colour-blind
  palettes apply; every state also has a word or shape. Sizes are rem (text scaling). Animations stop under
  `prefers-reduced-motion` and `html[data-reduced-motion='true']` (the game setting).
- `setDensity('compact')` tightens the spacing. The game sets it from the HUD height measured in rem (under 36 rem),
  which follows the text-scale setting; a rem media query would not, because rem in a media query is always 16 px.

## 8. Integration in the game

`ShipController` owns a `ShipFuel` (`src/game/ship/shipFuel.ts`), which holds the `FuelSystem` and the `FuelGauge`
(a child of the HUD root, so hiding the HUD hides it). The controller calls it at fixed points:

| Hook | When | What it does |
|---|---|---|
| `update(dt)` | Each simulated frame, after the flight and hyperspeed step | Scoop and hull heat from the system's star (`sys.primaryStar`: its real luminosity, radius and temperature; a missing luminosity falls back to radius and temperature) and the ship's mode, throttle and landed state. Plays the cues (`scoop-warning` at the warning level, `heat-critical` at critical and at the limit, `fuel-low`). Starts the climb at the limit, settles a paid jump, saves. |
| `steerClimb(dt, controls)` | Before the flight step | The emergency climb: the player's steering, throttle and mode keys are ignored, the nose turns radially away from the star at 2.5 rad/s, and once it points within about 30° of "away" the ship climbs in cruise at full throttle (cruise's governor scales with the distance, so the climb is fast near the star). It lasts at least 4 s and as long as the hull stays critical, then the throttle returns to zero. Auto-align is switched off. A ship resting on the photosphere (it can sink there in thrusters mode, whose thrust cannot hold against a star's gravity) lifts off first. No climb in hyperspeed (the jump carries the ship away). |
| `chargeJump(distanceM)` | When hyperspeed has accepted a jump | Pays the cost. When the tank is short the spool is cancelled and the HUD shows "Not enough hyper-fuel: scoop near a star (game mechanic)". Hyperspeed's own refusals (landed, gravity well, already at the star) come first. |
| `onPlace()` | After a teleport (named views, share links) | Refunds a jump whose spool was aborted before the transit started, and ends a climb. |
| `updateHud(targetId, distanceM)` | After the HUD update | Feeds the gauge (the jump states above; the jump-target rule is the one `engageHyperspeed` uses: the Sun, a catalogue star or an exoplanet system) and runs the HUD layout pass. |

The HUD warning line shows "Emergency climb" during the climb. The cockpit status follows the heat (0.5 at the warning
level: the word ALERT and amber; 0.8 at critical and 1 at the limit: red); it is not merged into the HUD's own alert,
so the generic alert cue does not double the heat cues. Audio: `scoopHeat` = heat drives the hull-stress sound.

**HUD layout** (`fuelLayout.ts`). The gauge sits top-right, the HUD's target panel is vertically centred on the right
and the speed panel is centred at the top; all are sized in rem, so whether they collide depends on the viewport
measured in rem. The layout pass (10 times a second, and at once after a resize or a text-scale change) measures the
panels and:

- puts the gauge top-right, or just below the speed panel when the two would sit side by side (narrow screens; it
  returns only with 1 rem of clearance to spare, so a changing speed readout does not make it jump);
- leaves the target panel centred unless that puts it under the gauge, and then moves it just below the gauge,
  letting at most 40 % of it (ETA and the hint) run off the bottom rather than hiding under the gauge;
- picks the placement with the least overlap when nothing is clear.

Checked at 1280×720 and 800×450 (text scale 1), 1366×768 and 1280×720 (1.5) and 1920×1080 (2): no overlap with the
target, speed or left panel, the footer or the warning line (`tests/e2e/fuel.spec.ts`, unit cases in
`tests/unit/fuelIntegration.test.ts`). At 1280×720 with text scale 2 (40 × 22.5 rem) the HUD's own panels already
overlap each other; the gauge stays off the target panel, which moves below it, but it covers the right end of the
speed panel.

**Saving.** The tank is saved to localStorage when a jump is paid or refunded, when scooping stops or the tank fills,
every 5 s when it changed, and on `pagehide` or when the page is hidden. The hull starts cold after a reload, because
the ship's position is not saved (the game starts in a fresh placement). `?fuel=0..1` (tests, screenshots) overrides
the tank for the session and is never written to the save; anything that is not a finite number (including an empty
value) is ignored.

## 9. Open questions

- The ship's position is not saved, so a reload returns to Earth orbit with the saved tank.
- A transit cut short by a teleport is not refunded (only an aborted spool is).
- Tuning (band edge, rate, `F_limit`, jump range) has not been playtested.
- The HUD itself has no large-text layout: at 40 × 22.5 rem (1280×720 at text scale 2) its panels overlap each other,
  and the gauge can only limit the damage. A HUD-wide layout should place the gauge then.
