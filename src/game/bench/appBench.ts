/**
 * The benchmark against the real game (`?bench=1`). createAppBenchDriver implements BenchDriver over App's public API:
 *
 *   - setView: App.place(App.view(name)) (the named placements used by tests and screenshots),
 *   - waitIdle: renders frames until the terrain worker pool has had no pending chunks for `settleFrames` frames,
 *   - frame: waits for the next animation frame, runs App.tick(), then waits until the GPU has finished the submitted
 *     work (WebGPU: queue.onSubmittedWorkDone; WebGL2: a fence). `ms` is that whole span: the frame's cost without
 *     waiting for the display, so a fast machine shows its headroom instead of a vsync-capped 16.7 ms. CPU and GPU do
 *     not overlap in this measure, so it is an upper bound on the pipelined frame time while playing.
 *   - stats: FrameRenderer.stats (draw calls and triangles of the scene passes, from renderer.info).
 *
 * While the driver runs it owns the frame loop: App's own requestAnimationFrame loop keeps going, but App.tick is
 * replaced by a no-op on the instance until release(), so frames are never rendered twice.
 */
import type * as THREE from 'three/webgpu';
import type { App } from '../app';
import type { QualityName } from '../../render/quality/quality';
import { BenchPanel, DEFAULT_BENCH_VIEWS, runBench, type BenchDriver, type BenchFrame, type BenchOptions, type BenchReport } from './bench';

export interface AppBenchDriverOptions {
  /** Give up waiting for terrain streaming after this long, ms. Default 20 000. */
  idleTimeoutMs?: number;
  /** Consecutive frames without pending chunks before a view counts as loaded. Default 30. */
  settleFrames?: number;
}

export interface AppBenchDriver extends BenchDriver {
  /** Give the frame loop back to App. */
  release(): void;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Yields one macrotask without the 4 ms clamping of nested setTimeout. */
function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

interface BackendHandles {
  device?: GPUDevice;
  gl?: WebGL2RenderingContext;
}

/** Resolves when the GPU has finished all work submitted so far (best effort; resolves at once if it cannot tell). */
export async function gpuDone(renderer: THREE.WebGPURenderer, timeoutMs = 2000): Promise<void> {
  const backend = (renderer as unknown as { backend?: BackendHandles }).backend;
  if (backend?.device) {
    await backend.device.queue.onSubmittedWorkDone();
    return;
  }
  const gl = backend?.gl;
  if (!gl) return;
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return;
  gl.flush();
  const until = performance.now() + timeoutMs;
  try {
    // Sync status only updates between tasks, so poll with a yield (not a busy loop).
    while (performance.now() < until) {
      const s = gl.clientWaitSync(sync, 0, 0);
      if (s === gl.ALREADY_SIGNALED || s === gl.CONDITION_SATISFIED || s === gl.WAIT_FAILED) return;
      await yieldTask();
    }
  } finally {
    gl.deleteSync(sync);
  }
}

export function createAppBenchDriver(app: App, opts: AppBenchDriverOptions = {}): AppBenchDriver {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 20_000;
  const settleFrames = opts.settleFrames ?? 30;
  const tick = app.tick.bind(app);
  // Take over the loop: App.start()'s requestAnimationFrame loop calls this.tick(), which now does nothing.
  app.tick = (): void => undefined;
  let released = false;
  return {
    setView(name) {
      app.place(app.view(name));
    },
    async waitIdle() {
      const deadline = performance.now() + idleTimeoutMs;
      let quiet = 0;
      while (quiet < settleFrames && performance.now() < deadline) {
        await nextFrame();
        tick();
        quiet = app.pool.pending === 0 ? quiet + 1 : 0;
      }
    },
    async frame(): Promise<BenchFrame> {
      await nextFrame();
      const t0 = performance.now();
      tick();
      const cpuMs = performance.now() - t0;
      await gpuDone(app.renderer);
      const ms = performance.now() - t0;
      const s = app.frame.stats;
      return { ms, cpuMs, drawCalls: s.drawCalls, triangles: s.triangles };
    },
    info() {
      const c = app.renderer.domElement;
      return {
        backend: app.info.backend,
        adapter: app.info.adapter,
        dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
        width: c.width,
        height: c.height,
        userAgent: navigator.userAgent,
      };
    },
    release() {
      if (released) return;
      released = true;
      // Drop the instance override so App.prototype.tick is used again.
      Reflect.deleteProperty(app, 'tick');
    },
  };
}

export interface AppBenchOptions extends Omit<BenchOptions, 'onProgress'>, AppBenchDriverOptions {
  /** Where the progress card and results dialog go. Default document.body. */
  parent?: HTMLElement;
  /** Quality level the run uses (recorded in the report). The caller pins it in onStart. */
  quality?: QualityName;
  /** Called before the first view (pin adaptive quality here) and after the last (unpin). */
  onStart?: () => void;
  onFinish?: () => void;
}

/**
 * Runs the benchmark in the game: disables player input, shows progress, visits the views, restores the camera, then
 * shows the results dialog (input comes back when it closes) and logs the report as JSON. URL overrides:
 * benchViews=a,b,c and benchFrames=<n> (useful for quick checks).
 */
export async function runAppBench(app: App, opts: AppBenchOptions = {}): Promise<BenchReport> {
  const views = opts.views ?? app.params.get('benchViews')?.split(',').filter(Boolean) ?? DEFAULT_BENCH_VIEWS;
  const frames = Number(app.params.get('benchFrames'));
  const panel = new BenchPanel(opts.parent ?? document.body);
  const home = { pos: { anchor: app.cam.pos.anchor, offset: app.cam.pos.offset.clone() }, quat: app.cam.quat.clone() };
  const inputWas = app.input.enabled;
  app.input.enabled = false;
  app.input.releasePointerLock();
  opts.onStart?.();
  const driver = createAppBenchDriver(app, opts);
  let report: BenchReport;
  try {
    report = await runBench(driver, {
      ...opts,
      views,
      ...(frames > 0 && opts.framesPerView === undefined ? { framesPerView: frames } : {}),
      onProgress: (p) => panel.progress(p),
    });
  } catch (e) {
    panel.dispose();
    app.input.enabled = inputWas;
    throw e;
  } finally {
    driver.release();
    app.place(home);
    opts.onFinish?.();
  }
  console.info('[bench]', JSON.stringify(report));
  // Keep game input off while the dialog is open, so Escape closes it without also opening the pause menu.
  panel.onClose = () => {
    app.input.enabled = inputWas;
    panel.dispose();
  };
  panel.show(report);
  return report;
}
