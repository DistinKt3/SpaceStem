/**
 * Map and HUD accessibility in the game (index.html):
 * - the map dialog is named, its destination list is a valid listbox, and it is fully usable from the keyboard
 *   (Tab, arrows, Enter / Space, Escape or M to close, focus restored) and from a gamepad;
 * - opening the map again reuses its materials and frees per-object renderer state (no leak, no per-dot shader);
 * - at text scale 2, map labels do not overlap and HUD panels do not overlap each other.
 */
import { test, expect, type Page } from '@playwright/test';

interface Vec {
  x: number;
  y: number;
  z: number;
  clone(): Vec;
  set(x: number, y: number, z: number): Vec;
  project(c: unknown): Vec;
}
interface KsApp {
  reducedMotion: boolean;
  settings: { set(p: Record<string, unknown>): void };
  input: { enabled: boolean };
  renderer: { _objects: { _renderObjects: Set<unknown> } };
  map: {
    open(mode?: string): void;
    close(): void;
    isOpen: boolean;
    scene: { children: { material: unknown }[] };
    camera: { position: Vec };
    controls: { enableDamping: boolean } | null;
  };
  controller: { targetId: string | null; hud: { update(s: Record<string, unknown>, cam: unknown): void } };
}
interface KS {
  app: KsApp;
  capture(): string;
}

async function boot(page: Page, errors: string[], init?: () => void): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
  });
  if (init) await page.addInitScript(init);
  await page.goto('/?msaa=0&bloom=0');
  await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined, null, { timeout: 180_000 });
}

