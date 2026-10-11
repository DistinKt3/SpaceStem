# Known Sky: the guided opening

PRD Section 9 ("Onboarding: first 10 minutes designed end to end: start in Earth orbit, guided launch, Moon, onward")
and milestone M6 ("guided Earth-orbit opening"). Code: `src/game/onboarding/`. Lab page: `onboarding.html`. Tests:
`tests/unit/onboarding.test.ts`, `tests/e2e/onboarding.spec.ts` (the lab), `tests/e2e/onboarding-game.spec.ts` (the
real game). Decision: D-NEW-onboarding in `docs/DECISIONS.md`.

## What the player sees

A first visit starts 420 km above Earth with the Moon targeted and in view (see "Where it runs and where it starts").
A compact glass card at the top left walks the pilot through one goal at a time. Each card has:

- a one-line **goal** with a status mark (a ring while pending, a tick once done),
- a **key hint** whose keycaps are the player's own bindings (keyboard or gamepad, whichever is in use; on a
  gamepad the wording changes too where the keyboard text would mention the mouse or keyboard-only actions). Where a
  sentence says "hold" or "rise", the keycap is the one direction that does it ("hold W", "rise with R", "Hold RT"),
  never the whole axis pair, one half of which does the opposite,
- one line of **real science**, with any game fiction called fiction in the same sentence,
- a subtle **progress** strip (filled = done, taller = current, hollow dashed = optional) and "n / 9",
- **Skip tour** and the reminder "Restart it any time from Settings (Esc)", with the pause key from the bindings.

The card never takes input, pauses the game or blocks free play. Goals are judged from what the pilot does; a step
that is already satisfied simply shows as done. It can be minimised to a one-line pill (remembered), hides with the
HUD (the HUD toggle key) and while the Codex is open, and is left out of screenshot mode (`data-ks-hide-in-screenshot`).
Keyboard and gamepad players restart or end it from Settings > Accessibility > Guided tour.

## Where it runs and where it starts

`tourEnabled()` in `gameTour.ts`: the tour belongs to the default start. It does not run for named views
(`?view=moon-orbit` and the like), the free camera (`?free=1`), share links (`#ks1.…`) or `?tour=0`. Settings can
still restart it in any ship session (not the free camera, which has no ship).

When the tour will show (new or in progress), the game starts at `tourStart()` instead of `App.view('leo')`: 420 km
above the point of Earth where the Moon stands about 12 degrees or more above the horizon (13 from Earth's centre), with the Sun as high as that
allows (55 degrees from the zenith, the lighting of the `leo` view, whenever the Moon's position permits; at full Moon
the Sun is just below the local horizon but still above the visible limb). The point lies on the great circle from
the sub-solar point toward the sub-lunar point (`openingUp()` in `snapshot.ts`). The view looks along the horizon 20
degrees left of the Sun's direction, pitched down 18 degrees, like `leo`. The named `leo` view is unchanged (tests and
screenshots use it).

Why: from `leo` the Moon is behind Earth on about a third of all dates (the review sampled 60 half-days from
2026-10-11 and found 23 blocked). A pilot following the tour then pointed at the hidden Moon, switched to cruise and
flew into Earth; the drive dropped to thrusters 64 km up and the nudges went round in a loop.
`tests/e2e/onboarding-game.spec.ts` replays those 60 dates in the real game: the tour start always has the Moon more
than 11 degrees up and nothing in the way, while `leo` has Earth in the way on several of them.

Restart (Settings) returns the ship to `tourStart()`, targets the Moon, turns auto-align off and replays from step 1.

## Steps

