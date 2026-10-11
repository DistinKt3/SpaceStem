/**
 * The game's ShareHost: adapts the App (camera, sim time, ship controller, renderer) to the ShareController.
 * Integration (see docs/SHARE.md): create it after the controller exists, apply the boot fragment before the first
 * frame, and call `update()` from App.tick right after `input.update(dt)`.
 */
import * as THREE from 'three/webgpu';
import { tdbSecondsSinceJ2000ToUnixMs, unixMsToTdbSecondsSinceJ2000 } from '../../core/time';
import { Vec3d } from '../../core/vec3d';
import type { BodyDef } from '../../world/catalog';
import type { App } from '../app';
import { hasKey, t } from '../i18n';
import { MODES, type FlightMode } from '../ship/ship';
import { ShipController } from '../ship/shipController';
import { captionFor, type CaptionText } from './caption';
import { ShareController, type ApplyResult, type ShareHost } from './shareController';
import { isShareId, makeShareState, type ShareState } from './shareLink';

/** Resolves when `ok()` is true or after `timeoutMs` (polled every 50 ms). */
function waitFor(ok: () => boolean, timeoutMs: number): Promise<void> {
  const until = performance.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = (): void => {
      if (ok() || performance.now() > until) resolve();
      else window.setTimeout(poll, 50);
    };
    poll();
  });
}

/** Display name of a body: localised for Solar System bodies, the catalogue name for stars (and exoplanets). */
function bodyName(def: Pick<BodyDef, 'key' | 'name'>): string {
  const k = `body.${def.key}`;
  return hasKey(k) ? t(k) : def.name;
}

/** The game's host. Exported for tests and for hosts that wrap it. */
export class GameShareHost implements ShareHost {
  private cockpitBefore = false;

  constructor(private readonly app: App) {}

  private get ship(): ShipController | null {
    return this.app.controller instanceof ShipController ? this.app.controller : null;
  }

  /** A catalogue star index ('*123') within the loaded catalogue. */
  private catalogIndex(id: string): number | null {
    if (!id.startsWith('*') || !this.app.catalog) return null;
    const i = Number(id.slice(1));
    return Number.isInteger(i) && i >= 0 && i < this.app.catalog.count ? i : null;
  }

  /** True when this build can place the camera relative to `anchor`. */
  anchorKnown(anchor: string): boolean {
    const sys = this.app.sys;
    if (sys.byId.has(anchor)) return true;
    if (anchor.startsWith('*')) return this.catalogIndex(anchor) !== null;
    // Other external frames ('ism', exoplanet systems when present) resolve through the App's hook.
    return sys.externalAnchor?.(anchor, this.app.simTime, new Vec3d()) != null;
  }

  /** True when the ship can target `id` (a loaded body or a catalogue star). */
  targetKnown(id: string): boolean {
    return this.app.sys.byId.has(id) || this.catalogIndex(id) !== null;
  }

  currentState(): ShareState | null {
    const app = this.app;
    if (!app.sys) return null;
    const ctl = this.ship;
    const target = ctl?.targetId;
    // Mid-jump the drive state cannot be reproduced; the link opens in cruise at the jump's current point.
    const mode = ctl ? (ctl.hyper.active || ctl.ship.mode === 'hyperspeed' ? 'cruise' : ctl.ship.mode) : null;
    const s = makeShareState(app.cam.pos, app.cam.quat, tdbSecondsSinceJ2000ToUnixMs(app.simTime), {
      target: target && isShareId(target) ? target : null,
      mode,
      fovDeg: app.frame.camera.fov,
    });
    return isShareId(s.anchor) ? s : null;
  }

  async applyState(s: ShareState): Promise<ApplyResult> {
    const app = this.app;
    const sys = app.sys;
    if (!this.anchorKnown(s.anchor)) return 'unknown-place';
    const tdb = unixMsToTdbSecondsSinceJ2000(s.timeMs);
    app.simTime = sys.ephemeris.clampTime(tdb);
    // Arrive as a hyperspeed jump would: the destination star (or system) becomes lit bodies and previously visited
    // ones are released. The ship controller owns that rule; without it (free camera) catalogue stars are handled here.
    // The anchor body must exist before the camera is placed, or the first frame would re-anchor the camera to
    // interstellar space and back (losing metres of float64 precision). SolarSystem.addBody is not safe to call twice
    // concurrently, so the star is awaited here first and the arrival hook then finds it present.
    const star = this.catalogIndex(s.anchor);
    if (star !== null && app.catalog && !sys.byId.has(s.anchor)) await sys.addBody(app.catalog.bodyDef(star), app.pool, app.frame);
    const arrive = this.ship?.hyper.onArrive;
    if (arrive) arrive(s.anchor);
    else for (const v of [...sys.views]) if (v.def.id.startsWith('*') && v.def.id !== s.anchor) sys.removeBody(v.def.id, app.frame);
    // Other external anchors (an exoplanet system's bodies, added by the arrival hook) load asynchronously.
    if (s.anchor !== 'ism' && !sys.byId.has(s.anchor)) await waitFor(() => sys.byId.has(s.anchor), 10_000);
    if (app.map?.isOpen) app.map.close();
    app.place({ pos: { anchor: s.anchor, offset: new Vec3d(...s.offset) }, quat: new THREE.Quaternion(...s.quat) });
    const ctl = this.ship;
    if (ctl) {
      if (s.target && this.targetKnown(s.target)) ctl.targetId = s.target;
      if (s.mode && (MODES as readonly string[]).includes(s.mode)) ctl.ship.setMode(s.mode as FlightMode);
    }
    return Math.abs(app.simTime - tdb) > 1 ? 'time-adjusted' : 'ok';
  }

  placeName(): string {
    const [near] = this.app.sys.nearest(this.app.cam.pos, this.app.simTime);
    return bodyName(near.def);
  }

  captureFrame(): string {
    // Render (not tick): this runs inside App.tick and must not advance input or the simulation.
    this.app.renderFrame();
    return this.app.renderer.domElement.toDataURL('image/png');
  }

  caption(): CaptionText {
    const app = this.app;
    const sys = app.sys;
    const p = app.cam.pos;
    const time = app.simTime;
    const [near, alt] = sys.nearest(p, time);
    const isStar = near.def.kind === 'star';
    const ground = isStar ? 0 : sys.surfaceHeightBelow(near, p, time);
    const star = sys.primaryStar(p, time);
    return captionFor({
      nearName: bodyName(near.def),
      nearIsStar: isStar,
      altitudeM: alt - ground,
      landed: this.ship?.ship.landed ?? false,
      starName: bodyName(star.def),
      starDistanceM: sys.bodyRelative(star.def.id, p, time, new Vec3d()).length(),
      utcMs: tdbSecondsSinceJ2000ToUnixMs(time),
    });
  }

  setScreenshotMode(active: boolean): void {
    const app = this.app;
    if (active) {
      this.cockpitBefore = app.cockpit !== null && app.frame.cockpitEnabled;
      app.setCockpitVisible(false);
      app.input.releasePointerLock();
      if (app.map?.isOpen) app.map.close();
    } else {
      app.setCockpitVisible(this.cockpitBefore);
    }
  }
}

/** Creates the share/screenshot controller for the running game. */
export function createGameShare(app: App): ShareController {
  return new ShareController({
    host: new GameShareHost(app),
    input: app.input,
    reducedMotion: () => app.reducedMotion,
  });
}
