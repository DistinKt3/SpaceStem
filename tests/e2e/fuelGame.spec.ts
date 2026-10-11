/**
 * The fuel loop in the real game (index.html): the HUD gauge, a jump refused for lack of fuel and one paid for with
 * the player's hyperspeed key, the refund when a teleport aborts the spool, the "too close" state, and the emergency
 * climb near the Sun. One boot (slow under SwiftShader), several steps. `?fuel=` overrides the tank, so nothing is
 * written to the player's save.
 */
import { test, expect } from '@playwright/test';

interface Vec {
  x: number;
  y: number;
  z: number;
  length(): number;
  clone(): Vec;
  set(x: number, y: number, z: number): Vec;
}
interface Controller {
  targetId: string | null;
  update(dt: number, app: unknown): void;
  updateHud(app: unknown): void;
  hyper: { phase: string; spoolTime: number };
  ship: { pos: { anchor: string; offset: Vec }; vel: Vec; mode: string; throttle: number; landed: boolean; land(sys: unknown, view: unknown, t: number): void };
  fuel: { system: { hyperFuel: number; heat: number; heatState: string; refuel(a?: number): void }; climbing: boolean };
}
interface KsApp {
  paused: boolean;
  simTime: number;
  sys: { byId: Map<string, unknown> };
  catalog: { destinations(p: { x: number; y: number; z: number }, maxPc: number, limit: number): number[]; name(i: number): string };
  controller: Controller;
}
interface KS {
  app: KsApp;
  setView(name: string): void;
}

const SHOTS = 'test-results/fuel-shots';

