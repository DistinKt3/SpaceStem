/**
 * Map view: a separate 3D scene drawn instead of the world while open.
 * - System map: the local star and planets, laid on the mean orbital plane, with osculating Kepler orbits from the
 *   ephemeris state vectors. Radial distances are compressed (r^0.4) so Mercury and Neptune fit on one screen;
 *   directions are true. The scale is labelled on screen.
 * - Star map: named catalogue stars within 50 light-years of the ship at true relative positions, oriented to the
 *   galactic plane, with distance rings and drop-lines to the plane for depth.
 * A keyboard-accessible list mirrors the clickable labels; choosing an entry sets the ship's target.
 *
 * Accessibility: the overlay is a modal dialog named by its title. While it is open it owns the keyboard and gamepad
 * (game input is disabled, as in the settings dialog): Tab cycles between the map switch and the destination list,
 * the arrow keys move through the list (a listbox with one tab stop), Enter or Space sets the target, Shift+arrows
 * orbit and + / − zoom. Gamepad: D-pad or left stick choose, A sets the target, LB/RB switch maps, the right stick
 * orbits, the triggers zoom. Escape, the Menu or B button, or the "toggle map" binding close it; focus then returns
 * to where it was. Colours come from CSS tokens (map.css), so the colour-blind and high-contrast palettes apply.
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Fn, uv, vec4, float, length, smoothstep, exp, uniform } from 'three/tsl';
import { AU_M, LIGHT_YEAR_M, PARSEC_M } from '../../core/constants';
import { Vec3d } from '../../core/vec3d';
import { keplerOrbit } from '../../world/kepler';
import type { App } from '../app';
import { formatDistance } from '../format';
import { bodyLabel, formatNumber, t } from '../i18n';
import { PAD, type ActionId } from '../input/actions';
import type { Binding, InputContext } from '../input/bindings';
import { bindingLabel, inputLabel } from '../input/labels';
import { GamepadMenuNav, type NavCommand } from '../input/menuNav';
import { fitDistance, freeArea, keyCamera, keyTriggers, listStep, mouseTriggers, overlaps, padCamera, padHolds, type Box, type PadLike } from './mapNav';

export type MapMode = 'system' | 'stars';

interface MapItem {
  id: string;
  name: string;
  pos: THREE.Vector3;
  detail: string;
  color: THREE.Color;
  size: number;
  /** Label priority: lower ranks get labels first when labels would overlap. */
  rank: number;
}

/** ICRS -> galactic rotation rows (Hipparcos convention), used to orient the star map on the galactic plane. */
const GAL = [
  [-0.054875560416215, -0.873437090234885, -0.483835015548713],
  [0.494109427875584, -0.444829629960011, 0.746982244497219],
  [-0.867666149019005, -0.198076373431202, 0.455983776175067],
] as const;
function toGalactic(v: Vec3d): THREE.Vector3 {
  // Galactic x toward the centre, y along rotation, z to the north galactic pole; map y-up = galactic z.
  const gx = GAL[0][0] * v.x + GAL[0][1] * v.y + GAL[0][2] * v.z;
  const gy = GAL[1][0] * v.x + GAL[1][1] * v.y + GAL[1][2] * v.z;
  const gz = GAL[2][0] * v.x + GAL[2][1] * v.y + GAL[2][2] * v.z;
  return new THREE.Vector3(gx, gz, -gy);
}

/** Star map radius (light-years). */
const MAP_RADIUS_LY = 50;

const compress = (rM: number): number => Math.pow(rM / AU_M, 0.4) * 10;

/** Scene colours: CSS tokens defined in map.css (overridden per colour-blind / high-contrast palette), with fallbacks. */
const TOKENS = {
  bg: ['--ks-bg', '#02040a'],
  orbit: ['--ks-map-orbit', '#4a86a8'],
  ring: ['--ks-map-ring', '#666b72'],
  drop: ['--ks-map-drop', '#182b39'],
  you: ['--ks-map-you', '#7dffb0'],
} as const;

