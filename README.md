# Known Sky

A browser space-exploration game built on real astronomical data. The universe is real; the drive is fiction.

Fly from low Earth orbit to the Moon, across the Solar System and to nearby stars. Planets and moons sit at their true positions for the current date (JPL Horizons). Surfaces use spacecraft imagery and elevation data. More than 100,000 catalogued stars sit at their measured distances. Wherever the game fills a gap with inferred or generated content, it says so.

**Play:** https://distinkt3.github.io/SpaceStem/ (Chrome or Edge recommended).

**Status:** proof of concept, in development. Milestones and demo notes are in `docs/`.

## Run it

Requirements: Node.js 22 or newer and a browser with WebGPU (Chrome or Edge 121+). Other browsers fall back to WebGL2.

```bash
npm install
npm run dev        # http://localhost:5173
```

Useful URL parameters: `?view=moon-surface` (also `leo`, `earth-sunset`, `earthrise`, `mars`, `jupiter`, `saturn`, `sun`, `body:<NAIF id>`), `?free=1` (free camera), `?backend=webgl2`, `?t=2026-12-25T00:00:00Z`.

## Controls

Every control can be rebound in Settings (Esc), for keyboard and mouse and for gamepads (standard mapping). Defaults:

| Action | Keyboard and mouse |
|---|---|
| Throttle up / down | W / S; steps with = / − or the mouse wheel; Backspace cuts it |
| Pitch, yaw | Arrow keys and A / D, or move the mouse (click the view to capture it; Esc releases) |
| Roll | Q / E |
| Strafe | Z / X (left, right), F / R (down, up) |
| Boost | Shift |
| Drive mode: next / previous (thrusters, impulse, cruise) | Space / B |
| Flight assist on or off | G |
| Target: next / previous / under the reticle | Tab / Y / T (or middle mouse) |
| Align nose to target | N |
| Hyperspeed to the targeted star | J |
| Map (system and local stars) | M |
| Head look | Hold the right mouse button or Alt |
| Cockpit on or off / HUD on or off | V / H |
| Settings and pause (controls, accessibility, audio, graphics) | Esc |

Accessibility: colourblind palettes (deuteranopia, protanopia, tritanopia, high contrast), text size, subtitles for every sound, full rebinding and reduced motion (also follows the system setting).

## Develop

```bash
npm run check      # typecheck + lint + unit tests
npm run e2e        # browser tests (Playwright, Chromium)
npm run build
```

The offline data pipeline (Python, `tools/pipeline/`) downloads the source data once and bakes the compact files in `public/data/`. The game never calls external data services at runtime.

Docs: `docs/PRD.md` (product), `docs/TECH_PLAN.md` (architecture), `docs/DECISIONS.md` (engineering decisions), `docs/DATA_MANIFEST.md` (every dataset, its license and credit).

## Credits and licenses

Code: MIT (`LICENSE`). Data and imagery keep their own licenses; see `ASSETS_LICENSE.md`. Principal sources:

- Ephemerides: NASA/JPL Horizons (Giorgini et al.). Body orientation and radii: IAU WGCCRE 2015 via NASA NAIF.
- Stars: HYG Database v4.1 by David Nash (astronexus), CC BY-SA 4.0. Milky Way: ESA/Gaia/DPAC, CC BY-SA 3.0 IGO, acknowledgement A. Moitinho.
- Earth: NASA Earth Observatory (Blue Marble Next Generation, Black Marble), NOAA ETOPO 2022.
- Moon: NASA Scientific Visualization Studio CGI Moon Kit (LRO LROC and LOLA).
- Planets: Solar System Scope (INOVE s.r.o.), CC BY 4.0.
- Moons and dwarf planets: USGS Astrogeology Science Center mosaics from NASA's Galileo, Voyager, Cassini, Viking and New Horizons missions.

No agency endorses this project.