test('fuel loop in the game: refusal, a paid jump, the refund on abort and the emergency climb', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
  });
  await page.goto('/?msaa=0&bloom=0&lock=0&fuel=0.1');
  await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined, null, { timeout: 180_000 });
  const gauge = page.locator('.ks-hud section.ks-fuel');
  const meter = gauge.getByRole('meter', { name: 'Hyper-fuel' });
  const warn = page.locator('.ks-hud-warn');

  // The gauge is part of the HUD, labelled as a game mechanic. The default target (the Moon) is not a star.
  await expect(gauge).toBeVisible();
  await expect(gauge).toHaveAccessibleName('Hyper-fuel and hull heat (game mechanic)');
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await expect(gauge).toHaveAttribute('data-low', 'true');
  await expect(gauge.locator('.ks-fuel-sub')).toHaveText('No star targeted');

  // The Sun seen from Earth orbit is a star, but too close to jump to.
  await page.evaluate(() => {
    (window as unknown as { __ks: KS }).__ks.app.controller.targetId = '10';
  });
  await expect(gauge.locator('.ks-fuel-sub')).toHaveText('Target star too close to jump to');

  // Proxima Centauri from 2 million km out: 15.7 % of the tank, more than the 10 % left.
  await page.evaluate(() => {
    const app = (window as unknown as { __ks: KS }).__ks.app;
    const cat = app.catalog;
    const idx = cat.destinations({ x: 0, y: 0, z: 0 }, 2, 20).find((i) => cat.name(i) === 'Proxima Centauri');
    const c = app.controller;
    c.ship.pos.offset.set(2e9, 0, 0);
    c.targetId = `*${idx}`;
  });
  await expect(gauge).toHaveAttribute('data-jump', 'short');
  await expect(gauge.locator('.ks-fuel-sub')).toHaveText('Next jump needs 16%');
  // The player presses the hyperspeed key (J by default): refused, nothing spent.
  await page.locator('canvas').click();
  await page.keyboard.press('KeyJ');
  await expect(warn).toContainText('Not enough hyper-fuel');
  await expect(warn).toContainText('game mechanic', { ignoreCase: true });
  expect(await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.app.controller.hyper.phase)).toBe('idle');
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await page.screenshot({ path: `${SHOTS}/game-refused.png` });

  // With a full tank the same key engages: 16 % is paid and the gauge shows the jump under way, not "not enough".
  // (A long spool keeps the test independent of the frame rate.)
  await page.evaluate(() => {
    const c = (window as unknown as { __ks: KS }).__ks.app.controller;
    c.fuel.system.refuel(1);
    c.hyper.spoolTime = 600;
  });
  await expect(gauge).toHaveAttribute('data-jump', 'ok');
  await page.keyboard.press('KeyJ');
  await expect(gauge).toHaveAttribute('data-jump', 'underway');
  await expect(gauge.locator('.ks-fuel-sub')).toHaveText('Jump under way · used 16%');
  await expect(meter).toHaveAttribute('aria-valuenow', '84');

  // A teleport during the spool aborts the jump: the fuel comes back.
  const phase = await page.evaluate(() => {
    const ks = (window as unknown as { __ks: KS }).__ks;
    const p = ks.app.controller.hyper.phase;
    ks.setView('leo');
    return p;
  });
  expect(phase).toBe('spool');
  await expect(meter).toHaveAttribute('aria-valuenow', '100');
  await expect(gauge).not.toHaveAttribute('data-jump', 'underway');

  // Near the Sun with a hot hull: the hull reaches its limit and the ship climbs away on its own. Rendering near the
  // Sun is very slow under SwiftShader, so the simulation is stepped here (0.1 s steps) while the paused game keeps
  // drawing the HUD.
  const start = await page.evaluate(() => {
    const app = (window as unknown as { __ks: KS }).__ks.app;
    const c = app.controller;
    const off = c.ship.pos.offset.clone().set(1.3 * 6.957e8, 0, 0);
    c.ship.pos = { anchor: '10', offset: off };
    c.ship.vel.set(0, 0, 0);
    c.ship.mode = 'cruise';
    c.ship.throttle = 0;
    c.fuel.system.heat = 0.98;
    app.paused = true;
    for (let i = 0; i < 10; i++) c.update(0.1, app);
    return { d: off.length(), climbing: c.fuel.climbing, state: c.fuel.system.heatState };
  });
  expect(start).toMatchObject({ climbing: true, state: 'emergency' });
  await expect(warn).toContainText('Emergency climb');
  await expect(gauge).toHaveAttribute('data-heat', 'emergency');
  await expect(gauge.locator('.ks-fuel-flag--heat')).toHaveText('Emergency');
  await page.screenshot({ path: `${SHOTS}/game-emergency.png` });
  const end = await page.evaluate(() => {
    const app = (window as unknown as { __ks: KS }).__ks.app;
    const c = app.controller;
    let steps = 0;
    for (; steps < 600 && c.fuel.climbing; steps++) c.update(0.1, app);
    app.paused = false;
    return { steps, d: c.ship.pos.anchor === '10' ? c.ship.pos.offset.length() : Infinity, state: c.fuel.system.heatState, throttle: c.ship.throttle, mode: c.ship.mode };
  });
  // The climb ends within a minute of game time, well away from the star, with the hull below critical and the
  // throttle back at zero.
  expect(end.steps).toBeLessThan(600);
  expect(end.d).toBeGreaterThan(2 * start.d);
  expect(end.state).not.toMatch(/critical|emergency/);
  expect(end).toMatchObject({ throttle: 0, mode: 'cruise' });
  await expect(warn).not.toContainText('Emergency climb');

  // A ship resting on the photosphere (thrusters cannot hold against a star's gravity) lifts off and climbs too.
  const lifted = await page.evaluate(() => {
    const app = (window as unknown as { __ks: KS }).__ks.app;
    const c = app.controller;
    const ship = c.ship;
    ship.mode = 'thrusters';
    ship.pos = { anchor: '10', offset: ship.pos.offset.clone().set(6.957e8 + 2.5, 0, 0) };
    ship.vel.set(0, 0, 0);
    ship.land(app.sys, app.sys.byId.get('10'), app.simTime);
    c.fuel.system.heat = 0.99;
    app.paused = true;
    const before = ship.landed;
    for (let i = 0; i < 40; i++) c.update(0.1, app);
    const mid = { landed: ship.landed, climbing: c.fuel.climbing };
    for (let i = 0; i < 900 && c.fuel.climbing; i++) c.update(0.1, app);
    app.paused = false;
    return { before, ...mid, end: ship.pos.anchor === '10' ? ship.pos.offset.length() / 6.957e8 : Infinity };
  });
  expect(lifted).toMatchObject({ before: true, landed: false, climbing: true });
  expect(lifted.end).toBeGreaterThan(3);

  // ?fuel= is a test override: the player's saved tank is left alone.
  expect(await page.evaluate(() => localStorage.getItem('knownsky.fuel'))).toBeNull();
  expect(errors).toEqual([]);
});
