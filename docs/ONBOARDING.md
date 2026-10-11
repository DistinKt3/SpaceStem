# Known Sky: the guided opening

PRD Section 9 ("Onboarding: first 10 minutes designed end to end: start in Earth orbit, guided launch, Moon, onward")
and milestone M6 ("guided Earth-orbit opening"). Code: `src/game/onboarding/`. Lab page: `onboarding.html`. Tests:
`tests/unit/onboarding.test.ts`, `tests/e2e/onboarding.spec.ts`.

## What the player sees

The game boots in low Earth orbit, 420 km up, with the Moon targeted (`App.view('leo')`). A compact glass card at the
top left walks the pilot through one goal at a time. Each card has:

- a one-line **goal** with a status mark (a ring while pending, a tick once done),
- a **key hint** whose keycaps are the player's own bindings (keyboard or gamepad, whichever is in use),
- one line of **real science**, with any game fiction called fiction in the same sentence,
- a subtle **progress** strip (filled = done, taller = current, hollow dashed = optional) and "n / 9",
- **Skip tour** and the reminder "Restart it any time from Settings (Esc)", with the pause key from the bindings.

The card never takes input, pauses the game or blocks free play. Goals are judged from what the pilot does; a step
that is already satisfied simply shows as done. It can be minimised to a one-line pill (remembered), hidden with the
HUD, skipped, and restarted from Settings.

## Steps

| # | Step | Goal (completes when) | Keys named | Real science |
|---|---|---|---|---|
| 1 | `look` | View has turned 1 rad (head look or steering) | headLook, pitch, yaw | 420 km is near ISS height; an orbit there takes ~93 min at 7.7 km/s |
| 2 | `throttle` | Throttle setpoint >= 0.2 | throttleUp, thrust, strafeX, strafeY | Thrusters need no air (Newton's third law) |
| 3 | `target` | Target is the Moon (`301`) | targetNext, targetReticle | Moonlight left the Moon ~1.3 s ago |
| 4 | `align` | Nose on the Moon (`isAligned`) | pitch, yaw, autoAlign | The Moon is 3,475 km across yet ~0.5 degrees wide |
| 5 | `cruise` | Drive mode is cruise | modeNext | Apollo 11 took ~3 days; the cruise drive is game fiction |
| 6 | `approach` | Within 20,000 km of the Moon's surface | throttleUp | 384,400 km on average, ~30 Earths |
| 7 | `land` (optional) | Landed on the Moon | strafeY | Lunar gravity 1.62 m/s^2, ~1/6 of Earth's |
| 8 | `map` | Map open | toggleMap | Positions from JPL ephemerides; map distances compressed |
| 9 | `hyperspeed` | Hyperspeed spooling or jumping, or arrived at a star | targetNext, hyperspeed | Proxima Centauri is 4.2 ly away; faster-than-light travel is game fiction |
| - | `done` | Closing card, "The sky is yours"; closes itself after 15 s | (pause in the restart hint) | HUD distances and light times are real; only the drive is fiction |

**Nudges** (a highlighted line under the hint) appear when the pilot is stuck: the Moon is not the target; thrusters
would take more than a day (switch to cruise); the nose drifted off the bracket; the throttle is at zero; on the map,
how to reach the star list (quoting the map's own "Show star map" label) and then to close the map; landed (lift off
first); no star targeted; too deep in a gravity well for hyperspeed (below 10,000 km; the HUD reports the exact
refusal for larger bodies, D-026).

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

## Persistence

`localStorage['knownsky.onboarding']` = `{"v":1,"status":"active"|"skipped"|"done","step":"<id>","collapsed":bool}`.
Written on start, on every step change, on skip, on finishing and when minimised. Every access is wrapped in
try/catch; missing, unparsable, wrong-version or unknown-step data starts a fresh tour (`loadIssue = 'corrupt'`), and a
throwing storage makes the tour last one session (`'unavailable'`). A tour in progress resumes at its step after a
reload; a skipped or finished tour stays off until `reset()` + `start()` (the Settings entry).

## Layout and accessibility

- The card lives in a full-viewport, click-through layer that is a CSS size container. Container queries measured in
  rem follow the text-scale setting (rem is the root font size), so the layout adapts to larger text as well as to
  smaller windows.
- Top left, below the cockpit-mode HUD footer line. Width: up to 28 rem, but never past the HUD's top panel (about
  9 rem either side of centre) and never across the reticle. Verified at 1366x650, 1280x720 and 1920x1080 at 100%
  text: no overlap with the top, left or right HUD panels, the reticle or the footer; the cockpit displays sit in the
  lower half of the view (checked against `docs/media/cockpit_sun_side.jpg` with `?backdrop=cockpit`).
- With the map open (`body.ks-map-open`) the card moves to the free bottom-left corner, clear of the map's title and
  list. With the Codex open (`codexOpen`) it hides. `setVisible(false)` hides it with the HUD.
- Short windows tighten spacing; below 50 rem of height the science line steps aside while a nudge is showing.
- 200% text: on 1280x720 every step fits without clipping or sideways overflow and stays left of the reticle; the
  HUD's own panels collide with each other at that scale, so the card overlaps the HUD's top and left panels (it can
  be minimised). On 800x450 the card stays on screen and scrolls internally.
