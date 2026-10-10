/**
 * WebGPU compatibility shims for three.js r186 on older Chromium builds.
 *
 * r186 always passes `swizzle: 'rgba'` (the current spec's string form) in GPUTextureViewDescriptor. Chromium <= 141
 * implemented an earlier dictionary form and throws a TypeError. 'rgba' is the identity swizzle, so dropping it is
 * semantically a no-op. We only install the shim when the browser actually rejects the string form.
 */
let installed = false;

export async function installWebGPUCompatShims(): Promise<string[]> {
  const applied: string[] = [];
  if (installed || typeof navigator === 'undefined' || !('gpu' in navigator)) return applied;
  installed = true;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return applied;
    const device = await adapter.requestDevice();
    const tex = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
    let rejects = false;
    try {
      const desc: Record<string, unknown> = { swizzle: 'rgba' };
      tex.createView(desc);
    } catch {
      rejects = true;
    }
    tex.destroy();
    device.destroy();
    if (rejects) {
      const proto = GPUTexture.prototype;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound via .call below
      const original = proto.createView;
      proto.createView = function (this: GPUTexture, desc?: GPUTextureViewDescriptor): GPUTextureView {
        if (desc && (desc as { swizzle?: unknown }).swizzle === 'rgba') {
          const { swizzle: _drop, ...rest } = desc as GPUTextureViewDescriptor & { swizzle?: unknown };
          return original.call(this, rest);
        }
        return original.call(this, desc);
      };
      applied.push('identity-swizzle');
    }
  } catch {
    // Probing failed; the boot probe frame will catch real failures and fall back to WebGL2.
  }
  return applied;
}