| # | Step | Goal (completes when) | Keys named | Real science |
|---|---|---|---|---|
| 1 | `look` | View has turned 1 rad (head look or steering) | headLook, pitch, yaw | 420 km is near ISS height; an orbit there takes ~93 min at 7.7 km/s |
| 2 | `throttle` | Throttle setpoint >= 0.2 | throttleUp, thrust+, strafeX, strafeY | Thrusters need no air (Newton's third law) |
| 3 | `target` | Target is the Moon (`301`) | targetNext, targetReticle | Light from the Moon takes ~1.3 s to reach Earth |
| 4 | `align` | Nose on the Moon (`isAligned`) | pitch, yaw, autoAlign | The Moon is 3,475 km across yet ~0.5 degrees wide |
| 5 | `cruise` | Drive mode is cruise | modeNext | Apollo 11 took ~3 days; the cruise drive is game fiction |
| 6 | `approach` | Within 20,000 km of the Moon's surface | throttleUp (pad: thrust+) | 384,400 km on average, ~30 Earths |
| 7 | `land` (optional) | Landed on the Moon | thrust+, throttleZero (pad: thrust-) | Lunar gravity 1.62 m/s^2, ~1/6 of Earth's |
| 8 | `map` | Map open | toggleMap | Positions for the date on the HUD from JPL ephemerides; map distances compressed |
| 9 | `hyperspeed` | Hyperspeed spooling or jumping, or arrived at a star beyond the Solar System (a catalogue star or an exoplanet system) | targetNext, hyperspeed | Proxima Centauri is 4.2 ly away; faster-than-light travel is game fiction |
| - | `done` | Closing card, "The sky is yours"; closes itself after 15 s | (pause in the restart hint) | HUD distances and light times come from real measurements; the drive is fiction, and anything inferred or generated is labelled as such |

### Landing

The landing advice follows the flight model (`ship.ts`), checked in the real game by
`tests/e2e/onboarding-game.spec.ts`. The tour leaves the pilot with the nose on the Moon (often with auto-align on,
which keeps it on the Moon's centre). In that attitude the strafe keys move the ship along the surface, never down.
So the hint is: near the surface the drive drops to thrusters; ease down with forward thrust ({thrust+}); once on the
ground, cut the throttle ({throttleZero}; on a pad, hold {thrust-}). Touchdown needs the throttle at 5 % or less;
cutting the throttle in mid-air makes flight assist hover, and the card then says to ease down again.

Playing the tour in the real game exposed two flight-model gaps that made this advice false, fixed in `ship.ts` (two
small hunks):

- **Drop-out look-ahead.** The cruise drive's velocity lags its governor (time constant 0.4 s against 1.1 s), so a
  full-throttle arrival still closes at about 1,300 km/s near the surface. The drop-out test used the altitude before
  the step, so at 30 frames per second or fewer one step carried the ship through the 20 km band and into the ground
  (at 60 fps it dropped out about 2 km up). The test now looks one step ahead (altitude minus closing speed times the
  frame time), so the ship drops out above the surface at any frame rate (about 40 km up at 60 fps, 90 km at 10 fps).
- **Settled touchdown.** A ship pressed onto the ground that cuts its throttle is held by flight assist exactly at the
  2.5 m clearance, where it never touched again and never counted as landed. Within half a second of a ground contact,
  resting below 3 m with the throttle cut and under 4 m/s now lands. A lift-off is not caught by it (no contact).

`tests/e2e/onboarding-game.spec.ts` checks all of this in the real flight model: strafing does not descend, forward
thrust does, the throttle cut lands, the arrival drops out above the surface at 10 frames per second, and "rise"
leaves the ground.

### Nudges

A highlighted line appears when the pilot is stuck (`steps.ts`, in priority order per step). It sits above the key
hint, so in a short card it is never the line that scrolls out of view:

- **align**: the Moon is not the target; a body is in the way (below).
- **approach** (and the land step while still in a drive): the Moon is not the target; **a body is in the way**: the
  straight path to the Moon passes within the drive's drop-out height of a body (`pathBlocker()`), so "Earth is
  between you and the Moon. Steer away from Earth and climb clear of it, then turn back to the bracket" (with
  auto-align on: turn it off first); thrusters near Earth: "At the thrusters' top speed (3 km/s) the Moon is about 33
  hours away", computed from the live distance and `FLIGHT.thrustersMaxSpeed` (a property of the game's drive, not a
  claim about physics); the nose drifted off the bracket; the throttle is at zero.
- **land**: the nose is more than 15 degrees off the Moon's centre (point it straight down: auto-align); in the air
  with the throttle cut: ease down; on the ground with the throttle up: cut it.
