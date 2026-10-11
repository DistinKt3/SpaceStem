/**
 * The guided opening in the real game (index.html): where it starts, how it follows the player's keys, the HUD,
 * Codex and Settings, and whether its landing advice matches the real flight model. The lab page
 * (tests/e2e/onboarding.spec.ts) covers the card itself step by step; boots here are slow under SwiftShader.
 */
import { test, expect, type Page } from '@playwright/test';

interface Vec {
  x: number;
  y: number;
  z: number;
  length(): number;
  clone(): Vec;
  normalize(): Vec;
  dot(v: Vec): number;
  scale(s: number): Vec;
  set(x: number, y: number, z: number): Vec;
  copy(v: Vec): Vec;
}
interface Snapshot {
  step?: string;
  targetId: string | null;
  targetBlockedBy: string | null;
  nearKey: string;
  altitudeM: number;
}
interface Game {
  app: {
    simTime: number;
    params: URLSearchParams;
    sys: {
      byId: Map<string, { rel: Vec; def: { radiusM: number } }>;
      update(pos: unknown, t: number, px: number): void;
    };
    cam: { pos: unknown };
    pxPerRadian(): number;
    paused: boolean;
    place(p: unknown): void;
    view(name: string): unknown;
    restartTour(): void;
    onboarding: { active: boolean; card: { stepId: string | null }; snapshot(): Snapshot | null } | null;
    controller: {
      targetId: string | null;
      autoAlign: boolean;
      ship: {
        pos: { anchor: string; offset: Vec };
        quat: { setFromUnitVectors(a: unknown, b: unknown): unknown };
        vel: Vec;
        mode: string;
        throttle: number;
        landed: boolean;
        telemetry: { agl: number };
        update(dt: number, c: unknown, sys: unknown, t: number): void;
      };
    };
    frame: { camera: { position: { constructor: new (x: number, y: number, z: number) => unknown } } };
  };
}

async function boot(page: Page, query: string, errors: string[], keepTour = false): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
  });
  // A first visit: no stored tour progress.
  if (!keepTour) await page.addInitScript(() => localStorage.removeItem('knownsky.onboarding'));
  await page.goto(`/?msaa=0&bloom=0&lock=0${query}`);
  await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined, null, { timeout: 180_000 });
}

const card = (page: Page) => page.locator('section.ks-onb');
const goal = (page: Page) => page.locator('.ks-onb-goal-text');
const game = <T>(page: Page, fn: (g: Game) => T): Promise<T> => page.evaluate<T>(`(${fn.toString()})(window.__ks)`);

