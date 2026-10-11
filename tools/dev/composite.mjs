// Dev helper: page screenshots with the DOM HUD over an in-page canvas capture (WebGPU canvases screenshot black in
// SwiftShader, so the frame is captured with toDataURL and shown under the HUD before the page screenshot).
// Usage: node tools/dev/composite.mjs <url> <outPrefix> <view1,view2,...> [settleMs]
// Env: W, H (viewport), JPG=1 to write JPEG (quality 82) instead of PNG.
import { chromium } from '@playwright/test';

const [url, out, viewsArg = 'leo', settleArg = '2500'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 720) } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 300));
});
await page.goto(url);
await page.waitForFunction(() => window.__ks !== undefined, null, { timeout: 180000 });
for (const v of viewsArg.split(',')) {
  await page.evaluate((name) => window.__ks.setView(name), v);
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => window.__ks.pending() === 0, null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(Number(settleArg));
  const data = await page.evaluate(() => window.__ks.capture());
  await page.evaluate((src) => {
    const img = document.createElement('img');
    img.id = '__cap';
    img.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:0;pointer-events:none';
    document.body.appendChild(img);
    img.src = src;
    return img.decode();
  }, data);
  const path = `${out}_${v}.${process.env.JPG ? 'jpg' : 'png'}`;
  await page.screenshot({ path, ...(process.env.JPG ? { type: 'jpeg', quality: 82 } : {}) });
  await page.evaluate(() => document.getElementById('__cap')?.remove());
  console.log('wrote', path);
}
if (errors.length) console.log(errors.join('\n'));
await browser.close();