- **hyperspeed**: the target star is too close (closer than 0.01 ly, as `Hyperspeed.engage` refuses; the Sun is listed
  on the star map, so "Too close for a jump: Sun"); on the system map, the map's own "Show star map" label; on the star
  map, "Choose one of the named stars in the list"; a star is targeted: close the map; landed: "rise with R"; no star
  targeted; too deep in a gravity well: below max(10,000 km, two radii) of a planet or moon, the rule
  `Hyperspeed.engage` uses, quoted as the altitude to reach ("climb to an altitude of 13,000 km" at Earth). When the
  nose points into the body (auto-align on a star below the horizon, which happened in the real-game playthrough
  after lifting off the Moon toward Proxima Centauri), climbing along it would only drop out again, so the nudge says
  to pitch up with the "nose up" key ({pitch+}, which follows "Invert Y" on a stick) and to turn auto-align off first.

A unit test runs `Hyperspeed.engage` against the same floors and distances, so the nudges and the engine cannot
drift apart.

### Timing

- **Reading time** (`minDwell`, 2 s; 4 s for `look` and `target`): a step stays at least this long. The Moon starts
  targeted, so `target` would otherwise flash past.
- **Hold** (0.25 s; 0.4 s for `align`): the goal must hold without interruption, so a nose sweeping across the Moon for
  one frame does not count.
- **Grace** (1.5 s): a completed step stays on screen, ticked and announced, before the next one appears.
- **Catch-up**: `approach`, `land` and `hyperspeed` are "state" goals. If the pilot reaches one early (flies to the Moon
  during the throttle step), the tour jumps there and shows it done, instead of asking for things that no longer
  matter. Teaching steps (`map`) never trigger a catch-up.
- **Optional landing**: passes by itself when the next goal (map open) is met, or with "Skip this step". Landing on
  Earth does not count.
- In the game the tour times itself with the frame time while unpaused, including while the map is open (one step
  happens there). It holds still while Settings or the game's pause is open, and while the Codex is open (the card is
  hidden then).

## Persistence

`localStorage['knownsky.onboarding']` = `{"v":1,"status":"active"|"skipped"|"done","step":"<id>","collapsed":bool}`.
Written on start, on every step change, on skip, on finishing and when minimised. Every access is wrapped in
try/catch; missing, unparsable, wrong-version or unknown-step data starts a fresh tour (`loadIssue = 'corrupt'`), and a
throwing storage makes the tour last one session (`'unavailable'`). A tour in progress resumes at its step after a
reload; a skipped or finished tour stays off until Settings > Restart guided tour.

## Layout and accessibility

- The card lives in a full-viewport, click-through layer that is a CSS size container. Container queries measured in
  rem follow the text-scale setting (rem is the root font size), so the layout adapts to larger text as well as to
  smaller windows.
- Top left, below the cockpit-mode HUD footer line. Width: up to 28 rem, but never past the HUD's top panel (about
  9 rem either side of centre) and never across the reticle.
- **Short windows**: with at least 27 rem of height, the card ends half a rem above the HUD's left panel (centred at
  the left edge, 8.24 rem tall in thrusters mode) and scrolls when its content is taller. The goal and hint come first;
  a soft fade at the bottom edge shows there is more (`data-more`, updated by a ResizeObserver and scrolling, never
  measured per frame). The science line steps aside while a nudge shows below 50 rem of height; spacing tightens below
  44 rem; below 32 rem the header leaves the flow (the minimise button at the end of the goal row, the eyebrow and
  count hidden, the progress strip kept for screen readers only). A keycap never wraps away from the bracket or
  punctuation around it ("(Esc).").
- Measured on the lab page at 100 % text for every step: no overlap with the top, left or right HUD panels, the
  reticle or the footer at 800x450, 1024x576, 1280x600, 1280x720, 1366x650 and 1920x1080. The goal and the first
  instruction (the nudge when one shows, else the whole key hint) are in view at 1024x576 and larger; at 800x450 the
  goal and the first three lines are, the rest scrolls behind the fade. `tests/e2e/onboarding.spec.ts` checks these
  sizes; the same layout was checked in the real game at 800x450 and 1280x720.
