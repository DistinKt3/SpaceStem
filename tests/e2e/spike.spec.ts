/**
 * M0 precision tests. Plate pairs (green in front of red, 0.1% of distance apart) sit at every decade from 3 m to
 * 3e12 m; any red pixel at a plate center is z-fighting. A naive single-range depth control must fail the same test,
 * proving the test can detect the failure. The jitter test parks the camera 1e12 m from the origin with a 1 m marker
 * 10 m ahead and nudges the camera by millimetres; camera-relative rendering keeps the marker in place, while the
 * absolute-origin control loses it to float32 rounding.
 */
import { test, expect, type Page } from '@playwright/test';

interface KS {
  info: { backend: string; reversedDepth: boolean };
  depthMode: string;
  plateViews: { decade: number; dir: [number, number, number] }[];
  setView(name: string): void;
  offsetCamera(dx: number, dy: number, dz: number): void;
  projectDir(x: number, y: number, z: number): [number, number];
  sample(points: [number, number][]): Promise<number[][]>;
  stats(): { partitions: number };
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/spike.html?msaa=0&bloom=0&cockpit=0&${query}`);
  await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined, null, { timeout: 120_000 });
}

/** Returns, per decade, the fraction of sampled pixels that are red (back plate showing through). */
async function plateRedFractions(page: Page): Promise<{ decade: number; red: number; green: number }[]> {
  return page.evaluate(async () => {
    const ks = (window as unknown as { __ks: KS }).__ks;
    ks.setView('plates');
    await new Promise((r) => setTimeout(r, 500));
    const pts: [number, number][] = [];
    const owners: number[] = [];
    for (const p of ks.plateViews) {
      const [cx, cy] = ks.projectDir(p.dir[0], p.dir[1], p.dir[2]);
      for (let dy = -6; dy <= 6; dy += 3) {
        for (let dx = -6; dx <= 6; dx += 3) {
          pts.push([cx + dx, cy + dy]);
          owners.push(p.decade);
        }
      }
    }
    const px = await ks.sample(pts);
    const res = ks.plateViews.map((p) => ({ decade: p.decade, red: 0, green: 0 }));
    px.forEach(([r, g], i) => {
      const o = res.find((x) => x.decade === owners[i])!;
      if (r! > g! + 30) o.red++;
      else if (g! > r! + 30) o.green++;
    });
    return res;
  });
}

const CONFIGS = [
  { name: 'WebGPU + reversed-Z', query: 'backend=webgpu&depth=reversed', backend: 'webgpu', depth: 'reversed' },
  { name: 'WebGPU + partitioned', query: 'backend=webgpu&depth=partitioned', backend: 'webgpu', depth: 'partitioned' },
  { name: 'WebGL2 + partitioned', query: 'backend=webgl2&depth=partitioned', backend: 'webgl2', depth: 'partitioned' },
  // Requesting reversed on WebGL2 must degrade to the partitioned baseline (three r186 constraint).
  { name: 'WebGL2 + reversed request', query: 'backend=webgl2&depth=reversed', backend: 'webgl2', depth: 'partitioned' },
];

for (const cfg of CONFIGS) {
  test(`no z-fighting from 3 m to 3e12 m: ${cfg.name}`, async ({ page }) => {
    await open(page, cfg.query);
    const meta = await page.evaluate(() => {
      const ks = (window as unknown as { __ks: KS }).__ks;
      return { backend: ks.info.backend, depth: ks.depthMode };
    });
    expect(meta).toEqual({ backend: cfg.backend, depth: cfg.depth });
    const res = await plateRedFractions(page);
    expect(res).toHaveLength(13);
    for (const r of res) {
      expect(r.red, `decade 3e${r.decade} m shows the back plate`).toBe(0);
      expect(r.green, `decade 3e${r.decade} m plate not visible`).toBeGreaterThan(20);
    }
  });
}

test('control: naive single depth range z-fights (the test can detect failure)', async ({ page }) => {
  await open(page, 'backend=webgpu&depth=naive');
  const res = await plateRedFractions(page);
  const fighting = res.filter((r) => r.red > 0).length;
  expect(fighting).toBeGreaterThanOrEqual(3);
});

for (const q of ['backend=webgpu&depth=reversed', 'backend=webgl2&depth=partitioned']) {
  test(`no jitter 1e12 m from origin with millimetre camera moves: ${q}`, async ({ page }) => {
    await open(page, q);
    const hits = await page.evaluate(async () => {
      const ks = (window as unknown as { __ks: KS }).__ks;
      ks.setView('jitter');
      const out: boolean[] = [];
      for (let i = 0; i < 6; i++) {
        ks.offsetCamera(0, 0.001, 0);
        const c = document.querySelector('canvas')!;
        const [px] = await ks.sample([[c.width / 2, c.height / 2]]);
        out.push(px![1]! > px![0]! + 30);
      }
      return out;
    });
    expect(hits.every(Boolean)).toBe(true);
  });
}

test('control: absolute world coordinates lose the marker at 1e12 m', async ({ page }) => {
  await open(page, 'backend=webgpu&depth=reversed&origin=absolute');
  const visible = await page.evaluate(async () => {
    const ks = (window as unknown as { __ks: KS }).__ks;
    ks.setView('jitter');
    const c = document.querySelector('canvas')!;
    const [px] = await ks.sample([[c.width / 2, c.height / 2]]);
    return px![1]! > px![0]! + 30;
  });
  expect(visible).toBe(false);
});
