/**
 * Share and screenshot lab (share.html).
 *
 * Default: a DOM-only page. A 2D canvas sketches the view from a SystemPos-like state (anchor body, float64 offset,
 * quaternion), so applying a link visibly moves the "camera"; the ShareController runs with the real Settings,
 * InputManager, SettingsPanel and a stand-in HUD, exactly as it would in the game. Exposes window.__ks for
 * tests/e2e/share.spec.ts.
 *
 * The real game runs the same controller (src/main.ts, App.tick); tests/e2e/share.spec.ts checks it on index.html.
 *
 * URL parameters: reset=1 (clear stored settings), textScale=<0.8..2>, colorblind=<mode>, reducedMotion=1. Links made
 * here never carry them (ShareController builds links from the page's origin and path).
 */
import '../game/styles.css';
import '../game/ui/ui.css';
import '../game/hud/hud.css';
import { t } from '../game/i18n';
import { InputManager } from '../game/input/inputManager';
import { bindingLabel } from '../game/input/labels';
import type { ActionId } from '../game/input/actions';
import { COLORBLIND_MODES, Settings, type ColorblindMode } from '../game/settings/settings';
import { SettingsPanel } from '../game/ui/settingsPanel';
import { Captions } from '../game/ui/captions';
import { captionFor, captionPlaceName, formatUtc, type CaptionInput } from '../game/share/caption';
import { findShareInPng, readPngText } from '../game/share/pngText';
import { ShareController, type ApplyResult, type ShareHost } from '../game/share/shareController';
import { decodeShare, encodeShare, isShareId, makeShareState, parseShare, type ShareState } from '../game/share/shareLink';

const params = new URLSearchParams(location.search);
if (params.get('reset') === '1') {
  try {
    localStorage.removeItem('knownsky.settings');
  } catch {
    // Storage blocked: nothing to reset.
  }
}

const canvas = document.getElementById('c') as HTMLCanvasElement;

// --- Small vector helpers (the lab avoids three.js so it stays DOM-only) --------------------------------------------

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

