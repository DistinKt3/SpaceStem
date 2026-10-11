/**
 * Guided opening lab (onboarding.html): the Onboarding card driven by a simulated ship, over the real HUD layout and
 * the real Settings + InputManager, so every key the card names is the player's own binding. Fly with the bindings,
 * or fake each condition with the lab buttons. Exposes window.__ks for tests/e2e/onboarding.spec.ts.
 *
 * URL parameters: reset=1 (forget tour and settings), fast=1 (short delays, for tests), step=<id> (resume at a
 * step), textScale=<0.8..2>, colorblind=<mode>, reduced=1, cockpit=0, lab=0, pad=1, backdrop=cockpit (the cockpit
 * screenshot from docs/media behind the card, to check it clears the cockpit displays).
 *
 * The simulation is deliberately crude (distances shrink at the drive's governed speed); it only has to produce the
 * snapshot fields the tour reads. It is not the flight model (src/game/ship/ship.ts).
 */
import '../game/styles.css';
import '../game/ui/ui.css';
import '../game/hud/hud.css';
import '../game/map/map.css';
import * as THREE from 'three/webgpu';
import { AU_M } from '../core/constants';
import { Vec3d } from '../core/vec3d';
import { formatDistance } from '../game/format';
import { Hud, type HudState } from '../game/hud/hud';
import { t } from '../game/i18n';
import { InputManager } from '../game/input/inputManager';
import { COLORBLIND_MODES, Settings, type ColorblindMode } from '../game/settings/settings';
import { Captions } from '../game/ui/captions';
import { SettingsPanel } from '../game/ui/settingsPanel';
import { Onboarding, actionLabel, ONBOARDING_STORAGE_KEY, STEP_IDS, type OnboardingSnapshot, type TourTiming } from '../game/onboarding/onboarding';

const params = new URLSearchParams(location.search);
const storage = ((): Storage | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
})();
if (params.get('reset') === '1') {
  try {
    storage?.removeItem(ONBOARDING_STORAGE_KEY);
    storage?.removeItem('knownsky.settings');
  } catch {
    // Storage blocked: nothing to reset.
  }
}
const resumeAt = params.get('step');
if (resumeAt && (STEP_IDS as readonly string[]).includes(resumeAt)) {
  try {
    storage?.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ v: 1, status: 'active', step: resumeAt, collapsed: false }));
  } catch {
    // Storage blocked: the tour starts at the beginning.
  }
}

const settings = new Settings();
const ts = Number(params.get('textScale'));
if (ts) settings.set({ textScale: ts });
const cb = params.get('colorblind');
if (cb && (COLORBLIND_MODES as readonly string[]).includes(cb)) settings.set({ colorblind: cb as ColorblindMode });
if (params.get('reduced') === '1') settings.set({ reducedMotion: true });
settings.applyToDocument();
if (params.get('cockpit') === '0') document.body.classList.remove('ks-cockpit-on');

const sky = document.getElementById('sky') as HTMLCanvasElement;
const input = new InputManager(sky, settings);
if (params.get('pad') === '1') input.activeDevice = 'pad';
const panel = new SettingsPanel(settings, input);
const captions = new Captions(settings);
const hud = new Hud(document.body);
const camera = new THREE.PerspectiveCamera(settings.data.fovDeg, innerWidth / innerHeight, 0.1, 1e12);

const backdrop = params.get('backdrop') === 'cockpit';
if (backdrop) {
  const img = document.getElementById('backdrop') as HTMLImageElement;
  img.src = '/docs/media/cockpit_sun_side.jpg';
  img.hidden = false;
}

// --- Simulated ship ---------------------------------------------------------------------------------------------------

/** Moon surface distance from the opening orbit (m): mean distance less both radii and the 420 km altitude. */
const MOON_START_M = 3.844e8 - 6.371e6 - 1.7374e6 - 4.2e5;
const MOON_RADIUS_M = 1.7374e6;
const TARGETS = [
  { id: '301', key: 'moon', kind: 'moon', name: () => t('body.moon') },
  { id: '499', key: 'mars', kind: 'planet', name: () => t('body.mars') },
  { id: '399', key: 'earth', kind: 'planet', name: () => t('body.earth') },
] as const;
const STARS = [
  { id: '*1', name: () => t('onboarding.demo.star.proxima'), ly: 4.24 },
  { id: '*2', name: () => t('onboarding.demo.star.sirius'), ly: 8.6 },
  { id: '*3', name: () => t('onboarding.demo.star.vega'), ly: 25 },
] as const;

