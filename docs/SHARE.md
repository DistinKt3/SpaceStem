# Known Sky: shareable coordinates and screenshot mode

**Status:** M6, integrated into the game (`src/game/share/`, `src/main.ts`, `App.tick`), 2026-10-11. PRD 9a M6:
"shareable coordinate link, screenshot mode"; PRD pillar 7: "Any discovery can be shared as a link or image that
others can open and fly to."

| File | What it does |
|---|---|
| `shareLink.ts` | `ShareState`, `encodeShare`, `decodeShare` / `parseShare`, `shareUrl`, `copyText`. No DOM or three.js. |
| `screenshot.ts` | `ScreenshotMode`: overlay, keyboard access, caption preview, `capture()` to a PNG Blob at native resolution, `download()`, `supersampleScale()`. |
| `caption.ts` | Caption text (`captionFor`, `captionPlace`) and drawing (`drawCaption`), shared by the preview and the image. |
| `pngText.ts` | PNG `iTXt`/`tEXt` metadata: the screenshot carries its share link. |
| `toast.ts` | One-at-a-time notification in a polite live region. |
| `shareController.ts` | Binds the `share` and `screenshot` actions, Escape in screenshot mode, `hashchange`, dropped screenshots, the address bar and toast placement. |
| `gameShare.ts` | The game's host (`GameShareHost`, `createGameShare(app)`): camera, time, target, cockpit, overlays, supersampled frame. |
| `share.css` | Overlay, toast, and what screenshot mode hides or moves. |

In the game: press the `share` action (default K) to copy a link to the current view, the `screenshot` action (default
P) to enter screenshot mode and again to save a picture, Escape to leave it. Opening a link (or pasting one into the
address bar while playing, or dropping a Known Sky screenshot on the page) flies there.

The lab page `share.html` (`src/spike/shareDemo.ts`) runs the same controller over a 2D stand-in view with the real
Settings, InputManager, SettingsPanel and sound captions, so the UI can be checked quickly and photographed (WebGPU
canvases screenshot black under SwiftShader).

## 1. Link format (version 1)

```
https://<host>/<path>#ks1.<payload>
```

`ks` names the game, `1` is the format version, `<payload>` is unpadded base64url (RFC 4648 §5) of the bytes below.
The fragment is never sent to a server, so links work on static hosting and reveal nothing to it.
`https://<host>/<path>` is the page's origin and path only, never its query (section 4).

| Bytes | Field | Encoding |
|---|---|---|
| 1 | flags | bit 0 target, bit 1 mode, bit 2 fovDeg; bits 3-7 must be 0 |
| 1 + n | anchor | length n (1..32), then ASCII |
| 24 | offset x, y, z | 3 × float64, little-endian, metres, ICRF axes |
| 16 | quaternion x, y, z, w | 4 × float32, little-endian |
| 8 | timeMs | float64, UTC Unix milliseconds |
| 1 + n | target (if flag) | length n (1..32), then ASCII |
| 1 + n | mode (if flag) | length n (1..16), then ASCII |
| 4 | fovDeg (if flag) | float32 |
| 4 | CRC-32 | IEEE 802.3 polynomial (as PNG/zip) over the version byte (1) followed by everything above; uint32 LE |

- **Offsets round-trip bit for bit** (float64 in, float64 out), including 1e13 m, 1e19 m, subnormals and −0. This is
  what makes a link reproduce a view: the camera is placed relative to the same anchor with the same float64 offset
  (TECH_PLAN §3).
- **Orientation** is normalised before encoding and stored as float32: about 1e-7 per component, far below a pixel
  (a 1080-pixel view at 60° is ~1e-3 rad per pixel). The decoder renormalises.
- **Time** is the simulation time as UTC Unix ms (float64, exact). The game converts with `core/time.ts` and clamps to
  its ephemeris window (D-014: shared links carry their own time).