- **200 % text** below 27 rem of height (1280x720 at 200 % is 22.5 rem): the HUD's own panels collide with each other,
  and the card stays fully readable instead of scrolling; it overlaps the HUD's top and left panels (it can be
  minimised). At 1920x1080 and 200 % the short-window rule applies: no overlap, the card scrolls.
- With the map open (`body.ks-map-open`) the card moves to the free bottom-left corner, clear of the map's title and
  list.
- `section` with `aria-label="Guided tour"`; the goal is an `h2`; the strip is a `progressbar` with
  `aria-valuetext="Step n of 9"`. A separate `role="status"` / `aria-live="polite"` region announces each step (goal
  plus the hint with key names), "Done: <goal>." and the skip. The "Real science" tag is followed by a visually hidden
  separator, so screen readers read "Real science: You are..." rather than one run-on word. The status mark is shape
  plus colour, never colour alone; buttons have visible focus rings; high-contrast mode drops the glass for opaque
  black with white rules.
- Motion: a short slide-in for the card and for each new step, a tick "pop" and a slow pulse on the pending mark. All
  of it is off under the Settings value (`reducedMotion()` -> `data-motion="reduced"`), `html[data-reduced-motion]`
  and `prefers-reduced-motion`.
- Keyboard: in the game Tab is bound to "next target", so the card's buttons are for the mouse; Settings >
  Accessibility > Guided tour has **Restart guided tour** and **End guided tour** (End only while the tour shows) for
  keyboard and gamepad players. The dialog closes before acting, so the card's own live region (outside the modal
  dialog, inert while it is open) announces the result. A mouse click never leaves focus on a card button, so the
  game's own keys cannot press it by accident.

## Provenance of the numbers

All quoted numbers are computed in `facts.ts` from cited constants (SI) and rounded for display; the unit test pins
the rendered strings.

| Fact | Value | Source |
|---|---|---|
| Earth GM | 3.986004418e14 m^3 s^-2 | IERS Conventions (2010), Table 1.1 |
| Earth mean radius | 6,371.0 km | NASA Earth Fact Sheet |
| Orbit at 420 km | v = sqrt(GM/r) = 7.66 km/s, T = 92.8 min | derived |
| Moon mean distance, radius, surface gravity | 384,400 km; 1,737.4 km; 1.62 m/s^2 | NASA Moon Fact Sheet |
| Moon light-travel time | 1.28 s (mean distance) | derived (c exact, BIPM SI) |
| Apollo 11 transit | launch 1969-07-16 13:32 UTC to lunar orbit insertion 1969-07-19 17:21:50 UTC = 3.16 d | NASA Apollo 11 Mission Report (MSC-00171) |
| Proxima Centauri | parallax 768.0665 mas = 4.25 ly | Gaia DR3 (Gaia Collaboration, Vallenari et al. 2023) |

Game statements are labelled or phrased as such: "The cruise drive is game fiction", "Faster-than-light travel is game
fiction", "The drive is fiction, and anything inferred or generated is labelled as such", and the thrusters' trip time
is stated as a property of their top speed. The target step's line is a fact about Earth and the Moon ("Light from the
Moon takes about 1.3 seconds to reach Earth"), true wherever the pilot is.

## API

```ts
import { Onboarding, actionLabel, LookTracker, isAligned, type OnboardingSnapshot } from './onboarding/onboarding';

const tour = new Onboarding({
  parent: document.body,
  // Current binding label; with `half` ('+' or '-'), only that direction of an axis ("W" for thrust '+').
  labelFor: (a, half) => actionLabel(settings.data, input.activeDevice, a, half),
  device: () => input.activeDevice, // gamepad wording of hints ('<key>.pad' messages)
  reducedMotion: () => settings.data.reducedMotion,
  onStepChange: (id) => {}, // step ids, plus 'skipped'
  // storage?: Storage | null (default localStorage), timing?: Partial<TourTiming> (tests and the lab)
});
tour.start();              // begin or resume; no-op once skipped or finished
tour.update(dt, snapshot); // every unpaused frame, map included
tour.skip();               // end it, remembered (on the closing card: just close)
tour.reset();              // forget progress and hide
tour.restart();            // reset() + start(): replay from step 1
tour.setVisible(v);        // follow the HUD toggle
tour.skipStep();           // skip the optional landing
tour.dispose();
```