function tokenColor(name: keyof typeof TOKENS, out = new THREE.Color()): THREE.Color {
  const [prop, fallback] = TOKENS[name];
  const css = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
  return out.setStyle(/^#[0-9a-f]{3,8}$|^rgb/i.test(css) ? css : fallback);
}

/**
 * One material for every dot, so the shader is built once for the map's lifetime. Each sprite supplies its own
 * colour (userData.color) through a per-object uniform.
 */
function createDotMaterial(): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const fallback = new THREE.Color(1, 1, 1);
  const c = uniform(new THREE.Color()).onObjectUpdate(({ object }) => (object?.userData['color'] as THREE.Color | undefined) ?? fallback);
  m.colorNode = Fn(() => {
    const r = length(uv().sub(0.5)).mul(2);
    const k = exp(r.mul(r).mul(-6)).add(smoothstep(float(1), float(0.6), r).mul(0.15));
    return vec4(c.mul(k).mul(1.6), k);
  })();
  m.sizeAttenuation = false;
  return m;
}

let instances = 0;

export class MapView {
  mode: MapMode = 'system';
  isOpen = false;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  private controls: OrbitControls | null = null;
  private items: MapItem[] = [];
  private readonly overlay: HTMLDivElement;
  /** The side panel: map switch, "you are here" and the destination listbox. */
  private readonly list: HTMLDivElement;
  private readonly modeBtn: HTMLButtonElement;
  private readonly here: HTMLParagraphElement;
  private readonly options: HTMLDivElement;
  private readonly labels: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly heading: HTMLHeadingElement;
  private readonly scale: HTMLParagraphElement;
  private readonly help: HTMLParagraphElement;
  /** Per item: its 3D label (null-free; the "you" label is not clickable) and its list option (null for "you"). */
  private labelEls: HTMLElement[] = [];
  private optionEls: (HTMLButtonElement | null)[] = [];
  /** Measured label sizes (CSS px, real text at the current text scale); empty until measured after a build. */
  private labelSize: { w: number; h: number }[] = [];
  private ringLabels: { pos: THREE.Vector3; text: string }[] = [];
  private ringEls: HTMLSpanElement[] = [];
  private ringSize: { w: number; h: number }[] = [];
  /** Shared for the map's lifetime (never per dot or per line): one shader build each. */
  private readonly dotMat = createDotMaterial();
  private readonly orbitMat = new THREE.LineBasicNodeMaterial({ color: 0xffffff });
  private readonly ringMat = new THREE.LineBasicNodeMaterial({ color: 0xffffff });
  private readonly dropMat = new THREE.LineBasicNodeMaterial({ color: 0xffffff });
  private readonly clearColor = new THREE.Color();
  private readonly youColor = new THREE.Color();
  private returnFocus: HTMLElement | null = null;
  private prevInputEnabled = true;
  private readonly nav = new GamepadMenuNav(() => this.pads());
  /** The "toggle map" pad input was held at the last poll (the press that opened the map must not close it). */
  private padToggleHeld = true;
  private device: InputContext = 'kbm';
  private lastRender = 0;
  /** Currently selected destination (highlighted; drawn with label priority). */
  selectedId: string | null = null;
  /** Supplies the current target when the map opens. */
  getSelected: (() => string | null) | null = null;
  onSelect: ((id: string) => void) | null = null;

