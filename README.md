# Known Sky

A browser space-exploration game built on real astronomical data. The universe is real; the drive is fiction.

Fly from low Earth orbit to the Moon, across the Solar System and to nearby stars. Planets and moons sit at their true positions for the current date (JPL Horizons). Surfaces use spacecraft imagery and elevation data. More than 100,000 catalogued stars sit at their measured distances. Wherever the game fills a gap with inferred or generated content, it says so.

**Status:** proof of concept, in development. Milestones and demo notes are in `docs/`.

## Run it

Requirements: Node.js 22 or newer and a browser with WebGPU (Chrome or Edge 121+). Other browsers fall back to WebGL2.

```bash
npm install
npm run dev        # http://localhost:5173
```

Useful URL parameters: `?view=moon-surface` (also `leo`, `earth-sunset`, `earthrise`, `mars`, `jupiter`, `saturn`, `sun`, `body:<NAIF id>`), `?free=1` (free camera), `?backend=webgl2`, `?t=2026-12-25T00:00:00Z`.

## Controls (keyboard and mouse)

| Action | Keys |
|---|---|
| Throttle up / down | W / S (X zeroes it) |
| Yaw, pitch | A / D, arrow keys, or drag with the mouse |
| Roll | Q / E |
| Strafe | Z / C (sideways), R / F (up and down) |
| Boost | Left Shift |
| Next / previous drive mode (thrusters, impulse, cruise) | Space / B |
| Flight assist on or off | G |
| Target: cycle / nearest to reticle | Tab / T |
| Auto-align to target | Y |
| Hyperspeed to the targeted star | J |
| Map (system and local stars) | M (Esc closes) |

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