test('map dialog: named, valid listbox, keyboard navigation, focus restored', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  // Boot progress and failure are announced.
  await expect(page.locator('#boot-status')).toHaveAttribute('role', 'status');
  await expect(page.locator('#boot-status')).toHaveAttribute('aria-live', 'polite');

  await page.locator('canvas').click();
  await page.keyboard.press('KeyM');
  const dialog = page.getByRole('dialog', { name: 'System map' });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.app.input.enabled)).toBe(false);
  // The listbox owns only options; "you are here" is information, not an option.
  const listbox = page.getByRole('listbox', { name: 'Destinations' });
  await expect(listbox).toBeVisible();
  expect(await listbox.evaluate((el) => [...el.children].every((c) => c.getAttribute('role') === 'option'))).toBe(true);
  await expect(page.getByRole('option', { name: /You are here/ })).toHaveCount(0);
  await expect(page.locator('.ks-map-here')).toContainText('You are here');

  // Focus starts in the list; Tab cycles between the map switch and the list (one tab stop), never stuck.
  const focused = (): Promise<string> => page.evaluate(() => `${document.activeElement?.className}|${document.activeElement?.querySelector('.n')?.textContent ?? document.activeElement?.textContent}`);
  expect(await focused()).toMatch(/^ks-map-entry\|/);
  await page.keyboard.press('Tab');
  expect(await focused()).toMatch(/^ks-map-mode\|/);
  await page.keyboard.press('Tab');
  expect(await focused()).toMatch(/^ks-map-entry\|/);
  await page.keyboard.press('Shift+Tab');
  expect(await focused()).toMatch(/^ks-map-mode\|/);
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toMatch(/^ks-map-entry\|/);

  // Arrows move through the options; Enter and Space set the target.
  await page.keyboard.press('Home');
  expect(await focused()).toBe('ks-map-entry|Sun');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('ks-map-entry|Venus');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.app.controller.targetId)).toBe('299');
  await expect(page.getByRole('option', { name: /^Venus/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.app.controller.targetId)).toBe('399');
  await page.keyboard.press('End');
  expect(await focused()).not.toBe('ks-map-entry|Earth');

  // The map switch works from the keyboard and keeps focus.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Star map' })).toBeVisible();
  await expect(page.getByRole('option', { name: /^Proxima Centauri, .* ly · M5Ve$/ })).toBeVisible();
  // Distances go through the locale formatter: the Sun from inside the Solar System reads in au, not "0.00 ly".
  await expect(page.getByRole('option', { name: /^Sun, [\d.]+ au$/ })).toBeVisible();
  expect(await focused()).toMatch(/^ks-map-mode\|/);

  // Escape closes, game input comes back, and the HUD returns.
  await page.keyboard.press('Escape');
  await expect(page.locator('.ks-map')).toBeHidden();
  await expect(page.locator('.ks-hud')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.app.input.enabled)).toBe(true);
  // M opens and M closes (the toggle binding is routed through the map while it is open).
  await page.keyboard.press('KeyM');
  await expect(page.locator('.ks-map')).toBeVisible();
  await page.keyboard.press('KeyM');
  await expect(page.locator('.ks-map')).toBeHidden();

  // Focus returns to where it was when the map opened.
  const back = await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'probe';
    document.body.appendChild(b);
    b.focus();
    (window as unknown as { __ks: KS }).__ks.app.map.open('system');
    const inside = document.activeElement?.closest('.ks-map') !== null;
    (window as unknown as { __ks: KS }).__ks.app.map.close();
    const id = document.activeElement?.id;
    b.remove();
    return { inside, id };
  });
  expect(back).toEqual({ inside: true, id: 'probe' });

  // Reduced motion: the map camera has no inertia.
  const damping = await page.evaluate(() => {
    const app = (window as unknown as { __ks: KS }).__ks.app;
    app.settings.set({ reducedMotion: true });
    app.map.open('system');
    const reduced = app.map.controls?.enableDamping;
    app.map.close();
    app.settings.set({ reducedMotion: false });
    app.map.open('system');
    const normal = app.map.controls?.enableDamping;
    app.map.close();
    return { reduced, normal };
  });
  expect(damping).toEqual({ reduced: false, normal: true });

  // Reopening the star map reuses the shared materials and frees per-object renderer state.
  const opens = await page.evaluate(() => {
    const app = (window as unknown as { __ks: KS }).__ks.app;
    const out: { materials: number; mapObjects: number; children: number }[] = [];
    for (let i = 0; i < 3; i++) {
      app.map.open('stars');
      (window as unknown as { __ks: KS }).__ks.capture();
      const scene = app.map.scene;
      const mapObjects = [...app.renderer._objects._renderObjects].filter((r) => (r as { scene: unknown }).scene === scene).length;
      out.push({ materials: new Set(scene.children.map((c) => c.material)).size, mapObjects, children: scene.children.length });
      app.map.close();
      (window as unknown as { __ks: KS }).__ks.capture();
    }
    return out;
  });
  for (const o of opens) {
    expect(o.materials).toBeLessThanOrEqual(3);
    // Only the objects on screen now: render objects of previous opens were released.
    expect(o.mapObjects).toBeLessThanOrEqual(o.children);
  }
  expect(errors).toEqual([]);
});

test('map works with a gamepad: View opens, D-pad and A choose, View closes', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors, () => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false }));
    const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons };
    (window as unknown as { __pad: typeof pad }).__pad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad], configurable: true });
  });
  // One press: down for one frame, then up for one frame (frames are rendered synchronously by capture()).
  const press = (button: number): Promise<void> =>
    page.evaluate((b) => {
      const btn = (window as unknown as { __pad: { buttons: { pressed: boolean; value: number }[] } }).__pad.buttons[b]!;
      Object.assign(btn, { pressed: true, value: 1 });
      (window as unknown as { __ks: KS }).__ks.capture();
      Object.assign(btn, { pressed: false, value: 0 });
      (window as unknown as { __ks: KS }).__ks.capture();
    }, button);
  const VIEW = 8;
  const A = 0;
  const DOWN = 13;
  await press(VIEW);
  expect(await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.app.map.isOpen)).toBe(true);
  await expect(page.locator('.ks-map-help')).toContainText('Right stick');
  const focusedName = (): Promise<string | null | undefined> => page.evaluate(() => document.activeElement?.querySelector('.n')?.textContent);
  expect(await focusedName()).toBe('Sun');
  await press(DOWN);
  expect(await focusedName()).toBe('Mercury');
  await press(A);
  expect(await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.app.controller.targetId)).toBe('199');
  await press(VIEW);
  expect(await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.app.map.isOpen)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.app.input.enabled)).toBe(true);
  expect(errors).toEqual([]);
});

