/**
 * Map view: a separate 3D scene drawn instead of the world while open.
 * - System map: the local star and planets, laid on the mean orbital plane, with osculating Kepler orbits from the
 *   ephemeris state vectors. Radial distances are compressed (r^0.4) so Mercury and Neptune fit on one screen;
 *   directions are true. The scale is labelled on screen.
 * - Star map: named catalogue stars within 50 light-years of the ship at true relative positions, oriented to the
 *   galactic plane, with distance rings and drop-lines to the plane for depth.
 * A keyboard-accessible list mirrors the clickable labels; choosing an entry sets the ship's target.
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Fn, uv, vec4, float, length, smoothstep, exp, uniform } from 'three/tsl';
import { AU_M, LIGHT_YEAR_M, PARSEC_M } from '../../core/constants';
import { Vec3d } from '../../core/vec3d';
import { keplerOrbit } from '../../world/kepler';
import type { App } from '../app';
import { formatDistance } from '../format';
import { bodyLabel, t } from '../i18n';

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

/** Screen-space boxes for label collision tests (CSS px). */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function dotMaterial(color: THREE.Color): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const c = uniform(color);
  m.colorNode = Fn(() => {
    const r = length(uv().sub(0.5)).mul(2);
    const k = exp(r.mul(r).mul(-6)).add(smoothstep(float(1), float(0.6), r).mul(0.15));
    return vec4(c.mul(k).mul(1.6), k);
  })();
  m.sizeAttenuation = false;
  return m;
}

export class MapView {
  mode: MapMode = 'system';
  isOpen = false;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  private controls: OrbitControls | null = null;
  private items: MapItem[] = [];
  private readonly overlay: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly labels: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private labelEls: HTMLButtonElement[] = [];
  private ringLabels: { pos: THREE.Vector3; text: string }[] = [];
  private ringEls: HTMLSpanElement[] = [];
  /** Currently selected destination (highlighted; drawn with label priority). */
  selectedId: string | null = null;
  /** Supplies the current target when the map opens. */
  getSelected: (() => string | null) | null = null;
  onSelect: ((id: string) => void) | null = null;

