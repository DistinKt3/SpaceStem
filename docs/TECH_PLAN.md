# Known Sky: Technical Plan

**Status:** v1.0 (2026-10-10). Governs the PoC build defined in PRD Section 9a.
**Owner of this doc:** lead engineer (Claude). Decisions and assumptions are logged in `docs/DECISIONS.md`; data sources and licenses in `docs/DATA_MANIFEST.md`.

---

## 1. Environment facts (measured on 2026-10-10, not assumed)

These were probed in the build container before planning. They shape several decisions below.

| Fact | Evidence | Consequence |
|---|---|---|
| No physical GPU. Chromium 141 (Playwright 1.56 build 1194) renders through **SwiftShader** (CPU) for both WebGL2 (ANGLE/Vulkan) and WebGPU (fallback adapter). | `navigator.gpu.requestAdapter()` returns `vendor: google, architecture: swiftshader, isFallbackAdapter: true`. WebGL2 has `EXT_clip_control` and float render targets. | Correctness and visuals can be verified here; **real frame rates cannot**. Performance is verified by budgets plus an owner-run benchmark (Section 9). |
| three.js **r186 (0.186.1)** WebGPU backend throws on Chromium 141: `swizzle: 'rgba'` is not a valid `GPUTextureComponentSwizzle`. three always sets the newer string form on texture views. | Stack trace in `WebGPUBackend._getRenderPassDescriptor`. A 6-line shim that strips the identity swizzle makes it render correctly (pixel readback verified). | Older Chromium-based browsers would crash *after* init, where three's built-in `getFallback` does not catch it. We add the shim plus a **probe frame** at boot that falls back to WebGL2 on any render-time error. |
| WebGPU readback needs `--enable-features=Vulkan --use-vulkan=swiftshader --disable-vulkan-surface`; without them `mapAsync` reports "device lost". Playwright page screenshots of a WebGPU canvas are black. | Probe runs with each flag set. | Browser tests capture frames **in-page** (render-target readback or `canvas.toDataURL`), not with page screenshots. Flags live in the Playwright config. |
| three r186 `WebGPURenderer` supports `reversedDepthBuffer` (WebGPU always; WebGL2 when `EXT_clip_control` exists) and `logarithmicDepthBuffer` (via a TSL depth node). | Source inspection of `three.webgpu.js`. | Reverse-Z is a cheap optimization on both backends. Log depth is not needed (it disables early-Z). |
| **Network policy blocks most science hosts.** Reachable: GitHub (git + raw), npm, PyPI. Blocked: NASA Exoplanet Archive, JPL (Horizons, NAIF), NASA SVS/Visible Earth/science.nasa.gov, USGS, ESA Gaia, CDS/SIMBAD, arXiv, NOAA. WebSearch works; WebFetch to blocked hosts fails. | `curl` returns proxy 403 on CONNECT. | JPL **DE421** is available via PyPI (`skyfield-data` wheel) and **HYG v4.1** via GitHub, so planets, Moon and stars are unblocked. Earth/Moon imagery and elevation, moon ephemerides beyond Earth's Moon, and the TRAPPIST-1 archive values **need the owner to allowlist domains** (Section 11). |
| The GitHub repo is **private**. | `list_repos` | Free GitHub Pages needs a public repo (or a paid plan). Owner decision (Section 11). |

## 2. Architecture overview

One codebase, one renderer API, two GPU backends:

