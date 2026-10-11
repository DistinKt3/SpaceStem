import { defineConfig } from '@playwright/test';

/**
 * Browser tests run in Chromium with SwiftShader (no GPU in CI or the dev container). Flags enable WebGPU and the
 * Vulkan path needed for WebGPU readback. Locally we use the pre-installed browser; CI installs its own.
 */
const executablePath = process.env['CI'] ? undefined : '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/** Override with KS_PORT when several checkouts run tests at once. */
const port = Number(process.env['KS_PORT'] ?? 5174);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 800, height: 450 },
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: [
        '--enable-unsafe-webgpu',
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        '--enable-features=Vulkan',
        '--use-vulkan=swiftshader',
        '--disable-vulkan-surface',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}/spike.html`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
