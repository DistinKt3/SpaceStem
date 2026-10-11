// Dev helper: capture a hyperspeed jump (HUD composited over the in-page canvas capture).
// Usage: node tools/dev/jump.mjs <url> <outPrefix> [star name]   (W/H env for viewport, JPG=1 for JPEG output)
import { chromium } from '@playwright/test';

const [url, out, starName = 'Rigil Kentaurus'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 720) } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.__ks !== undefined, null, { timeout: 180000 });

async function shot(tag) {
  const data = await page.evaluate(() => window.__ks.capture());
  await page.evaluate((src) => {
    const img = document.createElement('img');
    img.id = '__cap';
    img.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:0;pointer-events:none';
    document.body.appendChild(img);
    img.src = src;
    return img.decode();
  }, data);
  const path = `${out}_${tag}.${process.env.JPG ? 'jpg' : 'png'}`;
  await page.screenshot({ path, ...(process.env.JPG ? { type: 'jpeg', quality: 82 } : {}) });
  await page.evaluate(() => document.getElementById('__cap')?.remove());
  console.log('wrote', path);
}

// Leave Earth's gravity well, target the star, engage, and step the simulation (the RAF loop also runs).
const ok = await page.evaluate((name) => {
  const app = window.__ks.app;
  const c = app.controller;
  c.ship.pos.offset.set(2e9, 0, 0);
  const here = { x: 0, y: 0, z: 0 };
  const idx = app.catalog.destinations(here, 5, 40).find((i) => app.catalog.name(i) === name);
  if (idx === undefined) return false;
  c.targetId = `*${idx}`;
  c.engageHyperspeed();
  for (let k = 0; k < 30; k++) c.update(0.5, app); // spool (3 s) + 12 s of transit
  return true;
}, starName);
if (!ok) throw new Error(`star not found: ${starName}`);
await page.waitForTimeout(500);
await shot('jump');
await page.evaluate(() => {
  const app = window.__ks.app;
  for (let k = 0; k < 80 && app.controller.hyper.phase !== 'idle'; k++) app.controller.update(0.5, app);
});
await page.waitForTimeout(6000);
await shot('arrive');
if (errors.length) console.log(errors.join('\n'));
await browser.close();