- A typical fragment with target, mode and field of view is about 100 characters; the largest possible is 191.
- A golden test (`tests/unit/share.test.ts`) freezes the encoding of a known state, checked against an independent
  Python encoder, so links made today keep working.

`fovDeg` is the sharer's vertical field of view. It is informational: the game keeps the viewer's own setting, which
is a comfort and accessibility choice. `mode` is the ship's drive mode (`thrusters`, `impulse`, `cruise`); a link made
mid-jump records `cruise`, since a hyperspeed transit cannot be resumed from a single point.

### Versions

A new version gets a new prefix (`ks2.`). `parseShare` reports `{ error: 'version', version }` for any other version,
so the game can say "made by a newer version" instead of "damaged". A version-1 payload relabelled as another version
also fails, because the version byte is inside the checksum.

## 2. Validation

`decodeShare(fragment)` returns a `ShareState` or `null`; `parseShare` returns the reason. Neither throws, for any
input (fuzzed with about 4,000 random strings and payloads in the unit tests).

| Check | Rule | Reason code |
|---|---|---|
| Input size | ≤ 4,096 characters scanned; the `ks…` token ≤ 512 | `too-long` |
| Shape | `#ks<version>.<base64url>`; a full URL is accepted and its fragment used | `empty`, `not-share`, `encoding` |
| base64url | alphabet `A-Z a-z 0-9 - _`, no padding, canonical trailing bits | `encoding` |
| Checksum | CRC-32 must match (catches truncation and any single-character edit) | `checksum` |
| Layout | known flags only, lengths in range, no bytes left over | `malformed` |
| Ids | printable ASCII, then the whitelist below | `malformed`, `invalid` |
| Numbers | finite; \|offset\| ≤ 1e22 m; \|timeMs\| ≤ 8.64e15 (ECMAScript Date range); 1 ≤ fovDeg ≤ 179 | `invalid` |
| Orientation | \|q\| within 1e-3 of 1, then renormalised; anything else (0, NaN, 1.01) is rejected | `invalid` |

**Id whitelist** (anchor and target): a NAIF-style integer without leading zeros (`10`, `399`), a catalogue star
`*<index>` (up to 7 digits), or a lowercase slug (`ism`, `trappist-1b`): `^(0|[1-9]\d{0,8}|\*(0|[1-9]\d{0,6})|[a-z][a-z0-9]*(-[a-z0-9]+)*)$`,
at most 32 characters. Markup, whitespace, path characters and names such as `__proto__` cannot pass. Mode tokens are
`^[a-z][a-z0-9-]*$`, at most 16 characters.

Limits: 1e22 m (about 320 kpc) is far beyond the game's star set (1,000 pc ≈ 3.1e19 m, D-007). The decoder only
checks syntax: the game must still confirm the anchor and target exist in its world (`GameShareHost.anchorKnown`);
unknown places are refused with a message and the view does not move.

`encodeShare` throws a `RangeError` for a state that would not decode (a caller bug); `shareStateProblem(s)` tests
first.

## 3. Screenshot mode

- **Enter** with the `screenshot` action (default P; any binding works and every hint shows the player's own
  binding). The body gets `ks-screenshot`; `share.css` hides the ship HUD (`.ks-hud`), the debug HUD (`#hud`) and
  anything marked `data-ks-hide-in-screenshot`. The host turns the cockpit model off (`App.setCockpitVisible(false)`)
  and restores it on exit, releases pointer lock and closes the map. The ship keeps flying, so the player composes the
  shot by flying: keys, the gamepad, or dragging on the view (a click on the view does not lock the pointer while the
  mode is on, so the cursor stays free for the toolbar).
