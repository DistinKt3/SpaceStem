/**
 * Heads-up display (DOM). Text lives in the DOM so it stays crisp at any scale, follows the text-size setting, can be
 * read by screen readers and translated; spatial markers are projected from the 3D camera each frame.
 */
import * as THREE from 'three/webgpu';
import { SPEED_OF_LIGHT_M_PER_S } from '../../core/constants';
import type { Provenance } from '../../core/provenance';
import type { Vec3d } from '../../core/vec3d';
import { formatDistance, formatDuration, formatSpeed } from '../format';
import { formatNumber, t } from '../i18n';
import { provenanceBadge } from '../ui/badge';
import type { FlightMode } from '../ship/ship';
import { throttleMeter } from './throttle';

export interface HudTarget {
  id: string;
  name: string;
  /** Target centre relative to the camera (m, world axes). */
  rel: Vec3d;
  /** Radius (m), for distance to surface and bracket size. */
  radius: number;
  provenance: Provenance;
  kind: string;
}

export interface HudLabel {
  id: string;
  name: string;
  rel: Vec3d;
  radius: number;
}

export interface HudState {
  mode: FlightMode;
  throttle: number;
  speed: number;
  speedLabel: 'surface' | 'orbital' | 'drive';
  /** Hyperspeed: seconds to arrival (overrides distance/speed ETA). */
  etaOverride: number | null;
  governorSpeed: number;
  altitude: number;
  verticalSpeed: number;
  nearName: string;
  flightAssist: boolean;
  landed: boolean;
  /** Velocity direction relative to the reference frame (world axes), or null when ~stationary. */
  velocityDir: Vec3d | null;
  target: HudTarget | null;
  labels: HudLabel[];
  utc: string;
  sunDistance: number;
  /** Name of the system's star (the Sun, or the star the ship is visiting). */
  sunName: string;
  /** Current binding label of the "How do we know this?" action (follows rebinding and the active device). */
  howWeKnowKey: string;
  warnings: string[];
  footer: string;
}

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

