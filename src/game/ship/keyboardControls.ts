/**
 * Temporary keyboard/mouse adapter producing ShipControls (replaced by the remappable InputManager).
 * W/S throttle, A/D yaw, arrows pitch/yaw, Q/E roll, R/F strafe up/down, Z/C strafe left/right, X zero throttle,
 * Shift boost, Space/B mode next/prev, G flight assist; mouse drag looks (pitch/yaw).
 */
import { NO_CONTROLS, type ShipControls } from './ship';

export class KeyboardControls {
  private readonly keys = new Set<string>();
  private readonly edges = new Set<string>();
  private mx = 0;
  private my = 0;
  private dragging = false;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.edges.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('pointerdown', () => (this.dragging = true));
    window.addEventListener('pointerup', () => (this.dragging = false));
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.mx += e.movementX;
      this.my += e.movementY;
    });
  }

  held(code: string): boolean {
    return this.keys.has(code);
  }

  pressed(code: string): boolean {
    return this.edges.has(code);
  }

  read(): ShipControls {
    const k = (c: string): number => (this.keys.has(c) ? 1 : 0);
    const c: ShipControls = {
      ...NO_CONTROLS,
      pitch: k('ArrowUp') - k('ArrowDown') - this.my * 0.02,
      yaw: k('KeyA') + k('ArrowLeft') - k('KeyD') - k('ArrowRight') - this.mx * 0.02,
      roll: k('KeyQ') - k('KeyE'),
      throttleRate: k('KeyW') - k('KeyS'),
      strafeX: k('KeyC') - k('KeyZ'),
      strafeY: k('KeyR') - k('KeyF'),
      boost: this.keys.has('ShiftLeft'),
      zeroThrottle: this.edges.has('KeyX'),
      modeNext: this.edges.has('Space'),
      modePrev: this.edges.has('KeyB'),
      toggleFlightAssist: this.edges.has('KeyG'),
    };
    c.pitch = Math.max(-1, Math.min(1, c.pitch));
    c.yaw = Math.max(-1, Math.min(1, c.yaw));
    this.mx = 0;
    this.my = 0;
    return c;
  }

  endFrame(): void {
    this.edges.clear();
  }
}
