# M2 demo: cockpit and flight

**Goal (PRD 9a):** a sleek sci-fi cockpit, thrusters, impulse and cruise, a HUD with real distance and light-travel time, and a reduced-motion option.

**Run:** `npm run dev`, open `http://localhost:5173/`. You start in low Earth orbit with the Moon targeted. Click the view to capture the mouse. Esc opens settings. Controls: `README.md`.

## What works (each checked in Chromium)

- **Flight model** (`src/game/ship/ship.ts`): Newtonian thrusters with flight assist relative to the rotating surface, gravity compensation and a landing lock; impulse up to 0.05c and cruise from 2 km/s to 3,000c. Both are governed by distance to the nearest surface and drop out near it (D-023).
- **HUD** (`src/game/hud/`): drive mode, speed (surface-relative in thrusters), throttle, altitude, vertical speed, target with **real distance and light-travel time** and its provenance badge, time to arrive, velocity vector, target bracket or off-screen arrow, body labels, and warnings (pull up, dropped out of cruise). The text is DOM, so it scales with the text-size setting and works with screen readers (D-012, D-024).
- **Cockpit** (`src/render/cockpit/`, procedural): canopy frame clear of the central 40°, dashboard, side stick and throttle, five live displays (throttle, speed, drive modes, attitude ring with Sun and planet, status), canopy glass with smudges and Sun-lit micro-scratches, interior lit by the real Sun direction (with eclipse when a body blocks it) and by planet fill light. 14 draw calls, 43k triangles. V hides it.
- **Audio** (`src/game/audio/`, synthesised): honest silence in vacuum; cabin hum and instruments; engine felt as hull vibration; wind only in an atmosphere (scales with density × airspeed); a seeded generative score. Every sound has a caption.
- **Input and accessibility** (`src/game/input/`, `src/game/settings/`, `src/game/ui/`): 28 rebindable actions with two slots each for keyboard and mouse and for gamepad, conflict warnings, colourblind palettes checked for contrast and CIEDE2000 separation, text scale 80–200%, caption size, reduced motion (also follows the OS), FOV, volumes.
- **Reduced motion:** hyperspeed streaks drop to 15%, cockpit animations freeze, and there is no camera shake.

## Captures

| | |
|---|---|
| ![Cockpit in low Earth orbit](media/m2_cockpit_leo.jpg) | ![Cockpit over the Moon](media/m2_cockpit_moon.jpg) |
| Low Earth orbit: HUD shows the Moon at 384,400 km, 1.29 light-seconds | Lunar orbit at 120 km |
| ![Settings](media/m2_settings.jpg) | ![Cockpit at sunset](media/m2_cockpit_sunset.jpg) |
| Settings: rebinding | Atmospheric flight at dusk |

## Tests

`tests/unit/cockpit.test.ts` (budget, sightlines, light model), `tests/unit/audio.test.ts`, `tests/unit/input.test.ts`, `tests/unit/settings.test.ts` (persistence, palettes, contrast), `tests/e2e/cockpit.spec.ts`, `tests/e2e/audio.spec.ts`, `tests/e2e/ui.spec.ts`, `tests/e2e/app.spec.ts`.

## Known limits

- Sound quality is verified by measurement only (levels, spectra, clicks); nobody has listened yet.
- Real-GPU frame time is not measured yet (SwiftShader only); adaptive quality is M7.
- The flight-assist feel at the thrusters' 3 km/s cap needs playtesting.
- No external chase view (D-025).