export class Hud {
  readonly root: HTMLDivElement;
  private readonly top: HTMLDivElement;
  private readonly left: HTMLDivElement;
  private readonly right: HTMLDivElement;
  private readonly footer: HTMLDivElement;
  private readonly warn: HTMLDivElement;
  private readonly markers: HTMLDivElement;
  private readonly velMarker: HTMLDivElement;
  private readonly bracket: HTMLDivElement;
  private readonly edgeArrow: HTMLDivElement;
  private readonly labelPool: HTMLDivElement[] = [];
  private visible = true;
  private readonly tmp = new THREE.Vector3();
  private lastPanels = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ks-hud', parent);
    this.root.setAttribute('aria-hidden', 'false');
    this.markers = el('div', 'ks-hud-markers', this.root);
    const reticle = el('div', 'ks-reticle', this.root);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '-20 -20 40 40');
    svg.innerHTML =
      '<circle r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
      '<path d="M-16 0 H-7 M7 0 H16 M0 -16 V-7 M0 7 V16" stroke="currentColor" stroke-width="1.2" fill="none"/>';
    reticle.appendChild(svg);
    this.velMarker = el('div', 'ks-vel', this.markers);
    this.velMarker.innerHTML =
      '<svg viewBox="-20 -12 40 24"><circle r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M-14 0 H-5 M5 0 H14 M0 -5 V-11" stroke="currentColor" stroke-width="1.6"/></svg>';
    this.bracket = el('div', 'ks-bracket', this.markers);
    this.edgeArrow = el('div', 'ks-edge-arrow', this.markers);
    // Panels sit in one grid (hud.css), so they cannot overlap at any text scale or window size.
    const layout = el('div', 'ks-hud-layout', this.root);
    this.top = el('div', 'ks-hud-panel ks-hud-top', layout);
    this.left = el('div', 'ks-hud-panel ks-hud-left', layout);
    this.right = el('div', 'ks-hud-panel ks-hud-right', layout);
    this.footer = el('div', 'ks-hud-footer', layout);
    this.warn = el('div', 'ks-hud-warn', layout);
    this.warn.setAttribute('role', 'alert');
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Project a camera-relative world vector to CSS pixels; null if behind the camera. */
  private project(rel: Vec3d, cam: THREE.PerspectiveCamera, w: number, h: number): [number, number, boolean] | null {
    const v = this.tmp.set(rel.x, rel.y, rel.z).applyQuaternion(cam.quaternion.clone().invert());
    if (v.z >= 0) return null;
    v.applyMatrix4(cam.projectionMatrix);
    const x = ((v.x + 1) / 2) * w;
    const y = ((1 - v.y) / 2) * h;
    const on = v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1;
    return [x, y, on];
  }

  update(s: HudState, cam: THREE.PerspectiveCamera): void {
    if (!this.visible) return;
    const w = innerWidth;
    const h = innerHeight;
    const now = performance.now();
    if (now - this.lastPanels > 100) {
      this.lastPanels = now;
      this.updatePanels(s);
    }
    this.updateMarkers(s, cam, w, h);
  }

  private updatePanels(s: HudState): void {
    // Top: mode, speed, throttle.
    const modeName = t(`hud.mode.${s.mode}`);
    const speedC = s.speed / SPEED_OF_LIGHT_M_PER_S;
    // Below 0.001c the speed reads in m/s or km/s; add the fraction of c from 0.0001c so cruise speeds have context.
    // From 0.001c the speed itself is shown in c, so no note.
    const cNote = speedC >= 1e-4 && speedC < 1e-3 ? ` · ${t('hud.fractionC', { v: formatNumber(speedC, 4) })}` : '';
    this.top.innerHTML =
      `<div class="ks-mode">${modeName}${s.flightAssist ? '' : ` · ${t('hud.faOff')}`}${s.landed ? ` · ${t('hud.landed')}` : ''}</div>` +
      `<div class="ks-speed">${formatSpeed(s.speed)}<span class="ks-sub">${t(`hud.speedRef.${s.speedLabel}`)}${cNote}</span></div>` +
      throttleMeter(s.throttle) +
      (s.mode === 'impulse' || s.mode === 'cruise' ? `<div class="ks-sub">${t('hud.governor', { v: formatSpeed(s.governorSpeed) })}</div>` : '');
    // Left: altitude.
    this.left.innerHTML =
      `<div class="k">${t('hud.near')}</div><div class="v">${s.nearName}</div>` +
      `<div class="k">${t('hud.altitude')}</div><div class="v">${formatDistance(s.altitude)}</div>` +
      (s.mode === 'thrusters' ? `<div class="k">${t('hud.vspeed')}</div><div class="v">${formatSpeed(s.verticalSpeed)}</div>` : '');
    // Right: target.
    if (s.target) {
      const d = s.target.rel.length();
      const surf = Math.max(0, d - s.target.radius);
      const eta = s.etaOverride ?? (s.speed > 1 ? surf / s.speed : Infinity);
      this.right.style.display = '';
      this.right.innerHTML =
        `<div class="k">${t('hud.target')}</div><div class="v ks-target-name">${s.target.name}</div>` +
        `<div class="ks-prov-badge">${provenanceBadge(s.target.provenance).outerHTML}</div>` +
        `<div class="k">${t('hud.distance')}</div><div class="v">${formatDistance(surf)}</div>` +
        `<div class="k">${t('hud.lightTime')}</div><div class="v">${formatDuration(d / SPEED_OF_LIGHT_M_PER_S)}</div>` +
        `<div class="k">${t('hud.eta')}</div><div class="v">${Number.isFinite(eta) ? formatDuration(eta) : '—'}</div>` +
        (s.howWeKnowKey ? `<div class="ks-hint">${t('hud.howWeKnowHint', { key: s.howWeKnowKey })}</div>` : '');
    } else {
      this.right.style.display = 'none';
    }
    this.footer.innerHTML = `${s.utc} · ${t('hud.starDistance', { name: s.sunName })} ${formatDistance(s.sunDistance)} · ${t('hud.lightTime')} ${formatDuration(s.sunDistance / SPEED_OF_LIGHT_M_PER_S)}${s.footer ? ` · ${s.footer}` : ''}`;
    this.warn.textContent = s.warnings.join(' · ');
    this.warn.style.display = s.warnings.length ? '' : 'none';
  }

  private updateMarkers(s: HudState, cam: THREE.PerspectiveCamera, w: number, h: number): void {
    // Velocity marker.
    if (s.velocityDir) {
      const p = this.project(s.velocityDir.clone().scale(1e3), cam, w, h);
      this.place(this.velMarker, p && p[2] ? p : null);
    } else this.place(this.velMarker, null);

    // Target bracket or edge arrow.
    if (s.target) {
      const p = this.project(s.target.rel, cam, w, h);
      if (p && p[2]) {
        const angR = Math.asin(Math.min(1, s.target.radius / Math.max(s.target.rel.length(), 1)));
        const pxR = Math.max(14, Math.min(h * 0.45, (angR / ((cam.fov * Math.PI) / 180)) * h + 10));
        this.bracket.style.display = '';
        this.bracket.style.transform = `translate(${p[0] - pxR}px, ${p[1] - pxR}px)`;
        this.bracket.style.width = `${pxR * 2}px`;
        this.bracket.style.height = `${pxR * 2}px`;
        this.edgeArrow.style.display = 'none';
      } else {
        this.bracket.style.display = 'none';
        // Direction on screen toward the target (works behind the camera too).
        const v = this.tmp.set(s.target.rel.x, s.target.rel.y, s.target.rel.z).applyQuaternion(cam.quaternion.clone().invert());
        const ang = Math.atan2(-v.y, v.x);
        const r = Math.min(w, h) * 0.42;
        this.edgeArrow.style.display = '';
        this.edgeArrow.style.transform = `translate(${w / 2 + Math.cos(ang) * r}px, ${h / 2 + Math.sin(ang) * r}px) rotate(${ang}rad)`;
      }
    } else {
      this.bracket.style.display = 'none';
      this.edgeArrow.style.display = 'none';
    }

    // Body labels (nearest first). Text is written for all of them before any is measured (one layout); each is then
    // put at the first of four spots around its point that is clear of the labels already placed, or hidden.
    const shown: { node: HTMLElement; x: number; y: number }[] = [];
    for (const lab of s.labels) {
      const p = this.project(lab.rel, cam, w, h);
      if (!p || !p[2]) continue;
      let node = this.labelPool[shown.length];
      if (!node) {
        node = el('div', 'ks-label', this.markers);
        this.labelPool.push(node);
      }
      node.style.display = '';
      node.textContent = `${lab.name} · ${formatDistance(Math.max(0, lab.rel.length() - lab.radius))}`;
      shown.push({ node, x: p[0], y: p[1] });
    }
    for (let i = shown.length; i < this.labelPool.length; i++) this.labelPool[i]!.style.display = 'none';
    const sizes = shown.map((l) => [l.node.offsetWidth, l.node.offsetHeight] as const);
    const placed: LabelBox[] = [];
    shown.forEach((l, i) => {
      const [lw, lh] = sizes[i]!;
      const spot = labelSpots(l.x, l.y, lw, lh).find((b) => !placed.some((q) => boxesOverlap(b, q)));
      if (!spot) {
        l.node.style.display = 'none';
        return;
      }
      placed.push(spot);
      l.node.style.transform = `translate(${spot.x}px, ${spot.y}px)`;
    });
  }

  private place(node: HTMLElement, p: [number, number, boolean] | null): void {
    if (!p) {
      node.style.display = 'none';
      return;
    }
    node.style.display = '';
    node.style.transform = `translate(${p[0]}px, ${p[1]}px) translate(-50%, -50%)`;
  }
}

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Candidate label boxes around a point at (x, y), in order of preference: right, left, above right, below right. */
export function labelSpots(x: number, y: number, w: number, h: number): LabelBox[] {
  const gap = 8;
  return [
    { x: x + gap, y: y - gap, w, h },
    { x: x - gap - w, y: y - gap, w, h },
    { x: x + gap, y: y - gap - h, w, h },
    { x: x + gap, y: y + gap, w, h },
  ];
}

export function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