test('text scale 2: map labels and HUD panels do not overlap', async ({ page }) => {
  const errors: string[] = [];
  await page.setViewportSize({ width: 1280, height: 720 });
  await boot(page, errors);
  await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.app.settings.set({ textScale: 2 }));
  // HUD with a long cockpit footer (jump ETA), a warning and reverse thrust.
  await page.evaluate(() => {
    const hud = (window as unknown as { __ks: KS }).__ks.app.controller.hud;
    const orig = hud.update.bind(hud);
    hud.update = (s, cam) => orig({ ...s, warnings: ['Dropped out of drive near surface'], footer: 'Arrival in 21 s', mode: 'cruise', throttle: -0.5 }, cam);
  });
  await page.waitForFunction(() => /Arrival/.test(document.querySelector('.ks-hud-footer')?.textContent ?? '') && getComputedStyle(document.querySelector('.ks-hud-warn')!).display !== 'none', null, { timeout: 60_000 });
  const hud = await page.evaluate(() => {
    const rect = (s: string): DOMRect | null => {
      const e = document.querySelector(s);
      return e && getComputedStyle(e).display !== 'none' ? e.getBoundingClientRect() : null;
    };
    const names = ['.ks-hud-top', '.ks-hud-footer', '.ks-hud-left', '.ks-hud-right', '.ks-hud-warn'];
    const rs = names.map((n) => [n, rect(n)] as const).filter((x): x is readonly [string, DOMRect] => x[1] !== null);
    const hits: string[] = [];
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i]![1];
        const b = rs[j]![1];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) hits.push(`${rs[i]![0]} x ${rs[j]![0]}`);
      }
    }
    const meter = document.querySelector('.ks-throttle');
    return { shown: rs.length, hits, valuetext: meter?.getAttribute('aria-valuetext'), role: meter?.getAttribute('role') };
  });
  expect(hud.shown).toBe(5);
  expect(hud.hits).toEqual([]);
  expect(hud).toMatchObject({ role: 'meter', valuetext: 'Reverse 50%' });

  // The finding's example (1024x768 at text scale 2) has a tall title box: the scene must clear it as well as the list.
  for (const size of [{ width: 1280, height: 720 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    for (const mode of ['system', 'stars']) {
      const map = await page.evaluate((m) => {
        const app = (window as unknown as { __ks: KS }).__ks.app;
        app.map.open(m);
        (window as unknown as { __ks: KS }).__ks.capture();
        const vis = [...document.querySelectorAll<HTMLElement>('.ks-map-label, .ks-map-ring')].filter((e) => e.style.display !== 'none');
        const rs = vis.map((e) => e.getBoundingClientRect());
        let overlapsN = 0;
        for (let i = 0; i < rs.length; i++) {
          for (let j = i + 1; j < rs.length; j++) {
            const a = rs[i]!;
            const b = rs[j]!;
            if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlapsN++;
          }
        }
        const list = document.querySelector('.ks-map-list')!.getBoundingClientRect();
        const cam = app.map.camera;
        const c = cam.position.clone().set(0, 0, 0).project(cam);
        const centreX = ((c.x + 1) / 2) * innerWidth;
        const centreY = ((1 - c.y) / 2) * innerHeight;
        const title = document.querySelector('.ks-map-title')!.getBoundingClientRect();
        const underTitle = centreX > title.left && centreX < title.right && centreY > title.top && centreY < title.bottom;
        app.map.close();
        return { visible: vis.length, overlapsN, centreLeftOfList: centreX < list.left, underTitle };
      }, mode);
      const label = `${mode} ${size.width}x${size.height}`;
      expect(map.visible, label).toBeGreaterThan(1);
      expect(map.overlapsN, label).toBe(0);
      expect(map.centreLeftOfList, label).toBe(true);
      expect(map.underTitle, label).toBe(false);
    }
  }
  expect(errors).toEqual([]);
});