- **three.js `WebGPURenderer` only**, with its built-in **WebGL2 backend** as the fallback (`forceWebGL` / auto-fallback). Every custom shader is written in **TSL** (three's node shading language), which compiles to WGSL and GLSL. We do not use the legacy `WebGLRenderer` or raw GLSL `ShaderMaterial`; that would mean writing every shader twice.
- **Plain three.js scene graph, no React** (PRD Section 11 pitfall). The scene graph is built once; per frame we only write `Object3D.position`/`quaternion` and uniforms.
- **The CPU owns truth in float64; the GPU sees only camera-relative float32.**

### 2.1 Module layout

```
src/
  core/        units.ts (branded unit types), constants.ts (cited), vec3d.ts (float64 math, allocation-free),
               frames.ts (reference-frame tree), time.ts (UTC/TT/TDB, Julian dates), rng.ts (integer hash PRNG),
               provenance.ts (Provenance, Sourced<T>, citation ids)
  render/      bootstrap.ts (backend select, compat shims, probe frame, fallback), anchors.ts (camera-relative sync),
               depth/ (partitioned.ts, reversedZ.ts, strategy.ts), post/ (HDR, bloom, tone map, lens),
               materials/ (TSL: terrain, atmosphere, star sprites, glass, sun), quality.ts (adaptive scaler),
               stats.ts (frame time, draw calls, triangles)
  world/       ephemeris.ts (Chebyshev evaluator), bodies.ts (catalog + rotation models), planet/ (cube-sphere
               quadtree LOD, chunk worker, height/colour samplers), atmosphere.ts, sol.ts, stars.ts, exo.ts
  data/        loaders (fetch same-origin static files only), formats/ (binary decoders), manifest.ts
  game/        ship/ (flight model, modes, collision), hud/, codex/, input/ (action map, remapping),
               settings/ (accessibility), onboarding/, share.ts, screenshot.ts, audio/, i18n/ (en.json, t())
  main.ts
tools/         Python 3.13 + uv offline pipeline (not shipped): ephemeris/, stars/, exo/, terrain/, check/
tests/         unit/ (Vitest), e2e/ (Playwright), data/ (pytest for the pipeline)
public/data/   committed compact assets + manifest.json
```

Dependency rule: `core` imports nothing; `render`, `data` import `core`; `world` imports `core`, `data`, `render`; `game` imports everything. Enforced with an ESLint `no-restricted-imports` rule.

### 2.2 Build tooling

| Tool | Version (pinned) | Why |
|---|---|---|
| three | `0.186.1` exact, `@types/three 0.186.0` | WebGPU/TSL APIs change between releases. Upgrades are deliberate and re-run both-backend e2e. |
| Vite | 8.x | Dev server, workers, static build for Pages. |
| TypeScript | **6.0.x**, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | TS 7 (native) is out, but typescript-eslint supports only `<6.1`. |
| ESLint 10 + typescript-eslint 8 (`strictTypeChecked`), Prettier | latest | Type-aware lint (floating promises, unsafe any). |
| Vitest | 5.x | Unit tests for math, data, determinism. |
| @playwright/test | **1.56.0** | Matches the installed Chromium 141 build; `executablePath` set; never `playwright install` locally. CI installs its own browser. |
| Python 3.13 + uv | locked | Offline pipeline: `jplephem`, `numpy`, `pillow`, `rasterio`/`tifffile`, `pytest`. |

Scripts: `npm run check` = typecheck + lint + unit tests (run before every push). `npm run e2e` = Playwright on both backends. CI runs both. Deploy workflow builds and publishes to GitHub Pages.

## 3. Coordinates, precision and floating origin

### 3.1 Frames and units

- **Axes:** ICRF / J2000 equatorial everywhere (native frame of JPL ephemerides and of HYG/Gaia Cartesian positions). Ecliptic is a display transform for maps only.
- **Units:** SI meters and seconds in all simulation code. Unit types are branded (`Meters`, `AU`, `LightYears`, `Parsecs`, `Seconds`, `JulianDateTDB`) so mixing them is a type error. Conversions go through `core/units.ts` only.
- **Frame tree:**
  - `interstellar`: origin at the Solar System Barycenter, ICRF axes. Holds star-system origins (float64 meters). At 1,000 pc the float64 step is about 4 km, which is fine for placing stars.
  - `system:<id>`: barycentric frame of one star system (Sol, TRAPPIST-1, others on demand). The ship lives here while in a system. At Neptune's distance the float64 step is about 1 mm.
  - `body:<id>`: body-centered, body-fixed rotating frame (IAU WGCCRE rotation model) for terrain, landing and near-surface flight. Step at Earth's radius is about 1 nm.
- **Handoffs** between frames are exact float64 compositions, triggered by distance (sphere of influence for body frames, a system radius for star systems). Hysteresis prevents flip-flopping.

### 3.2 Camera-relative rendering (the core trick)

1. Each frame: compute the camera's world state in its current frame (float64).
2. For each renderable, compute `rel = objectPos − cameraPos` in float64 at their **lowest common frame** (so surface objects subtract in the body frame, not via the barycenter), then rotate into ICRF axes.
3. Write `rel` (now small where precision matters) into `Object3D.position` as float32. The camera sits at the render-space origin; its view matrix is rotation-only.
4. Large meshes (terrain chunks) store vertices **relative to a per-chunk float64 anchor**, so the float32 error is relative to the chunk, not the planet.
5. Very many points (stars): positions are uploaded as **hi/lo float32 pairs** and subtracted on the GPU (relative-to-eye emulated double), giving about 1e-14 relative precision.

Float32 error after step 3 is about `|rel| × 6e-8` radians of angle, which is far below one pixel (1080p at 60° FOV is about 1e-3 rad per pixel) at every distance. This is "floating origin every frame": nothing in the scene graph is ever rebuilt or reparented to rebase.

### 3.3 Simulation precision

Ship physics integrates in float64 in its current frame (semi-implicit Euler at a fixed 120 Hz substep). Near-surface physics runs in the body frame, so landing and terrain collision have nanometer headroom.

## 4. Depth strategy

**Baseline (always available, both backends): depth partitioning.**
- Each frame, renderables are bucketed by their camera-space depth interval `[d − r, d + r]` (bounding sphere). Overlapping intervals merge into **partitions**. A partition whose far/near ratio exceeds 1e4 is split geometrically (objects spanning a seam are drawn in both, clipped by each partition's near/far planes).
- Partitions render far to near; depth is cleared between them; color accumulates. This generalizes the classic per-body depth range (Celestia) and the PRD's 2 to 3 near/mid/far layers. Usually only 2 to 4 partitions are non-empty.
- With a 24-bit depth buffer and ratio ≤ 1e4, worst-case depth resolution is about 6e-4 of distance at a partition's far end.
- The **cockpit** is always its own final partition and its own scene (near 0.01 m), which also lets it have its own lighting and FOV handling.

**Optimization (default where supported, pending M0 validation): reversed-Z with a float32 depth buffer.**
- Depth resolution is about 2^-23 ≈ 1.2e-7 of distance at **every** distance (0.12 µm at 1 m; 120 km at 1e12 m, where a planet is sub-pixel anyway). The world collapses to a single partition plus the cockpit, saving draws.
- Available on WebGPU always and on WebGL2 when `EXT_clip_control` exists (present in this Chromium). Otherwise the baseline runs alone.

**Not used:** logarithmic depth (fragment depth writes disable early-Z and cost fill rate on integrated GPUs). Kept only as a documented last resort.

**M0 validation is automated** (Section 9): near-coplanar plate pairs at every decade from 1 m to 1e12 m must render without z-fighting in all four combinations (2 backends × 2 strategies), and a deliberately naive mode must show the failure, proving the test can detect it.

## 5. Planets: LOD, terrain, atmosphere

- **Cube-sphere quadtree** (spherified cube, 6 faces). Chunk = 33×33 vertices plus skirts (to hide cracks). Split/merge by screen-space error with hysteresis. Earth reaches about 0.3 m vertex spacing at level 20.
- **Chunk geometry is built in a Web Worker on the CPU**, not in a compute shader: works identically on WebGL2, and the CPU needs the same heights for collision and altitude anyway. Heights = data tiles (bilinear/bicubic) + deterministic procedural detail below data resolution (integer-hash fBm). Detail below data resolution is **Generated** and labeled so in the "How do we know?" panel.
- Draw-call control: frustum + horizon culling; chunk size tuned in M1 (32 vs 64 quads) against the draw-call budget.
- Imagery is sampled per chunk in the fragment shader from cube-face tile pyramids; the lowest levels (0 to 2) for every body are bundled in the initial load so **nothing ever waits on a loading screen**; higher levels stream in and cross-fade.
- **Atmosphere:** physically based single scattering (Rayleigh + Mie + ozone absorption for Earth, published parameters) ray-marched in a TSL shader on the atmosphere shell, plus a transmittance LUT, with the same functions applied to terrain as aerial perspective. One code path from the surface to deep space is what makes the surface-to-orbit transition seamless. Mars and Titan get their own parameters; gas giants are shaded spheres with limb darkening.
- **Sun:** HDR emissive disc with limb darkening, bloom and lens glare; it is also the single directional light for the system (plus earthshine as a cheap ambient term near Earth).

## 6. Stars, hyperspeed and the sky

- **Star set (M3):** HYG v4.1 (CC BY-SA 4.0; Hipparcos + Yale + Gliese), filtered to stars with valid distances within 1,000 pc (≈3,260 ly), about 100k stars. One binary file (struct of arrays: hi/lo positions, absolute magnitude, color index, ids) plus a names JSON. The file header is octree-ready (bounds, level), but at this size **one tile is enough**; an octree is deferred until a Gaia subset needs it (avoids gold-plating).
- **Rendering:** instanced point sprites; apparent magnitude computed per frame on the GPU from absolute magnitude and **current** camera distance, so stars brighten as you approach them; color from B−V via a blackbody approximation; a point-spread sprite whose size and glow follow flux, feeding bloom. The star you are inside the system of is hidden from the sprite set and rendered as a real body.
- **Milky Way background:** an all-sky image if an allowed-licensed one is reachable (ESA Gaia sky map, CC BY-SA 3.0 IGO), otherwise a procedural band labeled Generated.
- **Hyperspeed (fiction, labeled):** target a star, spool, accelerate to a tuned multiple of c (trip of about 20 to 40 s regardless of distance), streaks along velocity (a calmer variant under reduced motion), drop out at the system edge. The HUD always shows real distance (ly) and real light-travel time.
- **Map view:** 3D local-star map with labels, selection and route line; orbit map for the current system.

## 7. Data pipeline and formats

**Principle:** fetch once, process offline in `tools/`, commit compact outputs to `public/data/`, never call external APIs at runtime. Each script writes the raw-input URL, retrieval date, version and SHA-256 into `public/data/manifest.json`; `docs/DATA_MANIFEST.md` is the human-readable record.

| Dataset | Source (status) | Output format | Size target |
|---|---|---|---|
| Sun, planets, Pluto, Moon positions | JPL **DE421** via PyPI `skyfield-data` (reachable). Horizons (DE441) if allowlisted. | Chebyshev segments per body, Float64, little-endian binary + JSON header. Window 2020–2040 (resized in M1 by measured size). Runtime evaluator in TS. | ≤ 2 MB |
| Major moons (Phobos, Deimos, Galileans, Titan, Enceladus, Triton, Charon) | JPL Horizons vectors (**needs allowlist**). Fallback: published analytic theories / mean elements, flagged lower precision. | Same Chebyshev format. | ≤ 1 MB |
| Rotation models, radii, GM | IAU WGCCRE 2015 report (Archinal et al. 2018); IAU 2012 au; DE GM values. | `bodies.json` with per-field provenance and citation keys. | small |
| Moon imagery + elevation | NASA SVS CGI Moon Kit (LROC WAC color, LOLA DEM) (**needs allowlist**). | Cube-face tile pyramid: color 256² WebP; height 16-bit PNG. | ≤ 25 MB committed |
| Earth imagery + elevation | NASA Blue Marble NG + NOAA ETOPO 2022 (**needs allowlist**). | Same. | ≤ 25 MB committed |
| Other planet/moon maps | USGS / NASA global mosaics (**needs allowlist**); fallback procedural, labeled Generated. | Single equirect or level 0–2 tiles. | ≤ 10 MB |
| Stars | **HYG v4.1** from GitHub (reachable). | Binary SoA + names JSON. | ≤ 5 MB |
| TRAPPIST-1 system | NASA Exoplanet Archive TAP `ps`/`pscomppars` (**needs allowlist**). | `trappist1.json`: every field `{value, uncertainty, provenance, source, citation}`. | small |
| Citations | Hand-curated from NASA/ESA/peer-reviewed sources, each verified at write time. | `citations.json` (authors, year, title, venue, DOI/URL, accessed). | small |

**Repo size rule:** committed data ≤ 60 MB for the PoC. Anything larger is published as a versioned **GitHub Release asset** that the deploy workflow downloads; the script that produces it is committed. No Git LFS (its free bandwidth quota would be burned by CI).

## 8. Game systems (brief)

- **Provenance from day one:** `type Provenance = 'measured' | 'inferred' | 'generated'`. Every world object has object-level `provenance`, `source`, `citation`, and its displayed fields are `Sourced<T>` with their own provenance and optional uncertainty. Constructors require these fields (type-enforced); a test walks the live scene and fails on any object or field without a resolvable citation.
- **Flight:** Newtonian 6-DOF with flight assist. Modes: thrusters (real gravity on, collision), impulse and cruise (a speed governor scales max speed with distance to the nearest body, so scale stays traversable and you cannot tunnel into planets), hyperspeed (fictional, Section 6).
- **HUD:** text, numbers and panels in **DOM** (crisp at any scale, screen-reader-friendly, text-scalable, translatable), styled as glass projection; targeting brackets, velocity vector and horizon line are **in-scene** diegetic elements. Units auto-scale (m, km, AU, ly) with light-travel time.
- **Cockpit:** modeled procedurally in code (canopy struts, consoles, holo panels), canopy glass with Fresnel reflection, subtle smudge/scratch texture that catches the Sun, interior emissive lighting, head look. No external models.
- **Input:** action map (actions → bindings) over keyboard, mouse and gamepad from M2; remapping UI in M7.
- **Settings and accessibility:** reduced motion (also honors `prefers-reduced-motion`), colorblind UI palettes with badges that never rely on color (solid/dashed/dotted borders + icon + text), text scaling 80–200% via root rem, subtitles/captions for every voiced or audio cue, full remapping. All UI strings through `t('key', params)` from `en.json` with `Intl` number formatting; no sentence concatenation.
- **Audio:** WebAudio, synthesized in code (cockpit hum, instrument tones, a simple generative score loop). Exterior space is silent per PRD Q9.
- **Share link:** URL hash encodes frame id, float64 position, orientation and sim time; opening it reproduces the view. **Screenshot mode:** HUD off, free camera, supersampled capture with optional provenance caption.
- **Sim time:** real current UTC, clamped to the ephemeris window, so the sky you see matches the real sky now.
- **Determinism:** gameplay-relevant generation (seeds, terrain heights used for collision, generated parameters) uses CPU integer hashing (`Math.imul`-based), bit-exact across machines. GPU noise is visual-only. `Math.random` is banned in `world/` and `core/` by lint rule.

## 9. Verification and performance

- **Unit (Vitest):** unit conversions and constants; frame round-trips; camera-relative error bounds at 1e12 m and 1e17 m; UTC→TT→TDB and Julian dates; ephemeris evaluation against held-out source samples (planets < 1 km, Moon < 100 m vs DE421); RNG and terrain golden values; magnitude/flux math (e.g. Sirius from Earth ≈ −1.46); share-link round-trip; i18n key coverage.
- **Browser (Playwright, both backends, SwiftShader):** boots without console errors; reports backend; z-fighting and jitter pixel tests (Section 4); scripted flight routes with in-page frame captures saved to `test-results/` for my visual review; provenance walk test.
- **Data (pytest):** pipeline outputs vs sources (e.g. Earth–Moon distance at a set epoch matches DE421).
- **Performance budgets** (target: integrated laptop GPU, 1080p, 60 fps): draw calls ≤ 300 on WebGL2 and ≤ 600 on WebGPU; ≤ 1.5M triangles; ≤ 600 MB GPU texture memory; main-thread JS ≤ 4 ms per frame; ≤ 10 MB downloaded before the first frame. Budgets are asserted in e2e from `renderer.info` and `performance` marks.
- **Adaptive quality (designed in M1, tuned in M7):** a controller on rolling p90 frame time adjusts render scale (0.5–1.0 with FSR1 upscaling, shipped as a three r186 TSL addon), terrain error threshold, atmosphere sample count, bloom resolution and star magnitude cutoff, with hysteresis.
- **Owner benchmark:** `?bench=1` flies a fixed route and prints a JSON report (frame-time percentiles, draw calls, backend, adapter). Running it on your laptop takes about 2 minutes per milestone and is the only way to verify the 60 fps target.

## 10. Milestones and tasks

Each milestone ends with: `npm run check` and e2e green, screenshots reviewed, a deployed build, `docs/DEMO_Mx.md`, commit and push, and a short status to the owner.

### M0 Spike (time box: 1–2 sessions)
1. Scaffold: Vite + TS strict, ESLint, Prettier, Vitest, Playwright (pinned, flags), three 0.186.1; CI workflow; Pages workflow (activates once hosting is decided).
2. `core`: units, constants (cited), Vec3d, minimal frames.
3. `render/bootstrap`: backend selection (`?backend=webgpu|webgl2`), swizzle shim, probe-frame fallback to WebGL2, adapter info overlay.
4. Depth strategies: partitioned (baseline) and reversed-Z (optimization), switchable at runtime (`?depth=`), plus naive mode for the control test.
5. Test scene spanning 1 m to 1e12 m: cockpit-scale panel at 0.3 m, 1 m cube, 100 m structure, Earth-radius LOD sphere (walk from 1 m altitude to 1e9 m), Jupiter-radius sphere at 1e11–1e12 m, near-coplanar plate pairs at every decade. Fly camera with logarithmic speed.
6. LOD sphere: cube-sphere quadtree, worker-built chunks, deterministic procedural heights, skirts.
7. Automated z-fight and jitter tests on 2 backends × 2 strategies, plus naive control.
8. Measure CPU frame time, draw calls, triangles; record the SwiftShader caveat.
9. `docs/SPIKE_M0.md`: what worked, what did not, version constraints, recommendation.
**Exit:** tests pass on both backends with the baseline. If not, walk the PRD fallback ladder (staged transition) before any engine change, which needs owner approval.

### M1 Sol
1. Pipeline: DE421 → Chebyshev binary; moons via Horizons (or flagged fallback); `bodies.json` with WGCCRE rotation models and citations.
2. Runtime ephemeris + body rotation; sim clock on real UTC.
3. Earth and Moon tile pyramids (imagery + elevation) wired into the LOD sphere; other bodies at lower resolution.
4. Atmosphere scattering (Earth, Mars, Titan) with aerial perspective; ocean specular; Sun with glare and bloom.
5. Start in Earth orbit; free camera to Earth's surface, then to the Moon's surface. Deploy.
**Verify:** ephemeris tests vs held-out samples; subsolar point and terminator match the computed Sun direction for the capture time; screenshot series orbit→surface for Earth and Moon on both backends; precision tests stay green.

### M2 Cockpit and flight
1. Procedural cockpit, canopy glass, interior lighting, head look.
2. Flight model and modes (thrusters, impulse, cruise) with speed governor, gravity and terrain collision.
3. Input action map (keyboard, mouse, gamepad).
4. HUD: speed (m/s → c), target distance (m → AU), light-travel time, mode, target selector.
5. Settings framework with reduced motion; cockpit audio.
6. Post stack: HDR, bloom, tone mapping, lens effects.
**Verify:** scripted Earth-orbit-to-Moon-landing route; HUD distances match ephemeris within rounding; screenshots of cockpit in sunlight, shadow and at the surface.

### M3 Known stars
1. Pipeline: HYG v4.1 → star binary + names.
2. Star renderer (hi/lo positions, live magnitude, PSF, color); Milky Way background.
3. Interstellar frame and system handoff; distant star becomes a real body on approach (radius Measured where catalogued, else Inferred from luminosity and temperature).
4. Hyperspeed jump with HUD ly and light-travel time; reduced-motion variant.
5. Map view.
**Verify:** Orion and the Big Dipper recognizable from Earth; Sirius and Alpha Centauri magnitudes and distances in tests; Sol→Alpha Centauri jump route.

### M4 One real exoplanet system: TRAPPIST-1
1. Pipeline: Exoplanet Archive values (the archive's default parameter set per planet, cross-checked against the primary paper it cites), live confirmed-planet count recorded with date.
2. Inferred properties with stated assumptions: equilibrium temperature, bulk density class, likely tidal locking, JWST constraints for b and c.
3. Generated surfaces driven by the inferred class (deterministic seed per planet); no atmosphere drawn unless the evidence supports one.
4. M8V host star rendering; orbits from measured periods and transit epochs.
5. First version of the provenance panel for the system.
**Verify:** values in tests match the archive CSV; every field carries provenance; screenshots.

### M5 Codex and provenance
1. Badge component (shape + icon + text; color-independent).
2. "How do we know this?" panel: method, dataset and version, citation link, uncertainty, last updated.
3. Codex with discovery log and about 25 conservative entries (Sun, planets visited, Moon, notable stars, TRAPPIST-1 system, parallax, "the drive is fiction").
4. Automated checks: every rendered object has provenance; every citation resolves; type rules prevent Generated data labeled Measured.
**Verify:** provenance walk test; citations spot-checked against sources; screenshots.

### M6 Fuel loop and onboarding
1. Fuel: scoop hydrogen in a star's corona band (heat risk), hyperspeed consumes fuel per ly, HUD gauges.
2. Onboarding: Earth-orbit opening, guided launch, Moon, onward; one-line optional goal; all prompts as captioned text.
3. Share link (encode/decode, open and fly there); screenshot mode.
**Verify:** link round-trip in a fresh page reproduces the camera within tolerance; scripted onboarding playthrough; screenshots.

### M7 Polish and release
1. Adaptive quality tuned; `?bench=1`; fix profiling hotspots.
2. Colorblind modes, text scaling, remapping UI (all devices), subtitles audit, reduced-motion audit; axe-core on DOM UI.
3. Score loop; settings persistence; error states (no WebGPU, no WebGL2).
4. Visual polish pass against a screenshot checklist.
5. Public deploy; README with credits; `LICENSE` (MIT, code) and `ASSETS_LICENSE` (assets); data credited per source license.
**Verify:** full route on both backends; accessibility checks; owner benchmark JSON from a mid-range laptop.

### Stretch (only after M7 is verified)
Rover on the Moon; one curated anomaly (a pulsar); generated Milky Way fill beyond the real star set.

## 11. Owner actions needed (environment and account, not design)

1. **Network allowlist** (needed before M1 data work and for M4). In the environment's settings, add these under Allowed domains (keep package managers allowed), or switch network access to Full:
   `exoplanetarchive.ipac.caltech.edu`, `ssd.jpl.nasa.gov`, `ssd-api.jpl.nasa.gov`, `svs.gsfc.nasa.gov`, `eoimages.gsfc.nasa.gov`, `visibleearth.nasa.gov`, `assets.science.nasa.gov`, `science.nasa.gov`, `www.ncei.noaa.gov`, `planetarymaps.usgs.gov`, `astrogeology.usgs.gov`, `www.cosmos.esa.int`, `arxiv.org`, `ui.adsabs.harvard.edu`, `doi.org`.
   Steps: https://code.claude.com/docs/en/cloud-environments#network-access
2. **Hosting:** make the repo public (consistent with the MIT open-source decision) and set Settings → Pages → Source to "GitHub Actions". Needed for the first deploy at the end of M0/M1.
3. **Benchmark:** run `?bench=1` on your laptop at each milestone and paste the JSON.

## 12. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| **1** | **Primary data sources unreachable** from this environment (Section 1). | Certain today / High: blocks Earth and Moon imagery and elevation (M1), outer moon ephemerides (M1), TRAPPIST-1 values (M4), live verification of citations. | Owner allowlist (Section 11). Unblocked now: DE421, HYG. Until then, I build M0 and the M1 engine work; fallbacks are procedural textures labeled Generated, never invented data presented as measured. |
| **2** | **Real-hardware performance is unverifiable here** (SwiftShader CPU rendering). The 60 fps target could be missed without my knowing. | Certain / High. | Hard budgets asserted in tests; adaptive quality designed in from M1; worker-built geometry; owner `?bench=1` per milestone. |
| **3** | **three.js WebGPU path fragility**: render-time incompatibilities (already observed), API churn, less-documented depth paths; seamless surface-to-space could jitter or z-fight. | Medium / High. | Exact version pin; compat shim + probe-frame fallback; both backends in CI; depth partitioning as the baseline; automated precision tests; PRD fallback ladder (staged transition) before any engine change. |
| 4 | "Stunning" visuals with only procedural and public-domain art, no artist. | Medium / High | Spend effort where it pays: atmosphere, Sun glare, star PSF, glass, tone mapping; screenshot review checklist each milestone. |
| 5 | Scientific error without a human reviewer. | Medium / High | Conservative text, every claim cited and verified at write time, uncertainty shown, type-enforced provenance. |
| 6 | Hosting blocked (private repo). | Certain until decided / Medium | Owner action 2; fallback is local builds only. |
| 7 | Repo bloat from tiles. | Medium / Medium | 60 MB committed cap; Release assets beyond that; scripts committed. |
| 8 | Scope and time. | Medium / Medium | Strict 9a scope; if a milestone slips I propose a cut (first candidates: other-planet imagery resolution, map-view polish, Milky Way image). |
