/**
 * The guided opening in the game (docs/ONBOARDING.md, "Integration"): when it runs, where it starts, the snapshot it
 * reads from the ship each frame, and restarting it from Settings. The App owns one GameTour and calls start(),
 * update() and restart(); everything else about the tour lives in this folder.
 */
import { Vec3d } from '../../core/vec3d';
import type { App } from '../app';
import { bodyLabel } from '../i18n';
import { FLIGHT } from '../ship/ship';
import { ShipController } from '../ship/shipController';
import { above, latLonDir, type Placement } from '../views';
import { START_ALTITUDE_M } from './facts';
import { Onboarding } from './onboarding';
import { LookTracker, actionLabel, angleBetween, isAligned, openingUp, pathBlocker, type ObstacleLike } from './snapshot';
import { MOON_ID } from './steps';
import type { OnboardingSnapshot } from './types';

/** Share links open with a fragment like "#ks1.<payload>" (src/game/share): they go to a shared place instead. */
const SHARE_FRAGMENT = /^#ks\d+\./;

/**
 * The tour belongs to the default start in low Earth orbit. Named test views, the free camera, share links and
 * ?tour=0 leave it off (it can still be started from Settings in a ship session).
 */
export function tourEnabled(params: URLSearchParams, hash = ''): boolean {
  return (
    (params.get('view') ?? 'leo') === 'leo' &&
    params.get('free') !== '1' &&
    params.get('tour') !== '0' &&
    !SHARE_FRAGMENT.test(hash)
  );
}

const DEG = Math.PI / 180;

/**
 * Where the tour starts: 420 km above Earth, above the point where the Moon stands 13 degrees or more above the
 * horizon and the Sun is as high as that allows (openingUp; 55 degrees from the zenith, the lighting of
 * App.view('leo'), whenever the Moon's position permits). From App.view('leo') itself the Moon is behind Earth on
 * about a third of all dates, and a pilot following the tour would fly into Earth. The view looks along the horizon
 * 20 degrees left of the Sun's direction, pitched down 18 degrees, like App.view('leo').
 */
export function tourStart(app: App): Placement {
  const sys = app.sys;
  const earth = sys.byId.get('399')!;
  const centre = { anchor: '399', offset: new Vec3d() };
  // Directions from Earth's centre in its body-fixed frame (views.ts `above` takes body-fixed latitude/longitude).
  const sun = sys.bodyRelative('10', centre, app.simTime, new Vec3d()).applyMat3Transpose(earth.rotation).normalize();
  const moon = sys.bodyRelative(MOON_ID, centre, app.simTime, new Vec3d()).applyMat3Transpose(earth.rotation).normalize();
  const sunLat = Math.asin(sun.z) / DEG;
  const sunLon = Math.atan2(sun.y, sun.x) / DEG;
  const up = openingUp(sun, moon, latLonDir(sunLat * 0.5, sunLon - 55));
  const lat = Math.asin(Math.max(-1, Math.min(1, up.z))) / DEG;
  const lon = Math.atan2(up.y, up.x) / DEG;
  // The Sun's compass heading seen from there (local north and east, as `above` builds them).
  const u = new Vec3d(up.x, up.y, up.z);
  const east = new Vec3d(0, 0, 1).cross(u).normalize();
  const north = u.clone().cross(east).normalize();
  const sunHeading = Math.atan2(sun.dot(east), sun.dot(north)) / DEG;
  return above(sys, '399', lat, lon, START_ALTITUDE_M, sunHeading - 20, -18);
}

/** Bodies that can stand in the way of a target, relative to the camera (the ship) as of the last world update. */
function* obstacles(app: App): Generator<ObstacleLike> {
  for (const v of app.sys.views) yield { key: v.def.key, id: v.def.id, rel: v.rel, radiusM: v.def.radiusM };
}

