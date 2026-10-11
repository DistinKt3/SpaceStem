# Known Sky: shareable coordinates and screenshot mode

**Status:** M6 module (`src/game/share/`), 2026-10-11. PRD 9a M6: "shareable coordinate link, screenshot mode"; PRD
pillar 7: "Any discovery can be shared as a link or image that others can open and fly to."

| File | What it does |
|---|---|
| `shareLink.ts` | `ShareState`, `encodeShare`, `decodeShare` / `parseShare`, `shareUrl`, `copyText`. No DOM or three.js. |
| `screenshot.ts` | `ScreenshotMode`: overlay, caption preview, `capture()` to a PNG Blob at native resolution, `download()`. |
| `caption.ts` | Caption text (`captionFor`) and drawing (`drawCaption`), shared by the preview and the image. |
| `pngText.ts` | PNG `iTXt`/`tEXt` metadata: the screenshot carries its share link. |
| `toast.ts` | One-at-a-time notification in a polite live region. |
| `shareController.ts` | Binds the `share` and `screenshot` actions, Escape in screenshot mode, `hashchange`, dropped screenshots. |
| `gameShare.ts` | The game's host (`GameShareHost`, `createGameShare(app)`): camera, time, target, renderer. |
| `share.css` | Overlay, toast, and what screenshot mode hides. |

The lab page `share.html` (`src/spike/shareDemo.ts`) runs the controller over a 2D stand-in view with the real
Settings, InputManager and SettingsPanel; `share.html?game=1#ks1.…` boots the real game with the integration below.

## 1. Link format (version 1)

```
https://<host>/<path>#ks1.<payload>
```

`ks` names the game, `1` is the format version, `<payload>` is unpadded base64url (RFC 4648 §5) of the bytes below.
The fragment is never sent to a server, so links work on static hosting and reveal nothing to it.

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
  anything marked `data-ks-hide-in-screenshot`; captions leave the picture but stay in the accessibility tree. The
  host turns the cockpit model off (`FrameRenderer.cockpitEnabled`) and restores it on exit, releases pointer lock and
  closes the map.
- **Overlay:** viewfinder corners, a toolbar (Capture, Caption switch, Exit) and a live preview of the caption drawn by
  the same code as the image. It fades after 3 s without input (not while focused or hovered) and returns on any
  pointer or key activity. Activation keys on the toolbar stop there, so Space on a button does not change drive mode.
- **Capture** with the action again, or the button. `capture()` renders a frame (`getCanvasDataUrl`), draws it on a 2D
  canvas at the canvas's native resolution, adds the caption if on, and returns a PNG Blob. The file is saved as
  `knownsky-YYYYMMDD-HHMMSS.png` (local time of capture).
- **Exit** with Escape (or the gamepad Menu button): the pause action is consumed by screenshot mode, so the pause
  menu does not open. Outside screenshot mode Escape works as before.

### Caption

Bottom band over a soft scrim: the place (`Moon · 60 m above the surface`, `Proxima Centauri · 0.05875 au away`,
`Interstellar space · Sun 4.24 ly away`), the UTC time with the star's distance and light-travel time, the wordmark
with the tagline "The universe is real. The drive is fictional.", and the data credits:

> Positions: NASA/JPL Horizons · Stars: HYG v4.1 (CC BY-SA 4.0) · Milky Way: ESA/Gaia/DPAC (CC BY-SA 3.0 IGO) · Maps:
> NASA, USGS, Solar System Scope (CC BY 4.0) · Some surface detail is Generated

