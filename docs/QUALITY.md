# Adaptive quality and the benchmark

**Status:** module `quality` (M7, PRD Section 9a "Quality scaling for mid-range laptops"; TECH_PLAN Section 9 "Adaptive quality" and "Owner benchmark").
**Code:** `src/render/quality/quality.ts` (levels, controller), `src/render/quality/applyQuality.ts` (pushing a level to the renderer), `src/game/bench/` (benchmark runner, results panel, the game's driver). **Tests:** `tests/unit/quality.test.ts`, `tests/e2e/bench.spec.ts`. **Demo:** `bench.html`.

Nothing here changes what the player is told about the universe. Lower levels draw the same real data with fewer pixels, coarser terrain and fewer faint (real, catalogued) stars; no level invents content.

---

## 1. Quality levels

| | low | medium | high | ultra |
|---|---|---|---|---|
| `renderScale` (of the capped canvas size; upscaled bilinearly) | 0.67 | 0.85 | 1 | 1 |
| `maxPixelRatio` (cap on `devicePixelRatio`) | 1 | 1 | 1.5 | 2 |
| `msaa` on the HDR scene buffer | 0 | 0 | 4 | 4 |
| `bloom` | off | on | on | on |
| `terrainErrorPx` (PlanetTerrain screen-space error) | 6 | 3 | 2 | 1.5 |
| `cockpit` geometry and glass texture | low | high | high | high |
| `starMagLimit` (faintest apparent magnitude drawn) | 6.5 | 7.0 | 7.5 | 8.0 |
| `viewSamples` (atmosphere ray-march samples, sky shell) | 6 | 8 | 12 | 16 |

- **`high` is the renderer as it was before this module** (MSAA 4, terrain error 2 px, star limit 7.5, 12 sky samples), except that HiDPI rendering is capped at 1.5x. `ultra` restores the full 2x cap and refines terrain and stars a little; only `auto` reaches it (the settings presets are `auto | low | medium | high`).
- **Resolution is the big lever.** At DPR 1 the scene buffer of `low` has 45% of the pixels of `high`, and `medium` 72%. Capping the pixel ratio also shrinks the canvas, the post pass and bloom (BloomNode sizes itself from the drawing buffer), not just the scene buffer.
- **MSAA off below `high`**: 4x MSAA on a half-float target costs fill and resolve bandwidth that integrated GPUs lack; the bilinear upscale of a reduced scene buffer softens edges anyway.
- **Stars**: sprites fainter than the limit become zero-area quads in the vertex shader (`Starfield`), so the limit cuts fragment work, not vertex work. 6.5 is roughly the naked-eye limit under a dark sky. Seen from the Sun, the shipped catalogue (`public/data/stars.bin`, 109,400 stars) has 8,665 stars brighter than 6.5, 15,101 brighter than 7.0, 24,836 brighter than 7.5 and 39,694 brighter than 8.0 (counted from the file), so `low` draws about a third of the sprites of `high`.
- **`viewSamples`** is a compile-time loop count in the sky and surface materials (`planetShading.ts`), so it can only take effect when materials are built (boot). `QualityTarget.setViewSamples` is optional for that reason.
- **Cost model** (`relativeCost`, `COST_MODEL`): pixel count x 1.3 for MSAA 4 x 1.1 for bloom x 1.2% per atmosphere sample relative to 12. These are assumptions, used only to *estimate* (the benchmark's suggested preset), never for control decisions.

## 2. The controller

`QualityController` is pure logic with an injectable clock. The game feeds it one sample per rendered frame and applies the level it returns.

### What it measures

The sample is the **interval between consecutive animation frames**: what the player sees. It includes CPU, GPU and display pacing, and needs no GPU timers (timestamp queries need a renderer flag and are often unavailable; WebGL2 disjoint timers are disabled in Chrome).

The catch is **vsync**: on a 60 Hz display a machine with headroom still reports 16.7 ms, and a frame that just misses a refresh reports 33.3 ms. The thresholds and the upgrade strategy are built around this:

| Threshold | Value (60 Hz target) | Why |
|---|---|---|
| over budget | bucket p90 > 1.2 x target (20 ms) | absorbs refresh jitter around 16.7 ms; a missed refresh (33.3 ms) is clearly over |
| within budget | bucket p90 <= 1.1 x target (18.4 ms) | "meeting the budget"; headroom itself is invisible under vsync |
| severe | bucket p90 > 2.5 x target (41.7 ms, under 24 fps) | not 2x: 33.3 ms is one missed refresh, and a 2x threshold would be decided by jitter |

### Robust statistics

Samples are grouped into **0.5 s buckets** and each bucket yields its **p90**: up to 10% of slow frames (a chunk upload, a GC pause) do not move it. Decisions need **consecutive** buckets, so a burst affects at most two buckets and never triggers a change on its own. A rolling p50/p90 over the last 2 s is available from `stats()` for overlays and logs.

### Hysteresis: degrade fast, upgrade slowly

- **Degrade** after 4 consecutive over-budget buckets (**2 s**); by two levels at once when all of them are severe.
- **Upgrade** after 16 consecutive within-budget buckets (**8 s**), times `2^backoff` of the level above. Because headroom is invisible under vsync, every upgrade is a **probe**: for 10 s (probation) it is undone after only 2 over-budget buckets (1 s), and counts as a failed probe.
- **Settle**: after any change the next 1 s (and at least 5 frames) is ignored: resizes, MSAA and pipeline recompiles and cockpit rebuilds cost a one-off hitch that is not the new level's steady cost. At boot the grace period is 2 s, counted from the first sample.

### Never oscillating

Three mechanisms, all exercised by the unit tests:

1. **Backoff.** Every degrade from a level adds one to its backoff (up to 4: 8 s, 16 s, 32 s, 64 s, 128 s of quiet before probing it again). Surviving a probe does not reset it; only *holding* a level earns it back, one step per 60 s. A level that keeps being abandoned is probed ever more rarely.
2. **Locks.** Two failed probes into a level lock it out for 2 minutes, doubling with each lock up to 30 minutes. After a lock expires, one more failure locks it again.
3. **Ineffective degrades are undone.** A degrade starts an *episode*; after 2 s at the new level the episode's p90 must have improved by 8%. If it has not, and there is no lower level to try, frames are not limited by what quality controls (CPU-bound, or the display refreshes at 50 Hz): the episode is undone, restoring the starting level and its backoff, and a **floor** stops further degrades there. The floor is released if the p90 later stays 25% above the value recorded when it was set (a new kind of load). A single step that changes nothing (ultra to high at DPR 1 under vsync) does not end the episode early; the controller keeps stepping down while still over budget and only judges at the floor.

`sceneChanged()` forgets backoffs, locks and floors (and resets evidence). The game calls it when the load changes in a way vsync-capped frame times cannot reveal: a teleport (named view, share link), a hyperspeed arrival, the camera's dominant body changing.

### Hitches, pauses, first frames

| Event | Rule |
|---|---|
| single frame > 250 ms | ignored as a hitch (compile, upload, GC) |
| 3 or more such frames in a row | counted: that is the frame rate, not a hitch |
| frame > 1 s, or a clock gap > 1 s between samples | a pause (tab switch, hidden window, a menu that stopped sampling): evidence is discarded and the controller settles again; a probe's probation restarts |
| boot | first 2 s (and 5 frames) after the first sample ignored |
| non-finite or non-positive sample | ignored |

### Presets and the minimum level

- `auto` starts at `high` (`startLevel`) and adapts between `minLevel` (default `low`) and `maxLevel` (default `ultra`).
- `low | medium | high` pin the level; `sample()` then only feeds `stats()` and always returns `null`. Switching back to `auto` adapts from the current level with a clean memory.
- `setPreset()` does not return the level: the caller re-applies `level`.

### Behaviour on synthetic traces (from `tests/unit/quality.test.ts`)

Traces use GPU-bound loads scaled by `relativeCost`, quantised to a 60 Hz display with jitter.

| Trace | Result |
|---|---|
| steady fast (5 ms) | one probe to `ultra` after ~10 s (2 s boot grace + 8 s), then no change in 10 min |
| steady slow (50 ms at high) | severe drop to `low` within 4.5 s; two failed probes to `medium` (21 s, 57 s), then probes 2, 4, 8... min apart |
| moderately slow (30 ms) | one step to `medium`, stays there over 90% of the time |
| hitches every 2 s, 600 ms pairs, 5% slow frames | no degrade |
| tab switch / clock gap | no change; a later degrade needs fresh evidence after the pause |
| load alternating every 4, 10 or 20 s | 90%+ of the time at the level that holds the heavy phase; probes after the first 90 s are at least 2 min apart |
| 2 min heavy / 2 min light cycles | each phase ends at a suitable level with at most two changes in between |
| CPU-bound (25 ms at every level) | medium, low, then undone back to `high` (3 changes), then stable |
| 50 Hz display | same as CPU-bound: undone, stays at `high` |
| load drops after 30 s | back to `high` 27 s after the drop (test bound: 40 s), then `ultra` |
| random piecewise loads, 25 seeds | no change decided within settle + one bucket of the previous one; under 40 changes in 10 min |

## 3. Applying a level

`applyQuality(target, level, previous?)` pushes a level to a `QualityTarget`; with `previous` only changed knobs are applied (MSAA and cockpit changes rebuild GPU resources). Render scale and pixel-ratio cap are applied together and first.

Verified in the running game (SwiftShader, both WebGPU and WebGL2, with a temporary probe that applied the operations from outside the classes): setting `RenderTarget.samples` at runtime re-creates the scene buffer's attachments (three r186 `Textures.updateRenderTarget` compares sample counts); swapping `RenderPipeline.outputNode` between the bloom and no-bloom graphs (with `needsUpdate = true`) removes bloom's passes; resizing the scene buffer and capping the pixel ratio work; rebuilding the cockpit at `low` drops it from 43,108 to 16,636 triangles. No errors on either backend. The first frame after an MSAA or bloom change recompiles pipelines (hundreds of ms to seconds under SwiftShader, unknown on real GPUs), which the controller's settle period ignores. Exact integration code is in the module's report (sharedFileRequests); in short: `FrameRenderer.setRenderScale(scale, maxPixelRatio)`, `setMsaa`, `setBloom` (small additions), `PlanetTerrain.errorPx` (existing field), `Starfield.magLimit` (existing uniform), and a cockpit rebuild through `Cockpit.dispose()` and `new Cockpit({ quality })`.

## 4. The benchmark (`?bench=1`)

The owner's benchmark: open the game with `?bench=1`, wait about a minute, then copy or download the JSON report from the results dialog (it is also logged to the console as `[bench] {...}`).

**Route** (`DEFAULT_BENCH_VIEWS`): `leo` (low Earth orbit), `earth-low` (9 km over the Himalaya, the heaviest terrain), `moon-surface`, `earthrise`, `saturn` (rings), `sun`.

**Per view:** `setView` (App's named placements), `waitIdle` (frames until the terrain worker pool has had no pending chunks for 30 frames, at most 20 s), 30 warm-up frames (compiles, LOD settling), then 240 measured frames.

**What a frame's `ms` is.** The game's driver (`createAppBenchDriver`) waits for the next animation frame, runs `App.tick()`, then waits until the GPU has finished the submitted work (WebGPU `queue.onSubmittedWorkDone()`, WebGL2 a fence polled between tasks). `ms` is that whole span: the frame's cost **without waiting for the display**, so a fast machine shows its headroom instead of a vsync-capped 16.7 ms. CPU and GPU do not overlap in this measure, so it is an upper bound on the pipelined frame time while playing. `cpuMs` (the `tick()` part) is reported separately. Draw calls and triangles come from `FrameRenderer.stats` (scene and cockpit passes; post-processing excluded).

While it runs, the driver owns the frame loop (App's own loop keeps running, but `App.tick` is a no-op on the instance until `release()`), player input is off, and the camera returns to where it was afterwards. Input comes back when the results dialog closes, so the Escape that closes it does not also open the pause menu.

**Report** (`format: "known-sky-bench"`, `version: 1`): device (`backend`, `adapter`, `dpr`, canvas size, user agent), the quality level measured, frames per view, warm-up, duration, and per view `frames, loadMs, p50Ms, p95Ms, maxMs, meanMs, cpuP50Ms, meanDrawCalls, meanTriangles, verdict, overBudget`; overall pooled `p50Ms, p95Ms, maxMs`, `worstView`, `verdict`, `suggestedPreset` and the budgets used. Reports made with a fake driver carry `synthetic: true`, and the panel labels them as sample data.

**Verdicts** (per view, from p95; overall = worst view): `smooth` p95 <= 16.7 ms (60 fps), `playable` <= 33.3 ms (30 fps), else `slow`. **Scene budgets** (TECH_PLAN Section 9): draw calls <= 600 on WebGPU and <= 300 on WebGL2, triangles <= 1.5 M; views over them are flagged.

**Suggested preset**: the highest of `high | medium | low` whose *estimated* p95 fits 60 fps in every view, where the estimate keeps the CPU part and scales the rest by `relativeCost` between the measured level and the candidate. It is an estimate from a simple model, and the panel says so; `auto` measures while playing and remains the better default.

**URL overrides** (handy for quick checks): `benchViews=leo,sun`, `benchFrames=60`.

**The results panel** (`BenchPanel`): a modal native `<dialog>` with a focus trap (as the settings dialog), the overall verdict (icon + word + colour), median, p95 and suggested preset, a table with a p95 meter per view (hairline ticks at the two budgets; the numbers are in the text), Copy JSON (clipboard API with an `execCommand` fallback and a polite status message), Download JSON, and the raw JSON in a disclosure. A progress card with a polite live region names each view as it starts. Text scales with the text-size setting (container queries turn rows into labelled cards when the dialog is narrow; explicit ARIA table roles keep the semantics), colourblind palettes apply through the shared tokens, and reduced motion removes every animation.

## 5. Limits and open questions

- **Real frame rates cannot be measured here** (SwiftShader renders on the CPU: about 2-3.5 s per frame in the e2e run). The controller is verified on synthetic traces, the benchmark's plumbing on both backends; tuning the levels needs the owner's `?bench=1` reports from real laptops.
- The cost model constants (MSAA 1.3, bloom 1.1, 1.2% per atmosphere sample) are assumptions to be replaced by measurements from those reports (run the benchmark at two presets and compare).
- `waitIdle` tracks terrain chunks, not imagery tiles (`TileSet` loads asynchronously and is not counted); the warm-up frames cover most of it.
- A purely CPU-bound machine stays at its starting level (correctly: lower quality would not help), but the controller cannot tell CPU-bound from refresh-bound; both end the same way.
- `viewSamples` only applies at boot; changing it at runtime would need material rebuilds.
- Bilinear upscaling: FSR1 (mentioned in TECH_PLAN) would sharpen the reduced scene buffer and could let `medium` drop its scale further.