interface SimTarget {
  id: string;
  kind: string;
  name: string;
}

class Sim {
  time = 0;
  mode: OnboardingSnapshot['mode'] = 'thrusters';
  throttle = 0;
  speed = 0;
  /** Height above Earth and distance to the Moon's surface (m). */
  earthAlt = 4.2e5;
  moonDist = MOON_START_M;
  landed = false;
  target: SimTarget | null = { id: '301', kind: 'moon', name: t('body.moon') };
  aligned = false;
  autoAlign = false;
  private alignTimer = 0;
  mapOpen = false;
  hyperPhase: OnboardingSnapshot['hyperPhase'] = 'idle';
  private hyperTimer = 0;
  anchor = '399';
  looked = 0;

  get nearKey(): string {
    if (this.anchor.startsWith('*')) return `star-${this.anchor.slice(1)}`;
    return this.moonDist < this.earthAlt ? 'moon' : 'earth';
  }

  get altitude(): number {
    if (this.anchor.startsWith('*')) return 1.5 * AU_M;
    return Math.min(this.earthAlt, this.moonDist);
  }

  targetDistance(): number | null {
    const tg = this.target;
    if (!tg) return null;
    if (tg.id === '301') return this.moonDist;
    if (tg.id === '399') return this.earthAlt;
    if (tg.id === '499') return 7.8e10;
    const star = STARS.find((s) => s.id === tg.id);
    return star ? star.ly * 9.4607e15 : null;
  }

  snapshot(): OnboardingSnapshot {
    return {
      t: this.time,
      mode: this.mode,
      throttle: this.throttle,
      speed: this.speed,
      nearKey: this.nearKey,
      altitudeM: this.altitude,
      landed: this.landed,
      targetId: this.target?.id ?? null,
      targetKind: this.target?.kind ?? null,
      targetDistanceM: this.targetDistance(),
      alignedToTarget: this.aligned,
      mapOpen: this.mapOpen,
      codexOpen: false,
      hyperPhase: this.hyperPhase,
      anchor: this.anchor,
      lookedAroundRad: this.looked,
    };
  }

  setTarget(tg: SimTarget | null): void {
    if (tg?.id !== this.target?.id) this.aligned = false;
    this.target = tg;
  }

  cycleTarget(dir: 1 | -1): void {
    const list: SimTarget[] = TARGETS.map((x) => ({ id: x.id, kind: x.kind, name: x.name() }));
    if (this.target?.kind === 'star') list.push(this.target);
    const i = list.findIndex((x) => x.id === this.target?.id);
    this.setTarget(list[(i + dir + list.length) % list.length] ?? null);
  }

  /** Steering away breaks alignment. */
  steer(rad: number): void {
    this.looked += rad;
    if (rad > 0.02 && !this.autoAlign) this.aligned = false;
  }

  nextMode(dir: 1 | -1): void {
    if (this.landed || this.hyperPhase !== 'idle') return;
    const modes = ['thrusters', 'impulse', 'cruise'] as const;
    const i = Math.max(0, modes.indexOf(this.mode as (typeof modes)[number]));
    this.mode = modes[(i + dir + modes.length) % modes.length]!;
  }

  engage(): string | null {
    if (this.hyperPhase !== 'idle') return 'hyper.error.busy';
    if (!this.target) return 'hyper.error.noTarget';
    if (this.target.kind !== 'star') return 'hyper.error.notStar';
    if (this.landed) return 'hyper.error.landed';
    if (this.altitude < 1e7 && !this.anchor.startsWith('*')) return 'hyper.error.gravityWell';
    this.hyperPhase = 'spool';
    this.hyperTimer = 0;
    return null;
  }

