/** Free-flight camera (M1 explorer and debug): speed scales with altitude so every scale is traversable. */
import * as THREE from 'three/webgpu';
import { Vec3d } from '../core/vec3d';
import type { App, Controller } from './app';

export class FreeCamera implements Controller {
  private readonly keys = new Set<string>();
  private dragging = false;
  speedScale = 1;

  constructor(app: App) {
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    app.canvas.addEventListener('pointerdown', () => (this.dragging = true));
    window.addEventListener('pointerup', () => (this.dragging = false));
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const q = app.cam.quat;
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -e.movementX * 0.0025));
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -e.movementY * 0.0025));
    });
    window.addEventListener('wheel', (e) => {
      this.speedScale = Math.min(100, Math.max(0.01, this.speedScale * (e.deltaY > 0 ? 0.8 : 1.25)));
    });
  }

  update(dt: number, app: App): void {
    const [near, alt] = app.sys.nearest(app.cam.pos, app.simTime);
    const surf = app.sys.surfaceHeightBelow(near, app.cam.pos, app.simTime);
    const agl = Math.max(2, alt - surf);
    const speed = agl * 0.8 * this.speedScale * (this.keys.has('ShiftLeft') ? 8 : 1);
    const k = (c: string): number => (this.keys.has(c) ? 1 : 0);
    const mv = new THREE.Vector3(k('KeyD') - k('KeyA'), k('KeyR') - k('KeyF'), k('KeyS') - k('KeyW')).applyQuaternion(app.cam.quat);
    app.cam.pos.offset.addScaled(new Vec3d(mv.x, mv.y, mv.z), speed * dt);
    app.cam.speed = mv.length() > 0 ? speed : 0;
    const roll = k('KeyQ') - k('KeyE');
    if (roll) app.cam.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll * dt));
    // Never go below the terrain.
    if (alt - surf < 1.5) {
      const up = app.sys.bodyRelative(near.def.id, app.cam.pos, app.simTime, new Vec3d()).scale(-1).normalize();
      app.cam.pos.offset.addScaled(up, 1.5 - (alt - surf));
    }
  }
}