const norm = (v: V3): V3 => {
  const n = Math.hypot(...v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Rotates v by unit quaternion q (x, y, z, w). */
function rotate(q: Q4, v: V3): V3 {
  const [x, y, z, w] = q;
  const u: V3 = [x, y, z];
  const uv = cross(u, v);
  const uuv = cross(u, uv);
  return add(v, add(scale(uv, 2 * w), scale(uuv, 2)));
}

/** Quaternion whose -Z axis looks along `fwd` with +Y toward `up` (camera convention). */
function lookQuat(fwd: V3, up: V3): Q4 {
  const z = norm(scale(fwd, -1));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  // Rotation matrix columns x, y, z -> quaternion.
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const tr = m00 + m11 + m22;
  let q: Q4;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotate `v` about unit `axis` by `deg`. */
function turn(v: V3, axis: V3, deg: number): V3 {
  const a = (deg * Math.PI) / 360;
  const s = Math.sin(a);
  return rotate([axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(a)], v);
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- The stand-in world -----------------------------------------------------------------------------------------------

interface LabBody {
  nameKey: string | null;
  name: string;
  radiusM: number;
  star: boolean;
  /** Lit, mid and shadow colours. */
  colors: [string, string, string];
  glow?: string;
  detail?: 'clouds' | 'craters' | 'dust';
  /** Stand-in distance to the Sun (m): mean orbital distances, NASA planetary fact sheets. */
  sunDistM?: number;
}

/** Radii: IAU 2015 nominal / NASA fact sheets (Sun, Earth, Moon, Mars); Proxima Centauri: Kervella et al. 2017. */
const BODIES: Record<string, LabBody> = {
  '10': { nameKey: 'body.sun', name: 'Sun', radiusM: 6.957e8, star: true, colors: ['#fffaf0', '#ffd88a', '#ff9a3c'], glow: '255, 214, 150' },
  '399': { nameKey: 'body.earth', name: 'Earth', radiusM: 6.371e6, star: false, colors: ['#b9dcff', '#2f6db3', '#04112a'], glow: '120, 185, 255', detail: 'clouds', sunDistM: 1.496e11 },
  '301': { nameKey: 'body.moon', name: 'Moon', radiusM: 1.7374e6, star: false, colors: ['#e9e5dc', '#8f8b84', '#1c1b1a'], detail: 'craters', sunDistM: 1.496e11 },
  '499': { nameKey: 'body.mars', name: 'Mars', radiusM: 3.3895e6, star: false, colors: ['#f6c39c', '#b65a2e', '#2a0d05'], glow: '240, 170, 130', detail: 'dust', sunDistM: 2.279e11 },
  '*105913': { nameKey: null, name: 'Proxima Centauri', radiusM: 1.07e8, star: true, colors: ['#fff1e6', '#ff8a5c', '#c2321a'], glow: '255, 120, 80' },
};
/** Sun direction in the stand-in world (all planets lit from here). */
const SUN_DIR = norm([0.62, 0.38, 0.69]);
/** Ephemeris window the game clamps to (docs/DATA_MANIFEST.md, Horizons fit 2026-01-01 to 2032-01-01). */
const WINDOW: [number, number] = [Date.UTC(2026, 0, 1), Date.UTC(2032, 0, 1)];

interface LabState {
  anchor: string;
  offset: V3;
  quat: Q4;
  timeMs: number;
  target: string | null;
  mode: string;
}

function bodyName(id: string): string {
  const b = BODIES[id];
  if (!b) return id === 'ism' ? t('share.demo.place.deep') : id;
  return b.nameKey ? t(b.nameKey) : b.name;
}

function place(name: string): LabState {
  const time = Date.UTC(2026, 9, 11, 14, 3, 12);
  switch (name) {
    case 'moon': {
      const d = 9.2e6;
      const pos = scale(norm([-0.55, -0.62, 0.42]), d);
      const toBody = norm(scale(pos, -1));
      const fwd = turn(toBody, [0, 0, 1], 15);
      return { anchor: '301', offset: pos, quat: lookQuat(fwd, [0, 0, 1]), timeMs: time, target: '399', mode: 'impulse' };
    }
    case 'mars': {
      const pos = scale(norm([0.2, -0.9, 0.3]), 2.4e7);
      const fwd = turn(norm(scale(pos, -1)), [0, 0, 1], -12);
      return { anchor: '499', offset: pos, quat: lookQuat(fwd, [0, 0, 1]), timeMs: time + 86_400_000 * 41, target: '499', mode: 'cruise' };
    }
    case 'proxima': {
      const pos = scale(norm([0.4, -0.3, -0.86]), 1.8e11);
      const fwd = turn(norm(scale(pos, -1)), [0, 0, 1], 9);
      return { anchor: '*105913', offset: pos, quat: lookQuat(fwd, [0, 0, 1]), timeMs: time, target: '*105913', mode: 'cruise' };
    }
    case 'deep':
      return { anchor: 'ism', offset: [1.21e16, -3.4e15, 2.2e15], quat: lookQuat(norm([-0.84, -0.32, -0.43]), [0, 0, 1]), timeMs: time, target: '*105913', mode: 'cruise' };
    default: {
      // Low Earth orbit, 420 km up, looking along the horizon with the limb across the lower half.
      const up = norm([0.3, -0.85, 0.42]);
      const pos = scale(up, 6.371e6 + 420e3);
      const east = norm(cross([0, 0, 1], up));
      // Pitch 13 degrees down about north (the horizon dips 20 degrees at this height).
      const fwd = turn(east, norm(cross(up, east)), 13);
      return { anchor: '399', offset: pos, quat: lookQuat(fwd, up), timeMs: time, target: '301', mode: 'thrusters' };
    }
  }
}

/** Draws the stand-in view. Every value comes from the state, so a decoded link reproduces the same picture. */
function drawView(c: HTMLCanvasElement, s: LabState): void {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(1, Math.round(innerWidth * dpr));
  const h = Math.max(1, Math.round(innerHeight * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext('2d');
  if (!g) return;
  const f = h / 2 / Math.tan((60 * Math.PI) / 360);
  const right = rotate(s.quat, [1, 0, 0]);
  const upv = rotate(s.quat, [0, 1, 0]);
  const fwd = rotate(s.quat, [0, 0, -1]);
  const project = (d: V3): [number, number, number] => {
    const z = dot(d, fwd);
    return [w / 2 + (f * dot(d, right)) / z, h / 2 - (f * dot(d, upv)) / z, z];
  };

  const bg = g.createLinearGradient(0, 0, w * 0.3, h);
  bg.addColorStop(0, '#02040b');
  bg.addColorStop(1, '#060a16');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  // Milky Way: soft blobs along a great circle (stand-in for the Gaia map).
  const rnd = seeded(0x51a7e);
  const A = norm([-0.87, -0.2, -0.45]);
  const B = norm(cross(A, [0.3, 0.9, -0.3]));
  const N = norm(cross(A, B));
  for (let i = 0; i < 1800; i++) {
    const a = rnd() * Math.PI * 2;
    const off = (rnd() - 0.5) * 0.2 * (0.3 + rnd());
    const d = norm(add(add(scale(A, Math.cos(a)), scale(B, Math.sin(a))), scale(N, off)));
    const [x, y, z] = project(d);
    if (z <= 0.1 || x < -200 || y < -200 || x > w + 200 || y > h + 200) continue;
    const r = (24 + rnd() * 70) * dpr;
    const glow = g.createRadialGradient(x, y, 0, x, y, r);
    const warm = rnd() > 0.7;
    glow.addColorStop(0, warm ? 'rgba(255, 220, 190, 0.03)' : 'rgba(170, 190, 255, 0.026)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = glow;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Stars: fixed directions, so the field turns with the camera.
  for (let i = 0; i < 2600; i++) {
    const u = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const d: V3 = [Math.sqrt(1 - u * u) * Math.cos(a), Math.sqrt(1 - u * u) * Math.sin(a), u];
    const m = rnd() ** 4;
    const [x, y, z] = project(d);
    if (z <= 0.05 || x < 0 || y < 0 || x > w || y > h) continue;
    const tint = rnd();
    g.fillStyle = tint > 0.85 ? `rgba(255, 214, 180, ${0.3 + m * 0.7})` : tint < 0.15 ? `rgba(180, 205, 255, ${0.3 + m * 0.7})` : `rgba(235, 240, 255, ${0.25 + m * 0.75})`;
    g.beginPath();
    g.arc(x, y, (0.35 + m * 1.5) * dpr, 0, Math.PI * 2);
    g.fill();
  }

  const body = BODIES[s.anchor];
  // The Sun as a glare when it is in view from a planet.
  if (body && !body.star) {
    const [x, y, z] = project(SUN_DIR);
    if (z > 0.05) drawStarGlow(g, x, y, 10 * dpr, h, '255, 236, 205');
  }
  if (!body) return;
  const dist = Math.hypot(...s.offset);
  const dir = norm(scale(s.offset, -1));
  const ang = Math.asin(Math.min(1, body.radiusM / dist));
  const zc = dot(dir, fwd);
  const thetaC = Math.acos(Math.max(-1, Math.min(1, zc)));
  if (thetaC - ang > (88 * Math.PI) / 180 || zc <= 0.02) return;
  const [cx, cy] = project(dir);
  const near = Math.max(0, thetaC - ang);
  const r = thetaC >= ang ? f * (Math.tan(thetaC) - Math.tan(near)) : f * (Math.tan(thetaC) + Math.tan(ang - thetaC));
  const rad = Math.max(1.5 * dpr, r);
  if (body.star) {
    drawStarGlow(g, cx, cy, rad, h, body.glow ?? '255, 255, 255');
    const disc = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    disc.addColorStop(0, body.colors[0]);
    disc.addColorStop(0.75, body.colors[1]);
    disc.addColorStop(1, body.colors[2]);
    g.fillStyle = disc;
    g.beginPath();
    g.arc(cx, cy, rad, 0, Math.PI * 2);
    g.fill();
    return;
  }
  // Lit planet: highlight toward the Sun, terminator on the far side.
  const sx = dot(SUN_DIR, right);
  const sy = -dot(SUN_DIR, upv);
  const sl = Math.hypot(sx, sy) || 1;
  const hx = cx + (sx / sl) * rad * 0.5;
  const hy = cy + (sy / sl) * rad * 0.5;
  if (body.glow) {
    // A thin limb glow: a few percent of the radius, but never thicker than a sliver of the screen.
    const thick = Math.min(rad * 0.05, h * 0.035);
    const atm = g.createRadialGradient(cx, cy, rad - thick * 0.3, cx, cy, rad + thick);
    atm.addColorStop(0, `rgba(${body.glow}, 0.6)`);
    atm.addColorStop(0.35, `rgba(${body.glow}, 0.28)`);
    atm.addColorStop(1, `rgba(${body.glow}, 0)`);
    g.fillStyle = atm;
    g.beginPath();
    g.arc(cx, cy, rad + thick, 0, Math.PI * 2);
    g.fill();
  }
  const shade = g.createRadialGradient(hx, hy, rad * 0.05, cx, cy, rad * 1.02);
  shade.addColorStop(0, body.colors[0]);
  shade.addColorStop(0.45, body.colors[1]);
  shade.addColorStop(1, body.colors[2]);
  g.save();
  g.beginPath();
  g.arc(cx, cy, rad, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = shade;
  g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  // Surface detail, sized to the visible part of the disc so close views keep a sensible scale.
  const x0 = Math.max(0, cx - rad);
  const x1 = Math.min(w, cx + rad);
  const y0 = Math.max(0, cy - rad);
  const y1 = Math.min(h, cy + rad);
  const span = Math.min(rad, Math.max(x1 - x0, y1 - y0) / 2);
  const det = seeded(body.radiusM | 0);
  if (body.detail === 'clouds') g.filter = `blur(${Math.max(1, span * 0.012).toFixed(1)}px)`;
  for (let i = 0; i < (body.detail === 'clouds' ? 80 : 140); i++) {
    const px = x0 + det() * (x1 - x0);
    const py = y0 + det() * (y1 - y0);
    const pr = span * (0.012 + det() * (body.detail === 'clouds' ? 0.11 : 0.05));
    if (body.detail === 'clouds') {
      g.fillStyle = `rgba(255, 255, 255, ${0.03 + det() * 0.09})`;
      g.beginPath();
      g.ellipse(px, py, pr * 2.6, pr * 0.5, det() * 0.5 - 0.25, 0, Math.PI * 2);
      g.fill();
    } else {
      g.strokeStyle = `rgba(0, 0, 0, ${0.08 + det() * 0.12})`;
      g.lineWidth = Math.max(1, pr * 0.18);
      g.beginPath();
      g.arc(px, py, pr, 0, Math.PI * 2);
      g.stroke();
    }
  }
  g.filter = 'none';
  const term = g.createLinearGradient(hx, hy, cx - (sx / sl) * rad, cy - (sy / sl) * rad);
  term.addColorStop(0, 'rgba(0, 0, 0, 0)');
  term.addColorStop(0.62, 'rgba(0, 0, 0, 0.25)');
  term.addColorStop(1, 'rgba(0, 0, 0, 0.85)');
  g.fillStyle = term;
  g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  g.restore();
}

function drawStarGlow(g: CanvasRenderingContext2D, x: number, y: number, r: number, h: number, rgb: string): void {
  const R = Math.max(r * 6, h * 0.28);
  const glow = g.createRadialGradient(x, y, 0, x, y, R);
  glow.addColorStop(0, `rgba(${rgb}, 0.9)`);
  glow.addColorStop(0.08, `rgba(${rgb}, 0.35)`);
  glow.addColorStop(0.35, `rgba(${rgb}, 0.07)`);
  glow.addColorStop(1, `rgba(${rgb}, 0)`);
  g.fillStyle = glow;
  g.fillRect(x - R, y - R, R * 2, R * 2);
  g.strokeStyle = `rgba(${rgb}, 0.22)`;
  g.lineWidth = Math.max(1, r * 0.08);
  for (const a of [0, Math.PI / 2]) {
    g.beginPath();
    g.moveTo(x - Math.cos(a) * R * 0.8, y - Math.sin(a) * R * 0.8);
    g.lineTo(x + Math.cos(a) * R * 0.8, y + Math.sin(a) * R * 0.8);
    g.stroke();
  }
}

// --- DOM lab ----------------------------------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function domLab(): void {
  document.getElementById('boot')?.remove();
  canvas.setAttribute('aria-label', t('share.demo.standIn'));

  const settings = new Settings();
  const ts = Number(params.get('textScale'));
  if (ts) settings.set({ textScale: ts });
  const cb = params.get('colorblind');
  if (cb && (COLORBLIND_MODES as readonly string[]).includes(cb)) settings.set({ colorblind: cb as ColorblindMode });
  if (params.get('reducedMotion') === '1') settings.set({ reducedMotion: true });
  settings.applyToDocument();
  const input = new InputManager(canvas, settings);
  const panel = new SettingsPanel(settings, input);
  // Sound captions, as in the game (screenshot mode keeps them on screen, above the caption preview).
  const captions = new Captions(settings);

  let state = place('leo');
  let selected = 'leo';
  const known = (id: string): boolean => id in BODIES || id === 'ism';
  const captionInput = (): CaptionInput => {
    const b = BODIES[state.anchor];
    const dist = Math.hypot(...state.offset);
    // Planets: the Sun at the body's stand-in distance. Stars: the star itself. Interstellar: the Sun at |offset|.
    const starDist = b ? (b.star ? dist : (b.sunDistM ?? 1.496e11)) : dist;
    return {
      nearName: b ? bodyName(state.anchor) : bodyName('10'),
      nearIsStar: !b || b.star,
      altitudeM: b ? dist - b.radiusM : dist,
      starName: bodyName(b?.star ? state.anchor : '10'),
      starDistanceM: starDist,
      utcMs: state.timeMs,
    };
  };

  const host: ShareHost = {
    currentState: () => makeShareState({ anchor: state.anchor, offset: { x: state.offset[0], y: state.offset[1], z: state.offset[2] } }, { x: state.quat[0], y: state.quat[1], z: state.quat[2], w: state.quat[3] }, state.timeMs, { target: state.target, mode: state.mode, fovDeg: 60 }),
    applyState: (s: ShareState): ApplyResult => {
      if (!known(s.anchor)) return 'unknown-place';
      const timeMs = Math.min(WINDOW[1], Math.max(WINDOW[0], s.timeMs));
      state = { anchor: s.anchor, offset: [...s.offset], quat: [...s.quat], timeMs, target: s.target && known(s.target) ? s.target : null, mode: s.mode ?? 'thrusters' };
      selected = '';
      render();
      return timeMs === s.timeMs ? 'ok' : 'time-adjusted';
    },
    captureFrame: () => {
      drawView(canvas, state);
      return canvas.toDataURL('image/png');
    },
    caption: () => captionFor(captionInput()),
    placeName: () => captionPlaceName(captionInput()),
    setScreenshotMode: (active) => {
      if (active) input.releasePointerLock();
      document.body.dataset['mode'] = active ? 'screenshot' : 'flight';
    },
  };
  const share = new ShareController({ host, input, reducedMotion: () => settings.data.reducedMotion });

  // Stand-in HUD using the game's HUD classes (screenshot mode must hide it).
  const hud = el('div', 'ks-hud');
  hud.innerHTML = `
    <div class="ks-reticle"><svg viewBox="-20 -20 40 40"><circle r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M-16 0 H-7 M7 0 H16 M0 -16 V-7 M0 7 V16" stroke="currentColor" stroke-width="1.2" fill="none"/></svg></div>
    <div class="ks-hud-panel ks-hud-top"><div class="ks-mode"></div><div class="ks-speed">0 m/s<span class="ks-sub">${t('hud.speedRef.surface')}</span></div><div class="ks-throttle"><div class="ks-throttle-fill" style="width:35%"></div></div></div>
    <div class="ks-hud-panel ks-hud-right"><div class="k">${t('hud.near')}</div><div class="v ks-near"></div><div class="k">${t('hud.target')}</div><div class="v ks-target-name"></div></div>
    <div class="ks-hud-footer"></div>`;
  document.body.append(hud);

  // Lab panel (hidden in screenshot mode through data-ks-hide-in-screenshot).
  const lab = document.getElementById('lab')!;
  const intro = el('section', 'lab-panel lab-intro');
  intro.dataset['ksHideInScreenshot'] = '';
  intro.setAttribute('aria-labelledby', 'lab-title');
  const h1 = el('h1', '', t('share.demo.title'));
  h1.id = 'lab-title';
  intro.append(h1, el('p', '', t('share.demo.lede')));

  intro.append(el('h2', 'lab-h', t('share.demo.places')));
  const places = el('div', 'lab-places');
  places.setAttribute('role', 'group');
  places.setAttribute('aria-label', t('share.demo.places'));
  const placeButtons = new Map<string, HTMLButtonElement>();
  for (const p of ['leo', 'moon', 'mars', 'proxima', 'deep']) {
    const b = el('button', 'ks-btn', t(`share.demo.place.${p}`));
    b.type = 'button';
    b.dataset['place'] = p;
    b.addEventListener('click', () => setPlace(p));
    placeButtons.set(p, b);
    places.append(b);
  }
  intro.append(places);

  intro.append(el('h2', 'lab-h', t('share.demo.actions')));
  const actions = el('div', 'lab-actions');
  const actionButton = (label: string, action: ActionId, run: () => void): HTMLButtonElement => {
    const b = el('button', 'ks-btn');
    b.type = 'button';
    b.dataset['action'] = action;
    b.append(el('span', '', label), el('kbd', 'ks-kbd'));
    b.addEventListener('click', run);
    return b;
  };
  const copyBtn = actionButton(t('share.demo.copy'), 'share', () => void share.copyLink().then(render));
  const shotBtn = actionButton(t('share.demo.shot'), 'screenshot', () => share.screenshot.enter());
  actions.append(copyBtn, shotBtn);
  intro.append(actions);

  intro.append(el('h2', 'lab-h', t('share.demo.link')));
  const linkRow = el('div', 'lab-link');
  const linkField = el('input');
  linkField.readOnly = true;
  linkField.setAttribute('aria-label', t('share.demo.link'));
  const openBtn = el('button', 'ks-btn', t('share.demo.open'));
  openBtn.type = 'button';
  openBtn.addEventListener('click', () => {
    location.hash = new URL(linkField.value).hash;
  });
  linkRow.append(linkField, openBtn);
  intro.append(linkRow);

  intro.append(el('h2', 'lab-h', t('share.demo.view')));
  const dl = el('dl', 'lab-state');
  const row = (key: string): HTMLElement => {
    const dd = el('dd');
    dl.append(el('dt', '', t(key)), dd);
    return dd;
  };
  const ddAnchor = row('share.demo.anchor');
  const ddOffset = row('share.demo.offset');
  const ddQuat = row('share.demo.quat');
  const ddTime = row('share.demo.time');
  intro.append(dl, el('p', 'lab-note', t('share.demo.standIn')));
  lab.append(intro);

  const keyOf = (a: ActionId): string => bindingLabel(input.binding(a, 0, input.activeDevice) ?? input.binding(a, 1, input.activeDevice));

  function render(): void {
    drawView(canvas, state);
    for (const [p, b] of placeButtons) b.setAttribute('aria-pressed', String(p === selected));
    copyBtn.querySelector('kbd')!.textContent = keyOf('share');
    shotBtn.querySelector('kbd')!.textContent = keyOf('screenshot');
    linkField.value = share.link() ?? '';
    ddAnchor.textContent = `${state.anchor} · ${bodyName(state.anchor)}`;
    ddOffset.textContent = state.offset.map((v) => String(v)).join(', ');
    ddQuat.textContent = state.quat.map((v) => v.toFixed(6)).join(', ');
    ddTime.textContent = `${formatUtc(state.timeMs)} UTC`;
    hud.querySelector('.ks-mode')!.textContent = t(`hud.mode.${state.mode}`);
    hud.querySelector('.ks-near')!.textContent = bodyName(state.anchor);
    hud.querySelector('.ks-target-name')!.textContent = state.target ? bodyName(state.target) : '—';
    hud.querySelector('.ks-hud-footer')!.textContent = `${formatUtc(state.timeMs)} UTC`;
  }

  function setPlace(p: string): void {
    state = place(p);
    selected = p;
    render();
  }

  addEventListener('resize', render);
  settings.onChange(() => render());
  render();

  let outcome: string | null = null;
  const boot = share.applyFragment(location.hash).then((o) => {
    outcome = o;
    render();
    return o;
  });

  // Frame loop: the same order as the game's App.tick with the share hook (docs/SHARE.md).
  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
    last = now;
    input.update(dt);
    const consumed = share.update();
    if (!consumed && !panel.isOpen && input.justPressed('pause')) panel.open();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  addEventListener('hashchange', () => render());

  (window as unknown as { __ks: unknown }).__ks = {
    share,
    settings,
    input,
    panel,
    captions,
    boot,
    outcome: () => outcome,
    state: () => structuredClone(state),
    setPlace,
    encode: (s: ShareState) => encodeShare(s),
    decode: (f: string) => decodeShare(f),
    parse: (f: string) => parseShare(f),
    isShareId,
    pngLink: (bytes: number[]) => findShareInPng(Uint8Array.from(bytes)),
    pngText: (bytes: number[]) => readPngText(Uint8Array.from(bytes)),
    rawFrame: () => host.captureFrame(),
  };
}

domLab();