  update(dt: number, ctl: { strafeY: number }): void {
    this.time += dt;
    if (this.autoAlign && !this.aligned && this.target) {
      this.alignTimer += dt;
      if (this.alignTimer > 1.2) {
        this.aligned = true;
        this.alignTimer = 0;
      }
    }
    if (this.hyperPhase !== 'idle') {
      this.hyperTimer += dt;
      if (this.hyperPhase === 'spool' && this.hyperTimer > 3) {
        this.hyperPhase = 'jump';
        this.mode = 'hyperspeed';
        this.hyperTimer = 0;
        this.anchor = 'ism';
      } else if (this.hyperPhase === 'jump' && this.hyperTimer > 8) {
        this.hyperPhase = 'idle';
        this.mode = 'cruise';
        this.throttle = 0;
        this.anchor = this.target?.id ?? '*1';
      }
      this.speed = this.hyperPhase === 'jump' ? 1e6 * 299_792_458 : 0;
      return;
    }
    if (this.landed) {
      this.speed = 0;
      if (ctl.strafeY > 0.2 || this.throttle > 0.2) {
        this.landed = false;
        this.moonDist = 3;
      }
      return;
    }
    // Speed along the nose: thrusters up to 3 km/s, the drives governed by distance to the nearest surface.
    const k = this.mode === 'impulse' ? 0.6 : 0.9;
    this.speed = this.mode === 'thrusters' ? this.throttle * 3000 : this.throttle * Math.max(2000, k * this.altitude);
    if (this.aligned && this.target?.id === '301' && !this.anchor.startsWith('*')) {
      const step = Math.min(this.speed * dt, this.moonDist - 2.5);
      this.moonDist -= step;
      this.earthAlt += step;
    } else if (this.speed > 0) {
      this.earthAlt += this.speed * dt * 0.3;
    }
    // The drives drop to thrusters near a surface; thrusters descend with strafe and touch down below 3 m.
    if (this.mode !== 'thrusters' && this.moonDist < 2e4) {
      this.mode = 'thrusters';
      this.throttle = 0;
    }
    if (this.mode === 'thrusters' && this.nearKey === 'moon' && ctl.strafeY < -0.2) {
      this.moonDist = Math.max(2.5, this.moonDist - Math.max(4, this.moonDist * 0.6) * dt);
      if (this.moonDist <= 3) this.landed = true;
    }
  }
}

const sim = new Sim();

// --- Tour --------------------------------------------------------------------------------------------------------------

const FAST: Partial<TourTiming> = { minDwell: 0.3, hold: 0.05, grace: 0.35, doneLinger: 4 };
const onboarding = new Onboarding({
  parent: document.body,
  labelFor: (a) => actionLabel(settings.data, input.activeDevice, a),
  reducedMotion: () => settings.data.reducedMotion,
  onStepChange: (id) => {
    stepLog.push(id);
  },
  ...(params.get('fast') === '1' ? { timing: FAST } : {}),
});
const stepLog: string[] = [];

// --- Sky ---------------------------------------------------------------------------------------------------------------