Honesty rules: every number is computed from the simulation (no inferred value is stated as measured: a visited
star's distance is given to its catalogued centre, because its radius is Inferred, D-027); the credits say that some
surface detail is Generated; when space is short, earlier credits are shortened but the Generated note always keeps
its own line. On narrow or portrait images the wordmark and tagline move into the credits block (up to five lines).
Sizes scale with the image (1 unit at 1600×900) with legible minimums.

### PNG metadata

The PNG carries `iTXt` chunks (PNG spec §11.3.3): `Software` = "Known Sky", `Title` = place, `Description` = time and
credits, `Comment` = "Open this link to go to the place in this image: <link>", `Creation Time`. Dropping a Known Sky
screenshot on the game reads the link back (`findShareInPng`) and goes there, so an image is shareable the same way as
a link.

## 4. Feedback and accessibility

- Toast (`toast.ts`): top right (below the toolbar in screenshot mode), one at a time, in a `role="status"`
  `aria-live="polite"` `aria-atomic="true"` region that exists from start-up. Reading time 4-12 s from the text length;
  hover pauses it. Kinds: ok, warn, error, each with an icon and a coloured edge (never colour alone).
  Messages: link copied (with the UTC moment), clipboard unavailable (the link is in the address bar), screenshot saved
  (file name), arrived (place and time), time adjusted to the ephemeris window, unknown place, newer version, damaged
  link, image without a location.
- Screenshot mode announces itself with the bound keys ("P captures, Esc exits") and its closing, from a live region
  outside the overlay. Buttons are native; the caption switch is `role="switch"` with a description.
- Reduced motion (the setting, `html[data-reduced-motion]` or the OS preference): no shutter flash, no slides or
  fades. Text scaling: all UI is in rem. Colour-blind and high-contrast palettes come from the shared tokens.
- Copying: the async Clipboard API first, then `execCommand('copy')`; the link is also written to the address bar
  (`history.replaceState`), so copying always has a fallback.

## 5. Integration

The module needs four small shared changes (also listed in the hand-off): see `sharedFileRequests` in the module
report. In short:

1. `src/game/app.ts`: a `share` field, and in `tick()` call `this.share?.update()` right after `this.input.update(dt)`;
   skip the pause handling when it returns true.
2. `src/main.ts`: after the controller is created, `app.share = createGameShare(app)` and
   `await app.share.applyFragment(location.hash)` before `app.start()`.
3. `vite.config.ts`: add `share.html` to `build.rollupOptions.input` so the lab page is built.
4. No shared CSS edit: `share.css` (imported by the module) holds the screenshot-mode rules. Other modules can opt
   their overlays out of screenshots with the `data-ks-hide-in-screenshot` attribute.

Applying a link (`GameShareHost.applyState`): check the anchor resolves (a loaded body, a catalogue star index within
the catalogue, or an external frame such as `ism`); set `simTime` (clamped); make a shared star a lit body before
placing the camera (otherwise the first frame would re-anchor through interstellar space and lose metres of float64
precision), then run the ship's arrival hook as a jump would; place the camera; restore target and drive mode.

## 6. Tests

- `tests/unit/share.test.ts`: round trip exactness (1e13 m neighbours, 1e22 m, subnormals, −0, 200 random
  magnitudes), quaternion ≤ 1e-6, odd ids, optional fields, golden token, every single-character edit and truncation
  rejected, crafted payloads (bad flags, trailing bytes, NaN, ∞, zero and non-unit quaternions, hostile ids), fuzzing,
  base64url canonicality, CRC-32 check value, caption text and layout, credit wrapping, PNG metadata round trip and
  damaged files.
- `tests/e2e/share.spec.ts` on `share.html`: copy a link and open it in a fresh page (exact offsets), `hashchange`,
  refused links, the execCommand fallback, screenshot mode (HUD hidden, key hints, Escape does not open the pause
  menu, rebinding, idle fade), PNG at native resolution with and without caption and with the link, dropping a
  screenshot, reduced motion, text scale, high contrast; and the real game (`?game=1`): a link places the camera
  exactly, sets time, target and mode, a pasted star link lights the star without re-anchoring, and the capture
  composites the WebGPU frame. Review images: `test-results/share-shots/`.
- The integration in section 5 was applied temporarily to `app.ts`, `main.ts` and `vite.config.ts` and checked on
  `index.html` with a link (type check and lint clean; camera, target and drive mode placed; screenshot mode hides the
  HUD and cockpit and restores the cockpit; Escape leaves screenshot mode without opening the pause menu and opens it
  afterwards; the share key copies the link). It is not committed here, because those files belong to the integrator.

## 7. Known limits

- Supersampled capture (TECH_PLAN §8) is not done: the image is the canvas at its native resolution (device pixels).
  `FrameRenderer.setRenderScale` could render a larger frame for the capture; it was not tried on SwiftShader.
- The fragment carries the camera, not the ship's velocity: a link opens at rest relative to the local surface frame.
- Exoplanet anchors (M4, `trappist-1b`) pass validation and resolve through the App's external-anchor hook and the
  ship's arrival hook; this branch was cut before M4 merged, so that path is untested here.