  constructor(private readonly app: App) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'ks-map';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.innerHTML = '';
    this.title = document.createElement('div');
    this.title.className = 'ks-map-title';
    this.labels = document.createElement('div');
    this.labels.className = 'ks-map-labels';
    this.list = document.createElement('div');
    this.list.className = 'ks-map-list';
    this.list.setAttribute('role', 'listbox');
    this.overlay.append(this.labels, this.title, this.list);
    this.overlay.style.display = 'none';
    document.body.appendChild(this.overlay);
    // M (toggleMap) and Esc (pause) are routed by the App through the InputManager, so they follow rebinding.
    this.overlay.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' && !e.shiftKey && document.activeElement === this.overlay) {
        e.preventDefault();
        this.list.querySelector<HTMLButtonElement>('button')?.focus();
      }
    });
  }

  open(mode?: MapMode): void {
    const anchor = this.app.cam.pos.anchor;
    this.mode = mode ?? (anchor === 'ism' ? 'stars' : 'system');
    if (this.getSelected) this.selectedId = this.getSelected();
    this.build();
    this.isOpen = true;
    document.body.classList.add('ks-map-open');
    this.overlay.style.display = '';
    this.overlay.tabIndex = -1;
    this.overlay.focus();
    if (!this.controls) {
      this.controls = new OrbitControls(this.camera, this.app.renderer.domElement);
      this.controls.enableDamping = true;
    }
    this.controls.enabled = true;
  }

  close(): void {
    this.isOpen = false;
    document.body.classList.remove('ks-map-open');
    this.overlay.style.display = 'none';
    if (this.controls) this.controls.enabled = false;
    this.app.canvas.focus?.();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private clear(): void {
    for (const c of [...this.scene.children]) {
      this.scene.remove(c);
      // Sprites share one global geometry in three.js: never dispose it.
      if (c instanceof THREE.Line) (c.geometry as THREE.BufferGeometry).dispose();
    }
    this.items = [];
    this.ringLabels = [];
  }

  private build(): void {
    this.clear();
    if (this.mode === 'system') this.buildSystem();
    else this.buildStars();
    // List and labels.
    this.list.innerHTML = '';
    this.labels.innerHTML = '';
    this.labelEls = [];
    this.ringEls = this.ringLabels.map((r) => {
      const e = document.createElement('span');
      e.className = 'ks-map-ring';
      e.textContent = r.text;
      this.labels.appendChild(e);
      return e;
    });
    const modeBtn = document.createElement('button');
    modeBtn.className = 'ks-map-mode';
    modeBtn.textContent = this.mode === 'system' ? t('map.showStars') : t('map.showSystem');
    modeBtn.addEventListener('click', () => {
      this.mode = this.mode === 'system' ? 'stars' : 'system';
      this.build();
      this.list.querySelector<HTMLButtonElement>('.ks-map-mode')?.focus();
    });
    this.list.appendChild(modeBtn);
    for (const it of this.items) {
      const b = document.createElement('button');
      b.className = 'ks-map-entry';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(it.id !== '' && it.id === this.selectedId));
      b.innerHTML = `<span class="n">${it.name}</span><span class="d">${it.detail}</span>`;
      b.addEventListener('click', () => this.select(it.id));
      this.list.appendChild(b);
      const lab = document.createElement('button');
      lab.className = 'ks-map-label';
      lab.tabIndex = -1;
      lab.textContent = it.name;
      if (it.id === '') lab.classList.add('you');
      if (it.id !== '' && it.id === this.selectedId) lab.classList.add('sel');
      lab.addEventListener('click', () => this.select(it.id));
      this.labels.appendChild(lab);
      this.labelEls.push(lab);
    }
    this.title.innerHTML =
      this.mode === 'system'
        ? `<strong>${t('map.systemTitle')}</strong><span>${t('map.systemScale')}</span><span>${t('map.help')}</span>`
        : `<strong>${t('map.starsTitle')}</strong><span>${t('map.starsScale')}</span><span>${t('map.help')}</span>`;
  }

  private select(id: string): void {
    if (!id) return;
    this.selectedId = id;
    this.onSelect?.(id);
    for (const [i, it] of this.items.entries()) this.labelEls[i]?.classList.toggle('sel', it.id === id);
    for (const b of this.list.querySelectorAll<HTMLButtonElement>('.ks-map-entry')) b.setAttribute('aria-selected', 'false');
    const idx = this.items.findIndex((it) => it.id === id);
    this.list.querySelectorAll<HTMLButtonElement>('.ks-map-entry')[idx]?.setAttribute('aria-selected', 'true');
  }

  private addDot(pos: THREE.Vector3, color: THREE.Color, sizePx: number): void {
    const s = new THREE.Sprite(dotMaterial(color));
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
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicNodeMaterial({ color: 0x4a86a8, transparent: true, opacity: 0.75 }));
      this.scene.add(line);
      const pos = toMap(r);
      this.addDot(pos, new THREE.Color(0.75, 0.9, 1), 14);
      const shipD = sys.anchorRelative(v.def.id, app.cam.pos.anchor, tNow, new Vec3d()).sub(app.cam.pos.offset).length();
      this.items.push({ id: v.def.id, name: bodyLabel(v.def), pos, detail: formatDistance(shipD), color: new THREE.Color(0.8, 0.9, 1), size: 12, rank: 2 });
    }
    // The ship. Near a planet (inside its sphere of influence) the two would overlap at this scale: one merged label.
    const shipPos = toMap(sys.toSsb(app.cam.pos, tNow, new Vec3d()).sub(starPos));
    this.addDot(shipPos, new THREE.Color(0.5, 1, 0.7), 16);
    const dom = sys.dominantBody(app.cam.pos, tNow);
    const host = this.items.find((it) => it.id === dom || (it.id !== star.def.id && sys.byId.get(dom)?.def.parent === it.id));
    if (host) host.rank = Infinity;
    const youName = host ? t('map.youAt', { name: host.name }) : t('map.you');
    this.items.unshift({ id: '', name: youName, pos: shipPos, detail: '', color: new THREE.Color(0.5, 1, 0.7), size: 14, rank: 0 });
    // Faint reference rings between planetary orbits (2 au: asteroid belt, 15 au, 50 au: Kuiper belt edge).
    for (const au of [2, 15, 50]) if (compress(au * AU_M) < extent * 1.4) this.addRing(compress(au * AU_M), 0x1c3444, `${au} au`);
    this.frame(extent);
  }

  /** Place the camera so a disc of the given radius (map units) fits the area left of the list panel. */
  private frame(radius: number): void {
    const d = radius * 2.1;
    this.camera.position.set(0, d * 0.55, d * 0.83);
    this.camera.near = d * 0.01;
    this.camera.far = d * 10;
    this.camera.lookAt(0, 0, 0);
    this.controls?.target.set(0, 0, 0);
    if (this.controls) {
      this.controls.minDistance = radius * 0.05;
      this.controls.maxDistance = radius * 8;
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
    const sunD = shipPc.length() * lyPerPc;
    this.addDot(sunMap, new THREE.Color(1, 0.95, 0.8), 18);
    this.items.push({ id: '10', name: t('body.sun'), pos: sunMap, detail: `${sunD.toFixed(sunD < 10 ? 2 : 1)} ly`, color: new THREE.Color(1, 0.95, 0.8), size: 14, rank: 1 });
    const ids = cat.destinations(shipPc, MAP_RADIUS_LY / lyPerPc, 250);
    const p = new Vec3d();
    const dropMat = new THREE.LineBasicNodeMaterial({ color: 0x2a4a5f, transparent: true, opacity: 0.55 });
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
      const drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([m, new THREE.Vector3(m.x, 0, m.z)]), dropMat);
      this.scene.add(drop);
      const d = p.distanceTo(shipPc) * lyPerPc;
      extent = Math.max(extent, d);
      // Labels favour nearby stars, and luminous stars a player will know (Vega, Arcturus...) over faint dwarfs.
      const rank = 2 + d - Math.max(0, 4 - absMag) * 6;
      this.items.push({ id: `*${i}`, name: cat.name(i), pos: m, detail: `${d.toFixed(1)} ly · ${info?.spect ?? ''}`, color: col, size, rank });
    }
    this.addDot(new THREE.Vector3(), new THREE.Color(0.5, 1, 0.7), 14);
    this.items.unshift({ id: '', name: t('map.you'), pos: new THREE.Vector3(), detail: '', color: new THREE.Color(0.5, 1, 0.7), size: 14, rank: 0 });
    for (const r of [10, 25, 50]) if (r < extent * 1.2) this.addRing(r, 0x2f5870, `${r} ly`);
    this.frame(Math.min(extent, MAP_RADIUS_LY) * 0.95);
  }

  private addRing(r: number, color: number, label: string): void {
    const ring = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(Array.from({ length: 129 }, (_, k) => new THREE.Vector3(Math.cos((k / 128) * Math.PI * 2) * r, 0, Math.sin((k / 128) * Math.PI * 2) * r))),
      new THREE.LineBasicNodeMaterial({ color, transparent: true, opacity: 0.8 }),
    );
    this.scene.add(ring);
    this.ringLabels.push({ pos: new THREE.Vector3(r * Math.SQRT1_2, 0, r * Math.SQRT1_2), text: label });
  }

  render(): void {
    const r = this.app.renderer;
    const w = r.domElement.clientWidth || innerWidth;
    const h = r.domElement.clientHeight || innerHeight;
    this.camera.aspect = w / h;
    // Centre the scene in the area left of the destination list.
    const panel = this.list.getBoundingClientRect();
    const shift = panel.width > 0 && panel.left > w * 0.4 ? (w - panel.left) / 2 : 0;
    this.camera.setViewOffset(w, h, shift, 0, w, h);
    this.camera.updateProjectionMatrix();
    this.controls?.update();
    r.setRenderTarget(null);
    r.setClearColor(0x02040a, 1);
    r.autoClear = true;
    r.render(this.scene, this.camera);
    r.autoClear = false;
    this.placeLabels(w, h);
  }

  /**
   * Greedy label placement: labels are placed in priority order (you, selection, then list order, which is nearest
   * first, luminous stars favoured) at the first of four positions around their dot that does not collide; the rest are hidden (their dots stay
   * visible and clickable entries remain in the list).
   */
  private placeLabels(w: number, h: number): void {
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
    for (const i of order) {
      const it = this.items[i]!;
      const el = this.labelEls[i];
      if (!el) continue;
      v.copy(it.pos).project(this.camera);
      if (v.z > 1 || v.z < -1 || it.rank === Infinity) {
        el.style.display = 'none';
        continue;
      }
      const x = ((v.x + 1) / 2) * w;
      const y = ((1 - v.y) / 2) * h;
      const bw = it.name.length * 6.6 + 8;
      const bh = 15;
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
    for (const [i, r] of this.ringLabels.entries()) {
      const el = this.ringEls[i];
      if (!el) continue;
      v.copy(r.pos).project(this.camera);
      const x = ((v.x + 1) / 2) * w;
      const y = ((1 - v.y) / 2) * h;
      const box = { x: x + 4, y: y - 6, w: r.text.length * 6.6 + 6, h: 13 };
      const hide = v.z > 1 || v.z < -1 || placed.some((p) => overlaps(box, p));
      el.style.display = hide ? 'none' : '';
      if (!hide) el.style.transform = `translate(${box.x}px, ${box.y}px)`;
    }
  }
}