test.describe('guided opening in the game', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('opens in low Earth orbit with the Moon up, follows the keys, the HUD, the Codex and Settings', async ({ page }) => {
    test.setTimeout(480_000);
    const errors: string[] = [];
    await boot(page, '', errors);
    await expect(card(page)).toBeVisible({ timeout: 60_000 });
    await expect(goal(page)).toHaveText('Look around');
    await expect(page.locator('.ks-onb-hint kbd[data-action="yaw"]')).toHaveText('A / D');
    // The start: 420 km above Earth, the Moon targeted and at least ~12 degrees above the horizon (review: from the
    // 'leo' view it is behind Earth on about a third of all dates).
    const start = await game(page, (g) => {
      const ship = g.app.controller.ship;
      const up = ship.pos.offset.clone().normalize();
      const moon = g.app.sys.byId.get('301')!.rel.clone().normalize();
      return {
        anchor: ship.pos.anchor,
        altKm: Math.round((ship.pos.offset.length() - g.app.sys.byId.get('399')!.def.radiusM) / 1000),
        moonElevDeg: 90 - (Math.acos(up.dot(moon)) * 180) / Math.PI,
        target: g.app.controller.targetId,
        blocked: g.app.onboarding!.snapshot()!.targetBlockedBy,
      };
    });
    expect(start).toMatchObject({ anchor: '399', altKm: 420, target: '301', blocked: null });
    expect(start.moonElevDeg).toBeGreaterThan(11.8);

    // Look around with the player's own keys: steer with D until the step is done.
    await page.locator('canvas').click({ position: { x: 900, y: 400 } });
    await page.keyboard.down('KeyD');
    await expect(goal(page)).toHaveText('Throttle up', { timeout: 180_000 });
    await page.keyboard.up('KeyD');
    await expect(page.locator('.ks-onb-hint kbd[data-action="thrust"][data-half="+"]')).toHaveText('W');

    // The HUD toggle hides the card with the HUD; the Codex hides it while open.
    await page.keyboard.press('KeyH');
    await expect(card(page)).toBeHidden();
    await page.keyboard.press('KeyH');
    await expect(card(page)).toBeVisible();
    await page.keyboard.press('KeyC');
    await expect(page.getByRole('dialog', { name: /Codex/i })).toBeVisible();
    await expect(card(page)).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /Codex/i })).toBeHidden();
    await expect(card(page)).toBeVisible();

    // Settings > Accessibility > Guided tour: End ends it (remembered) with the farewell note...
    await page.keyboard.press('Escape');
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await page.getByRole('tab', { name: 'Accessibility' }).click();
    const section = page.getByRole('region', { name: 'Guided tour' }).filter({ has: page.getByRole('button', { name: 'Restart guided tour' }) });
    await expect(section).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/onboarding-shots/20-settings-tour.png' });
    await page.getByRole('button', { name: 'End guided tour' }).click();
    await expect(settings).toBeHidden();
    await expect(goal(page)).toHaveText('Tour skipped');
    // Announced from the card's own live region, after the dialog closed (review: the panel's was hidden by then).
    await expect(page.locator('.ks-onb-sr[role="status"]')).toHaveText('Guided tour ended. Restart it any time from Settings.');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('knownsky.onboarding') ?? '{}') as unknown)).toMatchObject({
      status: 'skipped',
    });

    // ...and Restart replays it from the first step at the opening orbit, with the Moon targeted again.
    await game(page, (g) => {
      g.app.controller.targetId = '499';
      g.app.controller.autoAlign = true;
    });
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Accessibility' }).click();
    await expect(page.getByRole('button', { name: 'End guided tour' })).toBeHidden(); // nothing to end
    await page.getByRole('button', { name: 'Restart guided tour' }).click();
    await expect(settings).toBeHidden();
    await expect(goal(page)).toHaveText('Look around');
    await expect(page.locator('.ks-onb-sr[role="status"]')).toContainText('Guided tour, step 1 of 9: Look around.');
    expect(await game(page, (g) => ({ target: g.app.controller.targetId, autoAlign: g.app.controller.autoAlign, step: g.app.onboarding!.card.stepId }))).toEqual({
      target: '301',
      autoAlign: false,
      step: 'look',
    });
    expect(errors).toEqual([]);
  });

  test('the opening keeps the Moon in view on every date, where the old start had Earth in the way', async ({ page }) => {
    test.setTimeout(480_000);
    const errors: string[] = [];
    await boot(page, '', errors);
    const result = await game(page, (g) => {
      const app = g.app;
      app.paused = true;
      const t0 = app.simTime;
      const rows: { day: number; tour: number; tourBlocked: string | null; leoBlocked: string | null }[] = [];
      const elev = (): number => {
        const up = app.controller.ship.pos.offset.clone().normalize();
        const moon = app.sys.byId.get('301')!.rel.clone().normalize();
        return 90 - (Math.acos(up.dot(moon)) * 180) / Math.PI;
      };
      // 30 days in half-day steps (as the review sampled them).
      for (let k = 0; k < 60; k++) {
        app.simTime = t0 + k * 43_200;
        app.sys.update(app.cam.pos, app.simTime, app.pxPerRadian());
        app.place(app.view('leo'));
        app.sys.update(app.cam.pos, app.simTime, app.pxPerRadian());
        const leoBlocked = app.onboarding!.snapshot()!.targetBlockedBy;
        app.restartTour();
        app.sys.update(app.cam.pos, app.simTime, app.pxPerRadian());
        rows.push({ day: k / 2, tour: elev(), tourBlocked: app.onboarding!.snapshot()!.targetBlockedBy, leoBlocked });
      }
      return rows;
    });
    for (const r of result) {
      expect(r.tour, `day ${r.day}`).toBeGreaterThan(11.8);
      expect(r.tourBlocked, `day ${r.day}`).toBeNull();
    }
    // The check is meaningful: from the old start, Earth hides the Moon on a good part of the month.
    expect(result.filter((r) => r.leoBlocked === 'Earth').length).toBeGreaterThan(5);
    expect(errors).toEqual([]);
  });

  test('the landing advice matches the flight model: thrust along the nose, cut the throttle on the ground', async ({ page }) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    await boot(page, '&tour=0&t=2026-10-11T12:00:00Z', errors);
    // No tour with ?tour=0 (Settings can still start it in a ship session).
    await expect(card(page)).toHaveCount(0);
    const r = await game(page, (g) => {
      const app = g.app;
      const ship = app.controller.ship;
      const sys = app.sys;
      app.paused = true;
      const V3 = app.frame.camera.position.constructor;
      const none = { pitch: 0, yaw: 0, roll: 0, throttleRate: 0, strafeX: 0, strafeY: 0, boost: false, zeroThrottle: false, modeNext: false, modePrev: false, toggleFlightAssist: false };
      // Where the cruise drive drops out: 20 km above the Moon, at rest, nose on the Moon's centre (auto-align).
      const setup = (): void => {
        app.place(app.view('moon-orbit'));
        const off = ship.pos.offset;
        off.scale((sys.byId.get('301')!.def.radiusM + 20_000) / off.length());
        const n = off.clone().normalize();
        ship.quat.setFromUnitVectors(new V3(0, 0, -1), new V3(-n.x, -n.y, -n.z));
        ship.vel.set(0, 0, 0);
        ship.throttle = 0;
      };
      let t = app.simTime;
      // One game frame without rendering: the ship, then the world (body orientations and the terrain under the ship
      // follow the clock only through SolarSystem.update, as in App.tick). 10 frames/s, the game's slowest step.
      const px = app.pxPerRadian();
      const run = (secs: number, c: object, stop: () => boolean = () => false, dt = 0.1): void => {
        for (let i = 0; i * dt < secs && !stop(); i++) {
          ship.update(dt, c, sys, (t += dt));
          sys.update(ship.pos, t, px);
        }
      };
      // "The drive slows down by itself as you arrive": a full-throttle cruise arrival from 20,000 km drops out to
      // thrusters above the surface, even at 10 frames per second (it used to fly through the drop-out band).
      setup();
      ship.pos.offset.scale((sys.byId.get('301')!.def.radiusM + 2e7) / ship.pos.offset.length());
      ship.mode = 'cruise';
      ship.throttle = 1;
      run(60, none, () => ship.mode === 'thrusters', 0.1);
      // Set by the step that dropped out (the ground would switch to thrusters without it).
      const droppedOut = (ship.telemetry as { droppedOut?: boolean }).droppedOut === true;
      const arrival = { mode: ship.mode, throttle: ship.throttle, agl: ship.telemetry.agl, droppedOut, speed: ship.vel.length() };
      setup();
      run(0.1, none); // telemetry is updated by a step, not by a teleport
      const agl0 = ship.telemetry.agl;
      run(20, { ...none, strafeY: -1 }); // the old hint: "descend with F"
      const strafeAgl = ship.telemetry.agl;
      setup();
      ship.throttle = 0.3; // "ease down with W"
      run(240, none, () => ship.telemetry.agl < 3);
      const down = { agl: ship.telemetry.agl, landed: ship.landed, mode: ship.mode };
      run(1, { ...none, zeroThrottle: true }, () => ship.landed); // "cut the throttle with Backspace"
      const landed = ship.landed;
      // "Lift off first: rise with R": the ship leaves the ground. (Drifting low over uneven ground afterwards, a slow
      // contact can land it again: the flight model's own touchdown rule, which depends on the terrain.)
      run(0.3, { ...none, strafeY: 1 });
      const liftedOff = !ship.landed;
      // The settled touchdown only follows a ground contact: a ship hovering just above the clearance height with the
      // throttle cut, without touching, stays in the air.
      setup();
      run(0.05, none);
      const moon = sys.byId.get('301')!;
      const ground = moon.def.radiusM + (sys as unknown as { surfaceHeightBelow(v: unknown, p: unknown, t: number): number }).surfaceHeightBelow(moon, ship.pos, t);
      ship.pos.offset.scale((ground + 2.8) / ship.pos.offset.length());
      // At rest in the Moon's rotating surface frame (no drift over the terrain).
      const omega = (ship.constructor as unknown as { bodyOmega(v: unknown, t: number): Vec & { cross(v: Vec): Vec } }).bodyOmega(moon, t);
      ship.vel.copy(omega.cross(ship.pos.offset));
      run(0.05, none);
      run(1, none);
      return { arrival, agl0, strafeAgl, down, landed, liftedOff, hovering: { landed: ship.landed, agl: ship.telemetry.agl } };
    });
    expect(r.arrival).toMatchObject({ mode: 'thrusters', throttle: 0, droppedOut: true });
    // At the edge of the 20 km drop-out band (above the mean radius; the terrain is within about 11 km of it), not
    // stopped hundreds of km out and not in the ground.
    expect(r.arrival.agl).toBeGreaterThan(1_000);
    expect(r.arrival.agl).toBeLessThan(35_000);
    expect(r.arrival.speed).toBeLessThan(100); // at rest in the Moon's surface frame (~4.6 m/s at the equator)
    expect(r.strafeAgl).toBeGreaterThan(r.agl0 - 100); // strafing does not bring it down
    expect(r.down).toMatchObject({ landed: false, mode: 'thrusters' }); // on the ground, still under thrust
    expect(r.down.agl).toBeLessThan(3);
    expect(r.landed).toBe(true);
    expect(r.liftedOff).toBe(true);
    expect(r.hovering.landed).toBe(false);
    expect(r.hovering.agl).toBeLessThan(3); // within the settled band, yet not landed: no recent contact
    expect(errors).toEqual([]);
  });
});