/** Everything the tour reads from the game in one frame. */
export function shipSnapshot(app: App, ctl: ShipController, look: LookTracker): OnboardingSnapshot {
  const ship = ctl.ship;
  const tel = ship.telemetry;
  const id = ctl.targetId;
  const info = id ? ctl.targetInfo(id) : null;
  const [near, alt] = app.sys.nearest(ship.pos, app.simTime);
  const fwd = ship.forward();
  let blockedBy: string | null = null;
  if (info && id && info.kind !== 'star') {
    const b = pathBlocker(info.rel, id, obstacles(app));
    const view = b ? app.sys.byId.get(b.id) : undefined;
    if (view) blockedBy = bodyLabel(view.def);
  }
  // Flying on along the nose: would the ship run into the nearest body (its drop-out height)?
  const ahead = { x: fwd.x * 1e9, y: fwd.y * 1e9, z: fwd.z * 1e9 };
  const nearObstacle = { key: near.def.key, id: near.def.id, rel: near.rel, radiusM: near.def.radiusM };
  const noseBlockedBy = near.def.kind !== 'star' && pathBlocker(ahead, '', [nearObstacle]) ? bodyLabel(near.def) : null;
  const anchor = ship.pos.anchor;
  const map = app.map;
  return {
    t: app.simTime,
    mode: ship.mode,
    throttle: ship.throttle,
    speed: ctl.hyper.phase === 'jump' ? ctl.hyper.speed : ship.mode === 'thrusters' ? tel.surfaceSpeed : tel.speed,
    nearKey: near.def.key,
    nearName: bodyLabel(near.def),
    nearKind: near.def.kind,
    nearRadiusM: near.def.radiusM,
    altitudeM: alt,
    aglM: tel.agl,
    landed: ship.landed,
    autoAlign: ctl.autoAlign,
    targetId: id,
    targetName: info?.name ?? null,
    targetKind: info?.kind ?? null,
    targetDistanceM: info ? Math.max(0, info.rel.length() - info.radius) : null,
    alignedToTarget: info !== null && isAligned(fwd, info.rel, info.radius),
    targetOffNoseRad: info ? angleBetween(fwd, info.rel) : null,
    targetBlockedBy: blockedBy,
    noseBlockedBy,
    mapOpen: map?.isOpen ?? false,
    mapMode: map?.isOpen ? map.mode : null,
    codexOpen: app.codex.ui.isOpen,
    hyperPhase: ctl.hyper.phase,
    anchor,
    beyondSol: anchor.startsWith('*') || app.exoOf(anchor) !== undefined,
    lookedAroundRad: look.update(app.cam.quat),
    thrustersTopSpeedMS: FLIGHT.thrustersMaxSpeed,
  };
}

/** The tour card wired to the game: bindings, device, reduced motion, sound, the ship and the HUD toggle. */
export class GameTour {
  readonly card: Onboarding;
  private readonly look = new LookTracker();

  constructor(private readonly app: App) {
    this.card = new Onboarding({
      parent: document.body,
      labelFor: (a, half) => actionLabel(app.settings.data, app.input.activeDevice, a, half),
      device: () => app.input.activeDevice,
      reducedMotion: () => app.reducedMotion,
      onStepChange: (id) => {
        if (id !== 'skipped') app.audio.play('ui-select'); // captioned "[Soft chime]"
      },
    });
  }

  /** True while a step or the closing card shows. */
  get active(): boolean {
    return this.card.active;
  }

  /** True when start() would show the tour (new or in progress), so the game should begin at tourStart(). */
  get willShow(): boolean {
    return this.card.willShow;
  }

  /** Shows the card (or resumes at the remembered step) once the game is running. */
  start(): void {
    this.card.start();
  }

  /**
   * One frame: the card follows the HUD toggle and judges the ship's state. Only a ship session runs the tour (the
   * free camera has no ship). Pass dt = 0 to hold the tour still (the Codex is open).
   */
  update(dt: number): void {
    const ctl = this.app.controller;
    if (!(ctl instanceof ShipController)) return;
    this.card.setVisible(ctl.hud.isVisible);
    this.card.update(dt, shipSnapshot(this.app, ctl, this.look));
  }

  /** What the tour would judge right now (tests and debugging); null outside a ship session. */
  snapshot(): OnboardingSnapshot | null {
    const ctl = this.app.controller;
    return ctl instanceof ShipController ? shipSnapshot(this.app, ctl, this.look) : null;
  }

  /** Settings > Restart guided tour: back to the opening orbit with the Moon targeted, tour from the first step. */
  restart(): void {
    const app = this.app;
    const ctl = app.controller;
    if (!(ctl instanceof ShipController) || !app.sys) return;
    app.map?.close();
    app.place(tourStart(app));
    ctl.targetId = MOON_ID;
    ctl.autoAlign = false;
    this.look.reset();
    this.card.restart();
  }

  /** Settings > End guided tour (remembered). */
  end(): void {
    this.card.skip();
  }

  dispose(): void {
    this.card.dispose();
  }
}