  constructor(private readonly app: App) {
    const uid = `ks-map-${++instances}`;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] => {
      const e = document.createElement(tag);
      e.className = cls;
      return e;
    };
    this.overlay = el('div', 'ks-map');
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-labelledby', `${uid}-title`);
    this.overlay.setAttribute('aria-describedby', `${uid}-scale`);
    this.overlay.tabIndex = -1;
    this.title = el('div', 'ks-map-title');
    this.heading = el('h2', 'ks-map-heading');
    this.heading.id = `${uid}-title`;
    this.scale = el('p', 'ks-map-scale');
    this.scale.id = `${uid}-scale`;
    this.help = el('p', 'ks-map-help');
    this.title.append(this.heading, this.scale, this.help);
    // The 3D labels repeat the list for pointer users; assistive technology reads the list instead.
    this.labels = el('div', 'ks-map-labels');
    this.labels.setAttribute('aria-hidden', 'true');
    this.list = el('div', 'ks-map-list');
    this.modeBtn = el('button', 'ks-map-mode');
    this.modeBtn.type = 'button';
    this.modeBtn.addEventListener('click', () => {
      this.setMode(this.mode === 'system' ? 'stars' : 'system');
      this.modeBtn.focus();
    });
    this.here = el('p', 'ks-map-here');
    this.options = el('div', 'ks-map-options');
    this.options.setAttribute('role', 'listbox');
    this.options.setAttribute('aria-labelledby', `${uid}-dest`);
    const destLabel = el('h3', 'ks-sr-only');
    destLabel.id = `${uid}-dest`;
    destLabel.textContent = t('map.destinations');
    this.list.append(this.modeBtn, this.here, destLabel, this.options);
    this.overlay.append(this.labels, this.title, this.list);
    this.overlay.style.display = 'none';
    document.body.appendChild(this.overlay);
  }

  open(mode?: MapMode): void {
    const anchor = this.app.cam.pos.anchor;
    this.mode = mode ?? (anchor === 'ism' ? 'stars' : 'system');
    if (this.getSelected) this.selectedId = this.getSelected();
    if (!this.isOpen) {
      const active = document.activeElement;
      this.returnFocus = active instanceof HTMLElement && active !== document.body && !this.overlay.contains(active) ? active : null;
      // The map owns the keyboard and gamepad while open: the game's window-level input would otherwise cancel Tab,
      // Space and the arrow keys (they are flight bindings) and leave focus stuck.
      this.prevInputEnabled = this.app.input.enabled;
      this.app.input.enabled = false;
      window.addEventListener('keydown', this.onKeyDown, true);
      window.addEventListener('mousedown', this.onMouseDown, true);
      this.device = this.app.input.activeDevice;
      this.nav.reset();
      this.padToggleHeld = true;
      this.lastRender = performance.now();
    }
    this.isOpen = true;
    document.body.classList.add('ks-map-open');
    // Shown before building, so the list panel has a size for framing and labels can be measured.
    this.overlay.style.display = '';
    if (!this.controls) this.controls = new OrbitControls(this.camera, this.app.renderer.domElement);
    // Reduced motion: no inertia after a drag or zoom (settings cannot change while the map is open).
    this.controls.enableDamping = !this.app.reducedMotion;
    this.controls.enabled = true;
    this.build();
    this.focusInitial();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('mousedown', this.onMouseDown, true);
    document.body.classList.remove('ks-map-open');
    const hadFocus = this.overlay.contains(document.activeElement);
    this.overlay.style.display = 'none';
    if (this.controls) this.controls.enabled = false;
    this.app.input.enabled = this.prevInputEnabled;
    const rf = this.returnFocus;
    this.returnFocus = null;
    if (rf?.isConnected) rf.focus({ preventScroll: true });
    else if (hadFocus && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Releases GPU resources and DOM. The map cannot be used afterwards. */
  dispose(): void {
    this.close();
    this.clear();
    for (const m of [this.dotMat, this.orbitMat, this.ringMat, this.dropMat]) m.dispose();
    this.controls?.dispose();
    this.overlay.remove();
  }

  private setMode(mode: MapMode): void {
    this.mode = mode;
    this.build();
  }

  private clear(): void {
    for (const c of [...this.scene.children]) {
      this.scene.remove(c);
      // Materials are shared for the map's lifetime. Sprites use three's global quad geometry: never dispose it.
      if (c instanceof THREE.Line) (c.geometry as THREE.BufferGeometry).dispose();
      // Frees the renderer's per-object state (render objects, uniform buffers) for this object.
      c.dispose();
    }
    this.items = [];
    this.ringLabels = [];
  }

  private build(): void {
    this.clear();
    tokenColor('bg', this.clearColor);
    tokenColor('you', this.youColor);
    tokenColor('orbit', this.orbitMat.color);
    tokenColor('ring', this.ringMat.color);
    tokenColor('drop', this.dropMat.color);
    if (this.mode === 'system') this.buildSystem();
    else this.buildStars();
    // List and labels.
    this.options.replaceChildren();
    this.labels.replaceChildren();
    this.labelEls = [];
    this.optionEls = [];
    this.labelSize = [];
    this.ringSize = [];
    this.ringEls = this.ringLabels.map((r) => {
      const e = document.createElement('span');
      e.className = 'ks-map-ring';
      e.textContent = r.text;
      this.labels.appendChild(e);
      return e;
    });
    this.modeBtn.textContent = this.mode === 'system' ? t('map.showStars') : t('map.showSystem');
    for (const it of this.items) {
      const you = it.id === '';
      const sel = !you && it.id === this.selectedId;
      if (you) {
        // Where the ship is: information, not a destination (so not an option of the listbox).
        this.here.textContent = it.name;
        this.optionEls.push(null);
      } else {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ks-map-entry';
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(sel));
        b.tabIndex = -1;
        const n = document.createElement('span');
        n.className = 'n';
        n.textContent = it.name;
        b.appendChild(n);
        if (it.detail) {
          const d = document.createElement('span');
          d.className = 'd';
          d.textContent = it.detail;
          b.appendChild(d);
          b.setAttribute('aria-label', `${it.name}, ${it.detail}`);
        }
        b.addEventListener('click', () => this.select(it.id));
        this.options.appendChild(b);
        this.optionEls.push(b);
      }
      const lab = document.createElement(you ? 'span' : 'button');
      lab.className = 'ks-map-label';
      lab.textContent = it.name;
      if (lab instanceof HTMLButtonElement) {
        lab.type = 'button';
        lab.tabIndex = -1;
        lab.addEventListener('click', () => this.select(it.id));
      }
      if (you) lab.classList.add('you');
      if (sel) lab.classList.add('sel');
      this.labels.appendChild(lab);
      this.labelEls.push(lab);
    }
    this.here.hidden = !this.items.some((it) => it.id === '');
    this.updateRoving();
    this.heading.textContent = this.mode === 'system' ? t('map.systemTitle') : t('map.starsTitle');
    this.scale.textContent = this.mode === 'system' ? t('map.systemScale') : t('map.starsScale');
    this.renderHelp();
  }

  private bound(action: ActionId, ctx: InputContext): Binding | null {
    return this.app.input.binding(action, 0, ctx) ?? this.app.input.binding(action, 1, ctx);
  }

  /** Control hints for the device in use (they follow rebinding). */
  private renderHelp(): void {
    this.help.textContent =
      this.device === 'pad'
        ? t('map.helpPad', {
            accept: inputLabel(`pad:b${PAD.A}`),
            switch: t('input.binding.pair', { neg: inputLabel(`pad:b${PAD.LB}`), pos: inputLabel(`pad:b${PAD.RB}`) }),
            map: bindingLabel(this.bound('toggleMap', 'pad')),
            back: inputLabel(`pad:b${PAD.B}`),
          })
        : t('map.help', { map: bindingLabel(this.bound('toggleMap', 'kbm')), close: bindingLabel(this.bound('pause', 'kbm')) });
  }

  private setDevice(d: InputContext): void {
    if (this.device === d) return;
    this.device = d;
    this.renderHelp();
  }

  private select(id: string): void {
    if (!id) return;
    this.selectedId = id;
    this.onSelect?.(id);
    for (const [i, it] of this.items.entries()) {
      this.labelEls[i]?.classList.toggle('sel', it.id === id);
      this.optionEls[i]?.setAttribute('aria-selected', String(it.id === id));
    }
    this.labelSize = []; // The selected label is bold: measure again.
    this.updateRoving();
  }

  // --- Focus and keyboard ------------------------------------------------------------------------------------------

  private get optionList(): HTMLButtonElement[] {
    return this.optionEls.filter((b): b is HTMLButtonElement => b !== null);
  }

  /** The listbox has one tab stop: the selected option, else the first. */
  private updateRoving(): void {
    const opts = this.optionList;
    const stop = opts.find((b) => b.getAttribute('aria-selected') === 'true') ?? opts[0];
    for (const b of opts) b.tabIndex = b === stop ? 0 : -1;
  }

  private rovingOption(): HTMLButtonElement | null {
    return this.optionList.find((b) => b.tabIndex === 0) ?? null;
  }

  private focusOption(b: HTMLButtonElement): void {
    for (const o of this.optionList) o.tabIndex = o === b ? 0 : -1;
    b.focus({ focusVisible: true });
    b.scrollIntoView({ block: 'nearest' });
  }

  private focusInitial(): void {
    const target = this.rovingOption() ?? this.modeBtn;
    target.focus({ preventScroll: true });
    if (target !== this.modeBtn) target.scrollIntoView({ block: 'nearest' });
  }

  /** Tab stops of the dialog, in order. */
  private tabStops(): HTMLElement[] {
    const r = this.rovingOption();
    return r ? [this.modeBtn, r] : [this.modeBtn];
  }

  private isToggle(code: string): boolean {
    return keyTriggers(this.app.input.binding('toggleMap', 0, 'kbm'), code) || keyTriggers(this.app.input.binding('toggleMap', 1, 'kbm'), code);
  }

  /** Window capture phase: runs before the game's listeners, which are disabled while the map is open anyway. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.isOpen || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    this.setDevice('kbm');
    if (e.code === 'Escape' || this.isToggle(e.code)) {
      // Consumed here, so the re-enabled game input never sees the key that closed the map.
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.close();
      return;
    }
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && this.overlay.contains(active) && active !== this.overlay;
    if (e.key === 'Tab') {
      const stops = this.tabStops();
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    const cam = keyCamera(e.code, e.shiftKey || !inside);
    if (cam) {
      e.preventDefault();
      this.orbit(cam.yaw, cam.pitch, cam.zoom);
      return;
    }
    if (!inside) return;
    const opts = this.optionList;
    const idx = active instanceof HTMLButtonElement ? opts.indexOf(active) : -1;
    if (idx >= 0) {
      const next = listStep(e.key, idx, opts.length, this.pageSize());
      if (next !== null) {
        e.preventDefault();
        if (next === 0 && idx === 0 && e.key === 'ArrowUp') this.modeBtn.focus();
        else this.focusOption(opts[next]!);
      }
    } else if (active === this.modeBtn && (e.key === 'ArrowDown' || e.key === 'Home')) {
      const r = this.rovingOption();
      if (r) {
        e.preventDefault();
        this.focusOption(e.key === 'Home' ? opts[0]! : r);
      }
    }
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    this.setDevice('kbm');
    if (e.button === 0) return; // Left button drags the map and clicks labels.
    const b0 = this.app.input.binding('toggleMap', 0, 'kbm');
    const b1 = this.app.input.binding('toggleMap', 1, 'kbm');
    if (mouseTriggers(b0, e.button) || mouseTriggers(b1, e.button)) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  /** Options that fit in the visible part of the list (for Page Up / Page Down). */
  private pageSize(): number {
    const first = this.optionList[0];
    const h = first?.offsetHeight ?? 0;
    return h > 0 ? Math.max(1, Math.floor(this.list.clientHeight / h) - 1) : 10;
  }

  /** Orbit the camera around the target (radians, matching a mouse drag) and scale its distance. */
  private orbit(yaw: number, pitch: number, zoom: number): void {
    const c = this.controls;
    if (!c || (yaw === 0 && pitch === 0 && zoom === 1)) return;
    const off = this.camera.position.clone().sub(c.target);
    const s = new THREE.Spherical().setFromVector3(off);
    s.theta -= yaw;
    s.phi = THREE.MathUtils.clamp(s.phi - pitch, Math.max(1e-3, c.minPolarAngle), Math.min(Math.PI - 1e-3, c.maxPolarAngle));
    s.radius = THREE.MathUtils.clamp(s.radius * zoom, c.minDistance, c.maxDistance);
    this.camera.position.copy(c.target).add(off.setFromSpherical(s));
    this.camera.lookAt(c.target);
  }

  // --- Gamepad -----------------------------------------------------------------------------------------------------

  private pads(): readonly (Gamepad | null)[] {
    try {
      return navigator.getGamepads?.() ?? [];
    } catch {
      return [];
    }
  }

  private pollPad(dt: number): void {
    const pads = this.pads() as readonly (PadLike | null)[];
    const toggle = padHolds(this.app.input.binding('toggleMap', 0, 'pad'), pads) || padHolds(this.app.input.binding('toggleMap', 1, 'pad'), pads);
    const pressed = toggle && !this.padToggleHeld;
    this.padToggleHeld = toggle;
    if (pressed) {
      this.setDevice('pad');
      this.close();
      return;
    }
    for (const c of this.nav.poll(performance.now() / 1000)) {
      this.setDevice('pad');
      this.navCommand(c);
      if (!this.isOpen) return;
    }
    const cam = padCamera(pads, dt);
    if (cam.yaw !== 0 || cam.pitch !== 0 || cam.zoom !== 1) {
      this.setDevice('pad');
      this.orbit(cam.yaw, cam.pitch, cam.zoom);
    }
  }

  private navCommand(c: NavCommand): void {
    const active = document.activeElement;
    const opts = this.optionList;
    switch (c) {
      case 'menu':
      case 'back':
        this.close();
        return;
      case 'tabPrev':
      case 'tabNext':
        this.setMode(this.mode === 'system' ? 'stars' : 'system');
        this.focusInitial();
        return;
      case 'accept':
        if (active instanceof HTMLButtonElement && this.overlay.contains(active)) active.click();
        return;
      case 'up':
      case 'down': {
        const idx = active instanceof HTMLButtonElement ? opts.indexOf(active) : -1;
        if (idx >= 0) {
          if (c === 'up' && idx === 0) this.modeBtn.focus({ focusVisible: true });
          else this.focusOption(opts[listStep(c === 'up' ? 'ArrowUp' : 'ArrowDown', idx, opts.length)!]!);
        } else if (active === this.modeBtn && c === 'down') {
          const r = this.rovingOption();
          if (r) this.focusOption(r);
        } else if (!(active instanceof HTMLElement && this.overlay.contains(active) && active !== this.overlay)) {
          this.focusInitial();
        }
        return;
      }
      default:
        return;
    }
  }

  // --- Scene -------------------------------------------------------------------------------------------------------

  private addDot(pos: THREE.Vector3, color: THREE.Color, sizePx: number): void {
    const s = new THREE.Sprite(this.dotMat);
    s.userData['color'] = color;
    s.position.copy(pos);
    s.scale.setScalar(sizePx / 600);
    this.scene.add(s);
  }

  private buildSystem(): void {
    const app = this.app;
    const sys = app.sys;
    const tNow = app.simTime;
    const star = sys.primaryStar(app.cam.pos, tNow);
    const starPos = new Vec3d();
    sys.anchorSsb(star.def.id, tNow, starPos);
    const planets = sys.views.filter((v) => v.def.parent === star.def.id && v.def.kind !== 'star');
    const states = planets.map((v) => ({
      v,
      r: sys.anchorRelative(v.def.id, star.def.id, tNow, new Vec3d()),
      vel: sys.anchorVelocity(v.def.id, star.def.id, tNow, new Vec3d()),
    }));
    // Lay the map on the system's mean orbital plane: the normal of the planets' total orbital angular momentum
    // (close to the invariable plane). Falls back to the ecliptic pole (J2000 obliquity 23.4392911 deg, IAU 2006).
    const L = new Vec3d();
    for (const s of states) L.add(s.r.clone().cross(s.vel).scale(s.v.def.gmM3S2 || 1));
    const eps = (23.4392911 * Math.PI) / 180;
    const up = L.length() > 0 ? L.normalize() : new Vec3d(0, -Math.sin(eps), Math.cos(eps));
    const e1 = new Vec3d(1, 0, 0).sub(up.clone().scale(up.x)).normalize();
    const e2 = up.clone().cross(e1);
    const toMap = (p: Vec3d): THREE.Vector3 => {
      const r = p.length();
      if (r < 1) return new THREE.Vector3();
      const k = compress(r) / r;
      return new THREE.Vector3(p.dot(e1) * k, p.dot(up) * k, -p.dot(e2) * k);
    };
    this.addDot(new THREE.Vector3(), new THREE.Color(1, 0.85, 0.6), 34);
    this.items.push({ id: star.def.id, name: star.def.id === '10' ? t('body.sun') : star.def.name, pos: new THREE.Vector3(), detail: '', color: new THREE.Color(1, 0.9, 0.6), size: 30, rank: 1 });
    // Orbits: osculating Kepler ellipses from each planet's current state vector, so outer planets show full orbits
    // even though the ephemeris spans far less than their periods.
    let extent = compress(AU_M);
    for (const { v, r, vel } of states) {
      const pts = keplerOrbit(r, vel, star.def.gmM3S2 + v.def.gmM3S2, 192).map(toMap);
      for (const q of pts) extent = Math.max(extent, Math.hypot(q.x, q.z));
      this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.orbitMat));
      const pos = toMap(r);
      this.addDot(pos, new THREE.Color(0.75, 0.9, 1), 14);
      const shipD = sys.anchorRelative(v.def.id, app.cam.pos.anchor, tNow, new Vec3d()).sub(app.cam.pos.offset).length();
      this.items.push({ id: v.def.id, name: bodyLabel(v.def), pos, detail: formatDistance(shipD), color: new THREE.Color(0.8, 0.9, 1), size: 12, rank: 2 });
    }
    // The ship. Near a planet (inside its sphere of influence) the two would overlap at this scale: one merged label.
    const shipPos = toMap(sys.toSsb(app.cam.pos, tNow, new Vec3d()).sub(starPos));
    this.addDot(shipPos, this.youColor, 16);
    const dom = sys.dominantBody(app.cam.pos, tNow);
    const host = this.items.find((it) => it.id === dom || (it.id !== star.def.id && sys.byId.get(dom)?.def.parent === it.id));
    if (host) host.rank = Infinity;
    const youName = host ? t('map.youAt', { name: host.name }) : t('map.you');
    this.items.unshift({ id: '', name: youName, pos: shipPos, detail: '', color: this.youColor, size: 14, rank: 0 });
    // Reference rings between planetary orbits (2 au: asteroid belt, 15 au, 50 au: Kuiper belt edge).
    for (const au of [2, 15, 50]) if (compress(au * AU_M) < extent * 1.4) this.addRing(compress(au * AU_M), t('unit.au', { v: formatNumber(au) }));
    this.frame(extent);
  }

  /** Place the camera so a disc of the given radius (map units) fits the area left of the list panel. */
  private frame(radius: number): void {
    const w = this.app.renderer.domElement.clientWidth || innerWidth;
    const h = this.app.renderer.domElement.clientHeight || innerHeight;
    const panel = this.list.getBoundingClientRect();
    const d = radius * fitDistance(freeArea(w, panel.left, panel.width).width, h);
    this.camera.position.set(0, d * 0.55, d * 0.83);
    this.camera.near = d * 0.01;
    this.camera.far = d * 10;
    this.camera.lookAt(0, 0, 0);
    this.controls?.target.set(0, 0, 0);
    if (this.controls) {
      this.controls.minDistance = radius * 0.05;
      this.controls.maxDistance = Math.max(radius * 8, d * 1.5);
    }
  }

  private buildStars(): void {
    const app = this.app;
    const cat = app.catalog;
    if (!cat) return;
    const tNow = app.simTime;
    const camSsb = app.sys.toSsb(app.cam.pos, tNow, new Vec3d());
    const sunSsb = app.sys.ephemeris.ssb('10', tNow, new Vec3d());
    const shipPc = camSsb.clone().sub(sunSsb).scale(1 / PARSEC_M);
    const lyPerPc = PARSEC_M / LIGHT_YEAR_M;
    // 1 map unit = 1 light-year, galactic orientation (galactic plane horizontal, north up).
    const toMap = (pc: Vec3d): THREE.Vector3 => toGalactic(new Vec3d().subVectors(pc, shipPc)).multiplyScalar(lyPerPc);
    const sunMap = toMap(new Vec3d());
    this.addDot(sunMap, new THREE.Color(1, 0.95, 0.8), 18);
    this.items.push({ id: '10', name: t('body.sun'), pos: sunMap, detail: formatDistance(shipPc.length() * PARSEC_M), color: new THREE.Color(1, 0.95, 0.8), size: 14, rank: 1 });
    const ids = cat.destinations(shipPc, MAP_RADIUS_LY / lyPerPc, 250);
    const p = new Vec3d();
    let extent = 10;
    for (const i of ids) {
      cat.positionPc(i, p);
      const m = toMap(p);
      const info = cat.info(i);
      const col = new THREE.Color().setRGB(
        (app.stars.colors[i * 4] ?? 255) / 255,
        (app.stars.colors[i * 4 + 1] ?? 255) / 255,
        (app.stars.colors[i * 4 + 2] ?? 255) / 255,
      );
      const absMag = cat.absMags[i] ?? 10;
      const size = Math.max(6, Math.min(18, 14 - absMag * 0.7));
      this.addDot(m, col, size);
      this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([m, new THREE.Vector3(m.x, 0, m.z)]), this.dropMat));
      const dPc = p.distanceTo(shipPc);
      const d = dPc * lyPerPc;
      extent = Math.max(extent, d);
      // Labels favour nearby stars, and luminous stars a player will know (Vega, Arcturus...) over faint dwarfs.
      const rank = 2 + d - Math.max(0, 4 - absMag) * 6;
      const detail = [formatDistance(dPc * PARSEC_M), info?.spect].filter(Boolean).join(' · ');
      this.items.push({ id: `*${i}`, name: cat.name(i), pos: m, detail, color: col, size, rank });
    }
    this.addDot(new THREE.Vector3(), this.youColor, 14);
    this.items.unshift({ id: '', name: t('map.you'), pos: new THREE.Vector3(), detail: '', color: this.youColor, size: 14, rank: 0 });
    for (const r of [10, 25, 50]) if (r < extent * 1.2) this.addRing(r, t('unit.ly', { v: formatNumber(r) }));
    this.frame(Math.min(extent, MAP_RADIUS_LY) * 0.95);
  }

  private addRing(r: number, label: string): void {
    const ring = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(Array.from({ length: 129 }, (_, k) => new THREE.Vector3(Math.cos((k / 128) * Math.PI * 2) * r, 0, Math.sin((k / 128) * Math.PI * 2) * r))),
      this.ringMat,
    );
    this.scene.add(ring);
    this.ringLabels.push({ pos: new THREE.Vector3(r * Math.SQRT1_2, 0, r * Math.SQRT1_2), text: label });
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastRender) / 1000);
    this.lastRender = now;
    this.pollPad(dt);
    if (!this.isOpen) return;
    const r = this.app.renderer;
    const w = r.domElement.clientWidth || innerWidth;
    const h = r.domElement.clientHeight || innerHeight;
    this.camera.aspect = w / h;
    // Centre the scene in the area left of the destination list.
    const panel = this.list.getBoundingClientRect();
    this.camera.setViewOffset(w, h, freeArea(w, panel.left, panel.width).shift, 0, w, h);
    this.camera.updateProjectionMatrix();
    this.controls?.update();
    r.setRenderTarget(null);
    r.setClearColor(this.clearColor, 1);
    r.autoClear = true;
    r.render(this.scene, this.camera);
    r.autoClear = false;
    this.placeLabels(w, h);
  }

  /** Real label sizes at the current text scale (labels are visible right after a build). */
  private measure(): void {
    this.labelSize = this.labelEls.map((e) => {
      e.style.display = '';
      return { w: e.offsetWidth, h: e.offsetHeight };
    });
    this.ringSize = this.ringEls.map((e) => {
      e.style.display = '';
      return { w: e.offsetWidth, h: e.offsetHeight };
    });
  }

  /**
   * Greedy label placement: labels are placed in priority order (selection, you, scale rings, then list order, which
   * is nearest first, luminous stars favoured) at the first of four positions around their dot that does not collide;
   * the rest are hidden (their dots stay visible and clickable entries remain in the list). Boxes are the labels'
   * measured sizes, so placement holds at any text scale.
   */
  private placeLabels(w: number, h: number): void {
    if (this.overlay.style.display === 'none') return;
    if (this.labelSize.length !== this.labelEls.length || this.ringSize.length !== this.ringEls.length) this.measure();
    const v = new THREE.Vector3();
    // On-screen panels are obstacles too, so labels never hide under them.
    const placed: Box[] = [this.title, this.list].map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const order = this.items.map((_, i) => i);
    const prio = (i: number): number => {
      const it = this.items[i]!;
      return it.id !== '' && it.id === this.selectedId ? -1 : it.rank;
    };
    order.sort((a, b) => prio(a) - prio(b) || a - b);
    // Scale-ring labels come after "you", the selection and the most luminous stars (priority <= 0), before the rest:
    // the scale text tells the player to read them.
    let ringsPlaced = false;
    for (const i of order) {
      if (!ringsPlaced && prio(i) > 0) {
        this.placeRingLabels(w, h, placed);
        ringsPlaced = true;
      }
      const it = this.items[i]!;
      const el = this.labelEls[i];
      const size = this.labelSize[i];
      if (!el || !size) continue;
      v.copy(it.pos).project(this.camera);
      if (v.z > 1 || v.z < -1 || it.rank === Infinity) {
        el.style.display = 'none';
        continue;
      }
      const x = ((v.x + 1) / 2) * w;
      const y = ((1 - v.y) / 2) * h;
      const bw = size.w;
      const bh = size.h;
      const candidates: Box[] = [
        { x: x + 7, y: y - bh + 2, w: bw, h: bh },
        { x: x + 7, y: y - 2, w: bw, h: bh },
        { x: x - 7 - bw, y: y - bh + 2, w: bw, h: bh },
        { x: x - 7 - bw, y: y - 2, w: bw, h: bh },
      ];
      const spot = candidates.find((c) => !placed.some((p) => overlaps(c, p)));
      if (!spot) {
        el.style.display = 'none';
        continue;
      }
      placed.push(spot);
      el.style.display = '';
      el.style.transform = `translate(${spot.x}px, ${spot.y}px)`;
    }
    if (!ringsPlaced) this.placeRingLabels(w, h, placed);
  }

  private placeRingLabels(w: number, h: number, placed: Box[]): void {
    const v = new THREE.Vector3();
    for (const [i, r] of this.ringLabels.entries()) {
      const el = this.ringEls[i];
      const size = this.ringSize[i];
      if (!el || !size) continue;
      v.copy(r.pos).project(this.camera);
      const x = ((v.x + 1) / 2) * w;
      const y = ((1 - v.y) / 2) * h;
      const box = { x: x + 4, y: y - size.h / 2, w: size.w, h: size.h };
      const hide = v.z > 1 || v.z < -1 || placed.some((p) => overlaps(box, p));
      el.style.display = hide ? 'none' : '';
      if (!hide) {
        placed.push(box);
        el.style.transform = `translate(${box.x}px, ${box.y}px)`;
      }
    }
  }
}