- `section` with `aria-label="Guided tour"`; the goal is an `h2`; the strip is a `progressbar` with
  `aria-valuetext="Step n of 9"`. A separate `role="status"` / `aria-live="polite"` region announces each step (goal
  plus the hint with key names), "Done: <goal>." and the skip. The status mark is shape plus colour, never colour
  alone; buttons have visible focus rings; high-contrast mode drops the glass for opaque black with white rules.
- Motion: a short slide-in for the card and for each new step, a tick "pop" and a slow pulse on the pending mark. All
  of it is off under the Settings value (`reducedMotion()` -> `data-motion="reduced"`), `html[data-reduced-motion]`
  and `prefers-reduced-motion`.
- Keyboard: the card's buttons work with Enter/Space when focused, but in the game Tab is bound to "next target", so
  keyboard and gamepad players restart or end the tour from Settings (see Integration). A mouse click never leaves
  focus on a card button, so the game's own keys cannot press it by accident.

## Provenance of the numbers

All quoted numbers are computed in `facts.ts` from cited constants (SI) and rounded for display; the unit test pins
the rendered strings.

| Fact | Value | Source |
|---|---|---|
| Earth GM | 3.986004418e14 m^3 s^-2 | IERS Conventions (2010), Table 1.1 |
| Earth mean radius | 6,371.0 km | NASA Earth Fact Sheet |
| Orbit at 420 km | v = sqrt(GM/r) = 7.66 km/s, T = 92.8 min | derived |
| Moon mean distance, radius, surface gravity | 384,400 km; 1,737.4 km; 1.62 m/s^2 | NASA Moon Fact Sheet |
| Moon light-travel time | 1.28 s | derived (c exact, BIPM SI) |
| Apollo 11 transit | launch 1969-07-16 13:32 UTC to lunar orbit insertion 1969-07-19 17:21:50 UTC = 3.16 d | NASA Apollo 11 Mission Report (MSC-00171) |
| Proxima Centauri | parallax 768.0665 mas = 4.25 ly | Gaia DR3 (Gaia Collaboration, Vallenari et al. 2023) |

Gameplay statements are labelled: "The cruise drive is game fiction", "Faster-than-light travel is game fiction",
"Only the drive is fiction".

## API

```ts
import { Onboarding, actionLabel, LookTracker, isAligned, type OnboardingSnapshot } from './onboarding/onboarding';

const tour = new Onboarding({
  parent: document.body,
  labelFor: (a) => actionLabel(settings.data, input.activeDevice, a), // current binding label
  reducedMotion: () => settings.data.reducedMotion,
  onStepChange: (id) => {}, // step ids, plus 'skipped'
  // storage?: Storage | null (default localStorage), timing?: Partial<TourTiming> (tests and the lab)
});
tour.start();             // begin or resume; no-op once skipped or finished
tour.update(dt, snapshot); // every unpaused frame, map included
tour.skip();              // end it, remembered (on the closing card: just close)
tour.reset();             // forget progress and hide; start() then replays from step 1
tour.setVisible(v);       // follow the HUD toggle
tour.skipStep();          // skip the optional landing
tour.dispose();
```

`active` is true while a step or the closing card shows; `stepId` is the current step or null.

## Integration

The integration touches shared files, so it is described here for the owners of those files (also returned as
`sharedFileRequests`).

**`src/game/ship/shipController.ts`**

```ts
import { LookTracker, MOON_ID, isAligned, type OnboardingSnapshot } from '../onboarding/onboarding';

// field, next to headLook
private readonly look = new LookTracker();

// in update(): replace the toggleHud line
if (inp.justPressed('toggleHud')) {
  this.hud.setVisible(!this.hud.isVisible);
  app.onboarding?.setVisible(this.hud.isVisible);
}

/** Per-frame state for the guided opening (docs/ONBOARDING.md). */
onboardingSnapshot(app: App): OnboardingSnapshot {
  const ship = this.ship;
  const tel = ship.telemetry;
  const info = this.targetId ? this.targetInfo(this.targetId) : null;
  return {
    t: app.simTime,
    mode: ship.mode,
    throttle: ship.throttle,
    speed: this.hyper.phase === 'jump' ? this.hyper.speed : ship.mode === 'thrusters' ? tel.surfaceSpeed : tel.speed,
    nearKey: tel.near,
    altitudeM: tel.altitude,
    landed: ship.landed,
    targetId: this.targetId,
    targetKind: info?.kind ?? null,
    targetDistanceM: info ? Math.max(0, info.rel.length() - info.radius) : null,
    alignedToTarget: info !== null && isAligned(ship.forward(), info.rel, info.radius),
    mapOpen: app.map?.isOpen ?? false,
    codexOpen: false, // until the Codex exists
    hyperPhase: this.hyper.phase,
    anchor: ship.pos.anchor,
    lookedAroundRad: this.look.update(app.cam.quat),
  };
}

/** Restarting the tour: the opening's targeting state (call after App.place). */
resetForTour(): void {
  this.targetId = MOON_ID;
  this.autoAlign = false;
  this.look.reset();
}
```