function project(rel: Vec3d): [number, number] | null {
  const v = new THREE.Vector3(rel.x, rel.y, rel.z).applyQuaternion(camera.quaternion.clone().invert());
  if (v.z >= 0) return null;
  v.applyMatrix4(camera.projectionMatrix);
  return [((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight];
}

/** Direction to the target in camera axes: dead ahead when aligned, otherwise up and to the right. */
function targetRel(): Vec3d {
  const d = sim.targetDistance() ?? 1e9;
  const r = (sim.target?.id === '301' ? MOON_RADIUS_M : 0) + d;
  const dir = sim.aligned ? new Vec3d(0, 0, -1) : new Vec3d(0.42, 0.2, -1).normalize();
  return dir.scale(r);
}

/** Static star layer, rebuilt on resize (deterministic LCG; presentation only). */
let starLayer: HTMLCanvasElement | null = null;
function buildStars(w: number, h: number, dpr: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#02040a';
  g.fillRect(0, 0, w, h);
  const neb = g.createRadialGradient(w * 0.68, h * 0.3, 0, w * 0.68, h * 0.3, Math.max(w, h) * 0.6);
  neb.addColorStop(0, 'rgba(90, 120, 200, 0.16)');
  neb.addColorStop(0.5, 'rgba(120, 70, 160, 0.06)');
  neb.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = neb;
  g.fillRect(0, 0, w, h);
  let s = 0x2f6b9a1d;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const n = Math.round((w * h) / 1100);
  for (let i = 0; i < n; i++) {
    const m = rnd() ** 3;
    g.fillStyle = `rgba(${200 + rnd() * 55}, ${210 + rnd() * 45}, 255, ${0.2 + m * 0.75})`;
    g.beginPath();
    g.arc(rnd() * w, rnd() * h, 0.35 + m * 1.2, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

function drawSky(): void {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = innerWidth;
  const h = innerHeight;
  if (!starLayer || sky.width !== Math.round(w * dpr) || sky.height !== Math.round(h * dpr)) {
    sky.width = Math.round(w * dpr);
    sky.height = Math.round(h * dpr);
    starLayer = buildStars(w, h, dpr);
  }
  const g = sky.getContext('2d');
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  // With the cockpit screenshot behind the page, the canvas stays clear.
  if (backdrop) {
    g.clearRect(0, 0, sky.width, sky.height);
    return;
  }
  g.drawImage(starLayer, 0, 0);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (sim.anchor === '399' || sim.anchor === '301') {
    // Earth's limb in the lower part of the view, sinking as the ship climbs away.
    const R = Math.max(w, h) * 1.6;
    const horizon = h * (0.62 + 0.38 * Math.min(1, Math.log10(Math.max(1, sim.earthAlt / 4.2e5)) / 3));
    const cx = w * 0.42;
    const cy = horizon + R;
    const body = g.createLinearGradient(0, horizon, 0, h);
    body.addColorStop(0, '#4a86c4');
    body.addColorStop(0.12, '#21548f');
    body.addColorStop(0.5, '#0f2f5c');
    body.addColorStop(1, '#081a36');
    g.fillStyle = body;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();
    // A thin atmosphere ring: transparent inside the limb, brightest at it, fading outward.
    const atm = g.createRadialGradient(cx, cy, R * 0.985, cx, cy, R * 1.012);
    atm.addColorStop(0, 'rgba(150, 205, 255, 0)');
    atm.addColorStop(0.55, 'rgba(150, 205, 255, 0.55)');
    atm.addColorStop(1, 'rgba(150, 205, 255, 0)');
    g.fillStyle = atm;
    g.beginPath();
    g.arc(cx, cy, R * 1.012, 0, Math.PI * 2);
    g.fill();
  }
  // The Moon where the HUD bracket is.
  if (sim.target?.id === '301' && !sim.anchor.startsWith('*')) {
    const p = project(targetRel());
    if (p) {
      const d = sim.moonDist + MOON_RADIUS_M;
      const ang = Math.asin(Math.min(1, MOON_RADIUS_M / d));
      const px = Math.max(2.5, Math.min(h * 2, (ang / ((camera.fov * Math.PI) / 180)) * h));
      const moon = g.createRadialGradient(p[0] - px * 0.35, p[1] - px * 0.3, px * 0.1, p[0], p[1], px);
      moon.addColorStop(0, '#f2efe6');
      moon.addColorStop(0.7, '#b9b4a8');
      moon.addColorStop(1, '#6e6a62');
      g.fillStyle = moon;
      g.beginPath();
      g.arc(p[0], p[1], px, 0, Math.PI * 2);
      g.fill();
    }
  }
}

// --- Fake map (same structure and classes as src/game/map/mapView.ts, so the layout matches) -------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const map = el('div', 'ks-map');
map.hidden = true;
const mapTitle = el('div', 'ks-map-title');
const mapList = el('div', 'ks-map-list');
map.append(mapTitle, mapList);
document.body.append(map);
let mapMode: 'system' | 'stars' = 'system';

function renderMap(): void {
  mapTitle.replaceChildren(el('strong', '', t(mapMode === 'system' ? 'map.systemTitle' : 'map.starsTitle')), el('span', '', t('onboarding.demo.mapNote')));
  const modeBtn = el('button', 'ks-map-mode', t(mapMode === 'system' ? 'map.showStars' : 'map.showSystem'));
  modeBtn.type = 'button';
  modeBtn.addEventListener('click', () => {
    mapMode = mapMode === 'system' ? 'stars' : 'system';
    renderMap();
  });
  const entries: SimTarget[] =
    mapMode === 'system' ? TARGETS.map((x) => ({ id: x.id, kind: x.kind, name: x.name() })) : STARS.map((s) => ({ id: s.id, kind: 'star', name: s.name() }));
  const buttons = entries.map((e) => {
    const b = el('button', 'ks-map-entry');
    b.type = 'button';
    b.dataset['id'] = e.id;
    b.setAttribute('aria-selected', String(sim.target?.id === e.id));
    b.append(el('span', '', e.name));
    b.addEventListener('click', () => {
      sim.setTarget(e);
      renderMap();
    });
    return b;
  });
  mapList.replaceChildren(modeBtn, ...buttons);
}

function setMap(open: boolean): void {
  sim.mapOpen = open;
  map.hidden = !open;
  document.body.classList.toggle('ks-map-open', open);
  if (open) {
    input.releasePointerLock();
    renderMap();
  }
}

// --- Lab panel -----------------------------------------------------------------------------------------------------------

const lab = el('section', 'lab');
lab.setAttribute('aria-labelledby', 'lab-title');
const h1 = el('h1', '', t('onboarding.demo.title'));
h1.id = 'lab-title';
lab.append(h1, el('p', '', t('onboarding.demo.lede')), el('h2', '', t('onboarding.demo.simulate')));
const grid = el('div', 'lab-grid');
const fake: Record<string, () => void> = {
  look: () => sim.steer(0.6),
  throttle: () => (sim.throttle = 0.5),
  targetMoon: () => sim.setTarget({ id: '301', kind: 'moon', name: t('body.moon') }),
  targetOther: () => sim.setTarget({ id: '499', kind: 'planet', name: t('body.mars') }),
  align: () => (sim.aligned = true),
  cruise: () => (sim.mode = 'cruise'),
  nearMoon: () => {
    sim.moonDist = 1.5e7;
    sim.earthAlt = MOON_START_M - 1.5e7;
  },
  land: () => {
    sim.moonDist = 2.5;
    sim.mode = 'thrusters';
    sim.throttle = 0;
    sim.landed = true;
  },
  leaveMoon: () => {
    sim.landed = false;
    sim.moonDist = 4e7;
  },
  map: () => setMap(!sim.mapOpen),
  targetStar: () => sim.setTarget({ id: '*1', kind: 'star', name: t('onboarding.demo.star.proxima') }),
  hyper: () => {
    const err = sim.engage();
    if (err) flash(err);
  },
};
for (const [key, fn] of Object.entries(fake)) {
  const b = el('button', 'ks-btn', t(`onboarding.demo.${key}`));
  b.type = 'button';
  b.dataset['fake'] = key;
  b.addEventListener('click', (e) => {
    fn();
    if (e.detail > 0) b.blur();
  });
  grid.append(b);
}
lab.append(grid, el('h2', '', t('onboarding.demo.tour')));
const tourRow = el('div', 'lab-row');
const restart = el('button', 'ks-btn', t('onboarding.demo.restart'));
restart.type = 'button';
restart.id = 'lab-restart';
restart.addEventListener('click', () => {
  onboarding.reset();
  onboarding.start();
});
const forget = el('button', 'ks-btn ks-btn-quiet', t('onboarding.demo.reset'));
forget.type = 'button';
forget.id = 'lab-forget';
forget.addEventListener('click', () => onboarding.reset());
const cockpitBox = el('input', '');
cockpitBox.type = 'checkbox';
cockpitBox.checked = document.body.classList.contains('ks-cockpit-on');
cockpitBox.addEventListener('change', () => document.body.classList.toggle('ks-cockpit-on', cockpitBox.checked));
const cockpitLabel = el('label', '');
cockpitLabel.append(cockpitBox, document.createTextNode(t('onboarding.demo.cockpit')));
const padBox = el('input', '');
padBox.type = 'checkbox';
padBox.checked = input.activeDevice === 'pad';
padBox.addEventListener('change', () => (input.activeDevice = padBox.checked ? 'pad' : 'kbm'));
const padLabel = el('label', '');
padLabel.append(padBox, document.createTextNode(t('onboarding.demo.pad')));
const hideLab = el('button', 'ks-btn ks-btn-quiet', t('onboarding.demo.hide'));
hideLab.type = 'button';
tourRow.append(restart, forget, cockpitLabel, padLabel, hideLab);
lab.append(tourRow);
const state = el('div', 'lab-state');
state.setAttribute('aria-live', 'off');
lab.append(state);
document.body.append(lab);
const showLab = el('button', 'ks-btn lab-show', t('onboarding.demo.title'));
showLab.type = 'button';
showLab.hidden = true;
document.body.append(showLab);
hideLab.addEventListener('click', () => {
  lab.hidden = true;
  showLab.hidden = false;
});
showLab.addEventListener('click', () => {
  lab.hidden = false;
  showLab.hidden = true;
});
if (params.get('lab') === '0') {
  lab.hidden = true;
  showLab.hidden = true;
}

let message: { key: string; until: number } | null = null;
function flash(key: string): void {
  message = { key, until: performance.now() + 3000 };
}

// --- Loop --------------------------------------------------------------------------------------------------------------

function hudState(): HudState {
  const tg = sim.target;
  const dist = sim.targetDistance();
  return {
    mode: sim.mode,
    throttle: sim.throttle,
    speed: sim.speed,
    speedLabel: sim.mode === 'thrusters' ? 'surface' : 'drive',
    etaOverride: null,
    governorSpeed: Math.max(2000, 0.9 * sim.altitude),
    altitude: sim.altitude,
    verticalSpeed: 0,
    nearName: sim.nearKey.startsWith('star-') ? (STARS.find((s) => s.id === sim.anchor)?.name() ?? '') : t(`body.${sim.nearKey}`),
    flightAssist: true,
    landed: sim.landed,
    velocityDir: null,
    target: tg && dist !== null ? { id: tg.id, name: tg.name, rel: targetRel(), radius: tg.id === '301' ? MOON_RADIUS_M : 0, provenance: 'measured', kind: tg.kind } : null,
    labels: [],
    utc: `${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    sunDistance: AU_M,
    sunName: t('body.sun'),
    warnings: message && performance.now() < message.until ? [t(message.key)] : [],
    footer: '',
  };
}

let last = performance.now();
let labTimer = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  input.update(dt);
  if (!panel.isOpen) {
    if (input.justPressed('pause')) {
      if (sim.mapOpen) setMap(false);
      else panel.open();
    }
    if (input.justPressed('toggleMap')) setMap(!sim.mapOpen);
  }
  const playing = !panel.isOpen && !sim.mapOpen;
  if (playing) {
    const m = input.mouseDelta();
    const look = input.held('headLook');
    const steer = Math.hypot(input.axis('pitch'), input.axis('yaw')) * 1.1 * dt + (look ? 0 : Math.hypot(m.x, m.y) * 0.02 * 1.1 * dt);
    sim.steer(steer + (look ? Math.hypot(m.x, m.y) * 0.003 : 0));
    const steps = input.pressCount('throttleUp') - input.pressCount('throttleDown');
    sim.throttle = Math.max(sim.mode === 'thrusters' ? -0.5 : 0, Math.min(1, sim.throttle + steps * 0.05 + input.axis('thrust') * dt * 0.6));
    if (input.justPressed('throttleZero')) sim.throttle = 0;
    if (input.justPressed('modeNext')) sim.nextMode(1);
    if (input.justPressed('modePrev')) sim.nextMode(-1);
    if (input.justPressed('targetNext')) sim.cycleTarget(1);
    if (input.justPressed('targetPrev')) sim.cycleTarget(-1);
    if (input.justPressed('targetReticle')) sim.setTarget({ id: '301', kind: 'moon', name: t('body.moon') });
    if (input.justPressed('autoAlign')) sim.autoAlign = !sim.autoAlign;
    if (input.justPressed('hyperspeed')) {
      const err = sim.engage();
      if (err) flash(err);
    }
    if (input.justPressed('toggleHud')) {
      hud.setVisible(!hud.isVisible);
      onboarding.setVisible(hud.isVisible);
    }
  }
  if (!panel.isOpen) {
    sim.update(dt, { strafeY: playing ? input.axis('strafeY') : 0 });
    onboarding.update(dt, sim.snapshot());
  }
  camera.fov = settings.data.fovDeg;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  drawSky();
  hud.update(hudState(), camera);
  labTimer -= dt;
  if (labTimer <= 0) {
    labTimer = 0.2;
    const dist = sim.targetDistance();
    state.replaceChildren(
      el(
        'div',
        '',
        t('onboarding.demo.state', {
          mode: t(`hud.mode.${sim.mode}`),
          throttle: Math.round(sim.throttle * 100),
          near: sim.landed ? t('onboarding.demo.landed') : t('hud.near'),
          alt: formatDistance(sim.altitude),
        }),
      ),
      el('div', '', sim.target && dist !== null ? t('onboarding.demo.target', { name: sim.target.name, dist: formatDistance(dist) }) : t('onboarding.demo.noTarget')),
      el('div', '', onboarding.stepId ? t('onboarding.demo.step', { step: onboarding.stepId }) : t('onboarding.demo.stepNone', { status: stepLog.at(-1) ?? '-' })),
    );
  }
  requestAnimationFrame(frame);
}

onboarding.start();
requestAnimationFrame(frame);

(window as unknown as { __ks: unknown }).__ks = { onboarding, settings, input, sim, panel, captions, hud, stepLog, setMap, t };