- **Overlay:** viewfinder corners, a toolbar (Capture, Caption switch, Exit) and a live preview of the caption drawn by
  the same code as the image (its canvas joins the page only while the mode is on, so the game's canvas is otherwise
  the page's only canvas). It fades after 3 s without input (not while focused or hovered) and returns on any
  pointer or key activity. With the caption on, the lower corners sit above the caption text instead of crossing it.
- **Keyboard:** Tab (or Shift+Tab) from the game view moves focus to the toolbar's first (or last) button, although
  Tab is also the "next target" binding; the HUD and its target are hidden in this mode. If the player has bound Tab
  to capture or exit, Tab does that instead. From a button the browser's own focus order applies. The toolbar does not
  filter keys: the game's InputManager leaves Tab, Enter and Space to a focused button, and every other key and every
  key release still reaches the game, so the arrow keys keep flying and no key stays held after a release over the
  toolbar.
- **Capture** with the action again, or the button. `capture()` renders a frame (`getCanvasDataUrl`), draws it on a 2D
  canvas at the canvas's native resolution, adds the caption if on, and returns a PNG Blob. In the game the frame is
  **supersampled** (TECH_PLAN §8): `GameShareHost.captureFrame` renders the scene target at `supersampleScale()` (2× in
  each direction up to a 2560×1440 target, less on larger canvases, never below the render scale in use, off at the
  Low quality preset), reads the canvas, and restores the scale. Only the scene target grows: bloom works at the
  canvas's size and star sizes and terrain detail follow the canvas, so the picture matches the view the player
  composed, with smoother edges. The file is saved as `knownsky-YYYYMMDD-HHMMSS.png` (local time of capture).
- **Exit** with Escape (or the gamepad Menu button): the pause action is consumed by screenshot mode, so the pause
  menu does not open. Opening the map, the settings or the Codex (including a Codex toast's View button) also ends the
  mode. Outside screenshot mode Escape works as before.
- **What stays on screen:** sound captions stay visible (the image never contains DOM, and the sound keeps playing);
  while the caption is on they sit above the caption preview. Codex notifications move below the toolbar.
  `screenshot.ts` publishes the toolbar's bottom edge (`--ks-shot-bar-bottom`) and the caption's height
  (`--ks-shot-caption-h`, body class `ks-shot-captioned`) for that.

### Caption

Bottom band over a soft scrim: the place (`Moon · 60 m above the surface`, `Proxima Centauri · 1.203 au away`,
`Interstellar space · Sun 1.123 ly away`), the UTC time with the star's distance and light-travel time, the wordmark
with the tagline "The universe is real. The drive is fictional.", and the data credits:

> Positions: NASA/JPL Horizons · Stars: HYG v4.1 (CC BY-SA 4.0) · Milky Way: ESA/Gaia/DPAC (CC BY-SA 3.0 IGO) · Maps:
> NASA, USGS, Solar System Scope (CC BY 4.0) · Some surface detail is Generated

Which place names the view (`captionPlace`) is decided from the distances, not from whichever body is nearest: 0.05 ly
or more from the system's star is interstellar space; beyond 0.01 ly from every planet and moon (the HUD's rule) the
star names the place; otherwise the nearest planet or moon does. Light-years from the Sun an outer moon is still
nearer than the Sun's surface, so "nearest body" would have named Triton. The arrival toast uses the same rule
(`captionPlaceName`), so the toast and the image agree.

Honesty rules: every number is computed from the simulation (no inferred value is stated as measured: a visited
star's distance is given to its catalogued centre, because its radius is Inferred, D-027); the credits say that some
surface detail is Generated; when space is short, earlier credits are shortened but the Generated note always keeps
its own line. On narrow or portrait images the wordmark and tagline move into the credits block (up to five lines).
Sizes scale with the image (1 unit at 1600×900) with legible minimums.

### PNG metadata

The PNG carries `iTXt` chunks (PNG spec §11.3.3), written right after the header: `Software` = "Known Sky", `Title` =
place, `Description` = time and credits, `Comment` = "Open this link to go to the place in this image: <link>",
`Creation Time`. Dropping a Known Sky screenshot on the game reads the link back (`shareTokenFromFile`) and goes there,
so an image is shareable the same way as a link. Only PNGs are read: the 8-byte signature first (any other file stops
there), then the first MiB, where Known Sky writes the link; the whole file only when the link is further in (another
tool re-saved the image) and the file is at most 64 MiB. A video or archive dropped by mistake is never loaded.

## 4. Feedback, the address bar and accessibility

- **Links name the page only:** `origin` + `pathname` (`pageUrl()`), never the query. Query parameters are the sharer's
  own choices (`?backend=webgl`, `?free=1`, the lab's `?reset=1`, which would wipe the recipient's settings) and must
  not reach the recipient or the PNG (D-NEW-share).
- **Copying:** the async Clipboard API first, then `execCommand('copy')`. When both fail, the link goes into the
  address bar (`history.replaceState`) and the toast says to copy it from there; the next successful copy removes it.
- **Opening:** the boot fragment (applied by `main.ts` before the first frame) and any fragment pasted while playing
  (`hashchange`) are applied and then removed from the address bar (only `#ks…` fragments; others are left alone). So
  pasting the same link again in the same tab applies it again (no `hashchange` fires for an unchanged fragment), and
  a reload starts afresh instead of returning to a place the player has left.
- **Toast** (`toast.ts`): top right, one at a time, in a `role="status"` `aria-live="polite"` `aria-atomic="true"`
  region that exists from start-up. Reading time 4-12 s from the text length; hover pauses it. Kinds: ok, warn,
  error, each with an icon and a coloured edge (never colour alone). The ShareController measures what else occupies
  that corner (`placeToasts`, re-measured on resize and when those elements change size): the Codex's notification
  stack (an arrival by link often unlocks an entry) and, in screenshot mode, the toolbar. Toasts sit below both, so
  they never cover a control at any window size or text scale. On a short window where a toast would not fit below
  another notification, it moves up to stay on screen (over that notification, never over the toolbar).
  Messages: link copied (with the UTC moment), clipboard unavailable (the link is in the address bar), screenshot saved
  (file name), arrived (place and time), time adjusted to the ephemeris window, unknown place, newer version, damaged
  link, image without a location.
- Screenshot mode announces itself with the bound keys ("P captures, Esc exits") and its closing, from a live region
  outside the overlay. Buttons are native; the caption switch is `role="switch"` with a description.
- Reduced motion (the setting, `html[data-reduced-motion]` or the OS preference): no shutter flash, no slides or
  fades. Text scaling: all UI is in rem, and the narrow toolbar layout is a container query on the overlay
  (`@container ks-shot (width < 36rem)`), so it follows the text-size setting (a rem media query would not).
  Colour-blind and high-contrast palettes come from the shared tokens.

## 5. Integration

Shared files (small hunks):

1. `src/game/app.ts`: a `share: ShareController | null` field (type-only import). In `tick()`, inside the existing
   "Codex closed" block, `const pauseTaken = this.share?.update() ?? false;` runs right after `input.update(dt)`, and
   the pause handling is skipped when it is true. Share actions therefore do nothing while the Codex is open.
2. `src/main.ts`: after the controller is created, `app.share = createGameShare(app)` and
   `await app.share.applyFragment(location.hash)` before `app.start()`; `window.__ks.share` for tests.
3. `vite.config.ts`: `share.html` in `build.rollupOptions.input`.
4. No shared CSS edit: `share.css` (imported by the module) holds the screenshot-mode rules, including the ones that
   move the Codex toasts (`.ks-cx-toasts`) and the sound captions (`.ks-captions`). Other modules (the fuel gauge, the
   onboarding card) opt their overlays out of screenshots with the `data-ks-hide-in-screenshot` attribute.

`createGameShare(app)` also stacks share toasts below `app.codex.ui.toast.element` and ends screenshot mode from
`app.codex.ui.onOpenChange`. `GameShareHost.overlayOpen()` reports the map, the settings and the Codex.

Applying a link (`GameShareHost.applyState`): check the anchor resolves (a loaded body, a catalogue star index within
the catalogue, or an external frame such as `ism` or an exoplanet system's star or planet); set `simTime` (clamped);
make a shared star a lit body before placing the camera (otherwise the first frame would re-anchor through
interstellar space and lose metres of float64 precision), then run the ship's arrival hook as a jump would (for an
exoplanet system it adds the system's bodies, awaited up to 10 s); place the camera; restore target (a body, a
catalogue star or an exoplanet system) and drive mode.

## 6. Tests

- `tests/unit/share.test.ts`: round trip exactness (1e13 m neighbours, 1e22 m, subnormals, −0, 200 random
  magnitudes), quaternion ≤ 1e-6, odd ids, optional fields, golden token, every single-character edit and truncation
  rejected, crafted payloads (bad flags, trailing bytes, NaN, ∞, zero and non-unit quaternions, hostile ids), fuzzing,
  base64url canonicality, CRC-32 check value, caption text and layout (including the interstellar view with Triton
  nearest, and 0.016 ly from the Sun), credit wrapping, links without the sharer's query, dropped-file reads (bytes
  read for a screenshot, a 3 GB non-PNG, a PNG over 64 MiB, a re-saved PNG), supersample scale, PNG metadata round trip
  and damaged files.
- `tests/e2e/share.spec.ts`, lab page: copy a link and open it in a fresh page (exact offsets), the address bar left
  alone after a copy and cleared after a link is applied, the same link pasted again in the same tab, the
  clipboard-refused path, `hashchange`, refused links, the execCommand fallback; screenshot mode (HUD hidden, key
  hints, Tab and Shift+Tab into the toolbar, Escape does not open the pause menu, rebinding, idle fade), no key stuck
  after a release over the toolbar and arrows still flying, toasts clear of the toolbar and every button clickable at
  1280×720, 800×450 (text 1.5 and 2) and 390×844 (text 1 and 2), corners and sound captions above the caption preview,
  PNG at native resolution with and without caption and with the link, dropping a screenshot, reduced motion, text
  scale, high contrast.
- `tests/e2e/share.spec.ts`, real game (`index.html`, WebGPU on SwiftShader), played from the keyboard: a link places
  the camera exactly (float64 offsets bit for bit) and sets time, target and mode; K copies a query-free link; P
  enters screenshot mode with the cockpit off; Tab reaches the toolbar without changing the target; Space toggles the
  caption; a click on the view does not reach the pointer-lock request; P saves a captioned PNG at the canvas's size
  with the link; Escape leaves without the pause menu and restores the cockpit; the map and the Codex end the mode;
  an interstellar link is captioned "Interstellar space · Sun … ly away"; a pasted catalogue-star link lights the star
  without re-anchoring; a TRAPPIST-1e link loads the system and is captioned "TRAPPIST-1 e · …"; every supersampled
  capture holds a picture; at text scale 2 with a Codex notification up, the share toast stays on screen and off the
  toolbar. Review images: `test-results/share-shots/`. (These captures run before the map step: at da75eac the 3D view
  renders black once the map has been opened and closed, a pre-existing bug outside this module.)

## 7. Known limits

- The fragment carries the camera, not the ship's velocity or throttle: a link opens at rest relative to the local
  surface frame. A link made mid-jump records `cruise` at the jump's current point.
- `fovDeg` is recorded but not applied: field of view is the viewer's comfort and accessibility setting, so framing
  matches only when both use the same field of view.
- The default gamepad bindings leave `share` and `screenshot` unbound (every standard button is taken). Pad players can
  bind them in the settings; inside screenshot mode Menu exits. Default pad bindings are the input module's call.
- TECH_PLAN §8 also lists a "free camera" for screenshot mode. The mode keeps the ship's own controls (keys, pad, drag
  on the view); a camera detached from the ship is not implemented.
- A future module that also wants file drops must coordinate with the controller (option `acceptDrops: false`).