**`src/game/app.ts`**

```ts
import { Onboarding, actionLabel, type OnboardingSnapshot } from './onboarding/onboarding';

export interface Controller {
  // ...existing members...
  /** Per-frame state for the guided opening; controllers without it (the free camera) never run the tour. */
  onboardingSnapshot?(app: App): OnboardingSnapshot;
  /** Restore the opening's targeting state when the tour restarts (after App.place). */
  resetForTour?(app: App): void;
}

// field
/** The guided opening (docs/ONBOARDING.md); null when it does not run in this session. */
onboarding: Onboarding | null = null;

// constructor: give the settings panel the tour entries
this.panel = new SettingsPanel(this.settings, this.input, {
  onRestartTour: () => this.restartTour(),
  onEndTour: () => this.onboarding?.skip(),
});

// boot(): right after this.place(this.view(this.params.get('view') ?? 'leo'));
// The tour belongs to the default start in low Earth orbit; share links, test views and ?tour=0 skip it.
if ((this.params.get('view') ?? 'leo') === 'leo' && this.params.get('free') !== '1' && this.params.get('tour') !== '0') {
  this.createOnboarding();
}

// start(): first line, so the card appears once the controller exists and the boot screen is gone
this.onboarding?.start();

// tick(): right after `const paused = this.paused || this.panel.isOpen;` (before the map early return)
// The tour watches every frame, the map included (one step happens there), and freezes while paused.
if (this.onboarding && !paused) {
  const snap = this.controller?.onboardingSnapshot?.(this);
  if (snap) this.onboarding.update(dt, snap);
}

private createOnboarding(): Onboarding {
  this.onboarding ??= new Onboarding({
    parent: document.body,
    labelFor: (a) => actionLabel(this.settings.data, this.input.activeDevice, a),
    reducedMotion: () => this.reducedMotion,
    onStepChange: (id) => {
      if (id !== 'skipped') this.audio.play('ui-select'); // captioned "[Soft chime]"
    },
  });
  return this.onboarding;
}

/** Settings > Restart guided tour: back to the opening orbit with the Moon targeted, tour from the first step. */
restartTour(): void {
  if (!this.sys || this.params.get('free') === '1') return;
  const tour = this.createOnboarding();
  this.map?.close();
  this.place(this.view('leo'));
  this.controller?.resetForTour?.(this);
  tour.reset();
  tour.start();
}
```

**`src/game/ui/settingsPanel.ts`** (strings are in `en.onboarding.json`)

```ts
// constructor options
options: { parent?: HTMLElement; onRestartTour?: () => void; onEndTour?: () => void } = {},

// Accessibility pane: add a section after captions
const tourRestart = h('button', { type: 'button', class: 'ks-btn' }, icon('reset'), h('span', {}, t('onboarding.settings.restart')));
tourRestart.addEventListener('click', () => {
  options.onRestartTour?.();
  this.announce(t('onboarding.settings.restarted'));
  this.close();
});
const tourEnd = h('button', { type: 'button', class: 'ks-btn ks-btn-quiet' }, h('span', {}, t('onboarding.settings.end')));
tourEnd.addEventListener('click', () => {
  options.onEndTour?.();
  this.close();
});
const tourSection = options.onRestartTour
  ? this.section(t('onboarding.settings.section'), h('p', { class: 'ks-note' }, t('onboarding.settings.restart.hint')), h('div', { class: 'ks-row' }, tourRestart, tourEnd))
  : null;
// ...this.pane('accessibility', ...existing sections..., tourSection)
```

**`vite.config.ts`** (optional, so the lab ships like `ui.html`): add
`onboarding: resolve(import.meta.dirname, 'onboarding.html'),` to `rollupOptions.input`.

No change is needed in `main.ts`, `hud.ts`, `styles.css` or `ui.css`: `onboarding.ts` imports its own stylesheet, and
the card sits at z-index 6 (above the HUD at 2 and the map at 5, below captions at 40 and the settings dialog in the
top layer).

## Lab page

`onboarding.html` runs the card over a crude simulated ship (not the flight model) with the real HUD layout, Settings,
InputManager and SettingsPanel, so the keys it names are the real bindings and pressing them works. Lab buttons fake
each condition. Parameters: `reset=1`, `fast=1` (short delays), `step=<id>`, `textScale=`, `colorblind=`,
`reduced=1`, `cockpit=0`, `lab=0`, `pad=1`, `backdrop=cockpit`. `window.__ks` exposes the parts for tests.

## Known limitations

- In the game, Tab is bound to "next target", so the card's buttons are mouse-operable only; keyboard and gamepad
  players use the Settings entries (Restart / End guided tour), which the integration above adds.
- At 200% text on windows of 720 px or less the card overlaps HUD panels (the HUD panels overlap each other there too).
- The gravity-well nudge uses the 10,000 km floor of D-026; for bodies larger than 5,000 km radius the true limit is
  two radii, which the HUD's refusal message reports.
- `codexOpen` is wired as `false` until the Codex exists.
