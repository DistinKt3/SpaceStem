// Dev helper: open a page in Chromium (SwiftShader), run optional view setup, and save in-page canvas captures.
// Usage: node tools/dev/shot.mjs <url> <outPrefix> [view1,view2,...] [waitMs]
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const [url, out, viewsArg = '', waitArg = '6000'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 800), height: Number(process.env.H ?? 450) } });
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.__ks !== undefined, null, { timeout: 60000 }).catch(() => {});
const views = viewsArg ? viewsArg.split(',') : [''];
for (const v of views) {
  if (v) await page.evaluate((name) => window.__ks?.setView?.(name), v);
  await page.waitForTimeout(Number(waitArg));
  const data = await page.evaluate(() => window.__ks?.capture?.() ?? document.querySelector('canvas')?.toDataURL());
  if (data) writeFileSync(`${out}${v ? '_' + v : ''}.png`, Buffer.from(data.split(',')[1], 'base64'));
  const hud = await page.evaluate(() => document.getElementById('hud')?.textContent ?? '');
  console.log(`--- ${v}\n${hud}`);
}
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
