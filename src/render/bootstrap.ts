/**
 * Renderer creation with backend selection and a probe frame.
 *
 * three's built-in fallback (`getFallback`) only covers init failures. Some failures happen at the first render, so
 * after init we render one tiny frame into a render target and read a pixel back. Any error -> recreate on WebGL2.
 */
import * as THREE from 'three/webgpu';
import { installWebGPUCompatShims } from './compat';

export type BackendRequest = 'auto' | 'webgpu' | 'webgl2';
export type DepthMode = 'reversed' | 'partitioned' | 'naive';

export interface RendererInfo {
  backend: 'webgpu' | 'webgl2';
  reversedDepth: boolean;
  shims: string[];
  fallbackReason: string | null;
  adapter: string;
}

export interface CreatedRenderer {
  renderer: THREE.WebGPURenderer;
  info: RendererInfo;
}

async function probe(renderer: THREE.WebGPURenderer): Promise<void> {
  const rt = new THREE.RenderTarget(4, 4, { type: THREE.HalfFloatType });
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 10);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicNodeMaterial({ color: 0xff0000 }));
  mesh.position.z = -1;
  scene.add(mesh);
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);
  const px = (await renderer.readRenderTargetPixelsAsync(rt, 1, 1, 1, 1)) as ArrayLike<number>;
  rt.dispose();
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
  if (!px || px.length < 1) throw new Error('probe readback returned no data');
}

function describeAdapter(renderer: THREE.WebGPURenderer): string {
  const backend = renderer.backend as unknown as {
    isWebGPUBackend?: boolean;
    adapter?: { info?: { vendor?: string; architecture?: string; description?: string } };
    gl?: WebGL2RenderingContext;
  };
  if (backend.isWebGPUBackend) {
    const i = backend.adapter?.info;
    return [i?.vendor, i?.architecture, i?.description].filter(Boolean).join(' / ') || 'unknown WebGPU adapter';
  }
  const gl = backend.gl;
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  }
  return 'unknown';
}

async function attempt(
  canvas: HTMLCanvasElement,
  forceWebGL: boolean,
  wantReversed: boolean,
): Promise<THREE.WebGPURenderer> {
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL,
    reversedDepthBuffer: wantReversed,
    powerPreference: 'high-performance',
    alpha: false,
  });
  await renderer.init();
  await probe(renderer);
  return renderer;
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  request: BackendRequest,
  depthMode: DepthMode,
): Promise<CreatedRenderer> {
  const shims = request === 'webgl2' ? [] : await installWebGPUCompatShims();
  const wantReversed = depthMode === 'reversed';
  let renderer: THREE.WebGPURenderer | null = null;
  let fallbackReason: string | null = null;
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
  if (request !== 'webgl2' && hasWebGPU) {
    try {
      renderer = await attempt(canvas, false, wantReversed);
      const isGpu = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
      if (!isGpu) fallbackReason = 'three selected WebGL2 at init';
    } catch (err) {
      fallbackReason = err instanceof Error ? err.message : String(err);
      console.warn('[Known Sky] WebGPU path failed, falling back to WebGL2:', fallbackReason);
      void renderer?.dispose();
      renderer = null;
    }
  } else if (request !== 'webgl2') {
    fallbackReason = 'navigator.gpu unavailable';
  }
  if (!renderer) {
    // A fresh canvas is needed once a context of another type has been created on the old one.
    const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(fresh);
    renderer = await attempt(fresh, true, wantReversed);
  }
  const isGpu = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  return {
    renderer,
    info: {
      backend: isGpu ? 'webgpu' : 'webgl2',
      reversedDepth: renderer.reversedDepthBuffer,
      shims,
      fallbackReason,
      adapter: describeAdapter(renderer),
    },
  };
}