`active` is true while a step or the closing card shows; `willShow` while it is new or in progress; `stepId` is the
current step or null. Templates use `{actionId}` for a binding and `{actionId+}` / `{actionId-}` for one direction of
an axis action.

`OnboardingSnapshot` (`types.ts`) is plain data: drive mode, throttle, speed; the nearest body (key, name, kind,
radius, altitude, height above ground); landed; auto-align; the target (id, name, kind, distance to its surface,
aligned, angle off the nose, a body blocking the way); a body ahead of the nose; map open and mode; Codex open;
hyperspeed phase; anchor; arrived beyond the Solar System; accumulated view rotation; the thrusters' top speed.

## Integration (as applied)

All game-side logic is in `src/game/onboarding/gameTour.ts`: `tourEnabled()`, `tourStart()`, `shipSnapshot()` (the
per-frame snapshot from the `ShipController`, read through its public members) and `GameTour` (the card with the
game's bindings, device, reduced motion and the "[Soft chime]" UI cue per step; it mirrors the HUD's visibility each
frame and restarts the tour). `ShipController` is not changed.

- `src/game/app.ts`: an `onboarding: GameTour | null` field; in the constructor the Settings panel gets
  `{ tour: { restart, end, isActive } }` except with `?free=1`; in `boot()`, after the first placement, the tour is
  created when `tourEnabled(params, location.hash)` and the ship is placed at `tourStart()` if it will show;
  `restartTour()` (creates the tour on demand); `start()` calls `onboarding.start()` first; `tick()` calls
  `onboarding.update(codexOpen ? 0 : dt)` unless the game is paused or Settings is open, before the map's early return.
- `src/game/ui/settingsPanel.ts`: an optional `tour` option; a "Guided tour" section at the end of the Accessibility
  pane with a note, **Restart guided tour** and **End guided tour** (hidden unless the tour is active, checked on
  open). Both close the dialog first.
- `vite.config.ts`: `onboarding.html` in `build.rollupOptions.input`.
- No change in `main.ts`, `hud.ts`, `styles.css` or `ui.css`: `onboarding.ts` imports its own stylesheet (which also
  styles the Settings row), and the card sits at z-index 6 (above the HUD at 2 and the map at 5, below captions at 40,
  the Codex toasts at 60 and the Settings dialog in the top layer).

## Lab page

`onboarding.html` runs the card over a crude simulated ship (not the flight model, but following its rules where the
tour gives advice: thrusters move the ship along the nose, slow down near the ground, and touchdown needs the throttle
cut) with the real HUD layout, Settings, InputManager and SettingsPanel, so the keys it names are the real bindings and
pressing them works. Lab buttons fake each condition, including "20 km above Moon" (where the drive drops out) and
"Earth in the way". The star map lists the Sun, as the game's does. Parameters: `reset=1`, `fast=1` (short delays),
`step=<id>`, `textScale=`, `colorblind=`, `reduced=1`, `cockpit=0`, `lab=0`, `pad=1`, `backdrop=cockpit`.
`window.__ks` exposes the parts for tests.

## Known limitations

- At 800x450 and 100 % text there is no free space beside the HUD panels: the card keeps clear of them and the end of
  a long hint scrolls behind the fade (mouse wheel over the card while the pointer is free). Below 27 rem of height
  (200 % text in windows up to about 860 px tall) the card overlaps the HUD's top and left panels instead; the HUD
  panels overlap each other there too.
- Two "next drive mode" presses within one frame count once (the input module reads `modeNext` with `justPressed`).
- The opening start moves with the Moon (a returning player resumes the tour at a different point of the orbit); the
  `leo` view used by tests and screenshots stays fixed.
