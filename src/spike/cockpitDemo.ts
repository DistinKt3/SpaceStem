/**
 * Cockpit demo: the procedural cockpit rendered by FrameRenderer over a generated backdrop (a lit planet in the world
 * pass, a few hundred stars and the Sun in the background pass). Controls set the Sun direction, throttle, speed,
 * mode and alert. Exposes window.__ks for the e2e test and screenshot tooling.
 *
 * URL: ?backend=webgpu|webgl2 &depth=reversed|partitioned &quality=high|low &preset=ahead|side|night|alert &ui=0
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import '../game/styles.css';
import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, clamp, dot, exp, float, max, mix, mx_fractal_noise_float, normalWorld, normalize, positionWorld, pow, smoothstep, uniform, uv, vec3, length } from 'three/tsl';
import { createRenderer, effectiveDepthMode, type BackendRequest, type DepthMode } from '../render/bootstrap';
import { FrameRenderer } from '../render/frameRenderer';
import { Cockpit, type CockpitState, type FlightMode } from '../render/cockpit/cockpit';
import { Rng } from '../core/rng';
import { t, formatNumber } from '../game/i18n';

type N = any;

const params = new URLSearchParams(location.search);
/** Backdrop sky brightness: dimmed when a sunlit planet sets the exposure (as a real camera would). */
const skyGain = uniform(1);
const DEG = Math.PI / 180;
const dirAzEl = (az: number, el: number): THREE.Vector3 =>
  new THREE.Vector3(Math.cos(el * DEG) * Math.sin(az * DEG), Math.sin(el * DEG), -Math.cos(el * DEG) * Math.cos(az * DEG));

interface DemoSettings {
  sunAz: number;
  sunEl: number;
  sunIntensity: number;
  planetAz: number;
  planetEl: number;
  planetOn: boolean;
  throttle: number;
  speed: number;
  alert: number;
  mode: FlightMode;
  reducedMotion: boolean;
  lookYaw: number;
  lookPitch: number;
  /** Freeze animation time (for deterministic captures). */
  time: number | null;
  /** Show the cockpit (off shows the backdrop alone). */
  cockpitOn: boolean;
}

const PRESETS: Record<string, Partial<DemoSettings>> = {
  ahead: { sunAz: -25.3, sunEl: 13.5, sunIntensity: 1.6, planetAz: 22, planetEl: -38, planetOn: true, throttle: 0.62, speed: 0.48, alert: 0, mode: 'impulse' },
  side: { sunAz: 74, sunEl: 22, sunIntensity: 1.4, planetAz: -18, planetEl: -40, planetOn: true, throttle: 0.35, speed: 0.81, alert: 0, mode: 'cruise' },
  night: { sunAz: 180, sunEl: -35, sunIntensity: 1.2, planetAz: 0, planetEl: -120, planetOn: false, throttle: 0.18, speed: 0.12, alert: 0, mode: 'thrusters' },
  alert: { sunAz: -60, sunEl: 35, sunIntensity: 1.0, planetAz: 15, planetEl: -36, planetOn: true, throttle: 0.94, speed: 0.97, alert: 0.85, mode: 'hyperspeed' },
};

const settings: DemoSettings = {
  sunAz: -27,
  sunEl: 13,
  sunIntensity: 1.6,
  planetAz: 22,
  planetEl: -38,
  planetOn: true,
  throttle: 0.62,
  speed: 0.48,
  alert: 0,
  mode: 'impulse',
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  lookYaw: 0,
  lookPitch: 0,
  time: null,
  cockpitOn: true,
};

/** A few hundred stars as one mesh of small camera-facing quads in the background pass. */
function buildStars(count: number): THREE.Mesh {
  const rng = new Rng(0x5eed_57a2);
  const R = 2e6;
  const pos: number[] = [];
  const uvs: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const z = rng.range(-1, 1);
    const a = rng.range(0, Math.PI * 2);
    const d = new THREE.Vector3(Math.sqrt(1 - z * z) * Math.cos(a), z, Math.sqrt(1 - z * z) * Math.sin(a));
    const mag = Math.pow(rng.next(), 2.6);
    const size = R * (0.0024 + 0.0035 * mag);
    const b = 0.25 + 2.2 * mag * mag;
    const temp = rng.next();
    const c = temp < 0.2 ? [1.0, 0.82, 0.65] : temp < 0.75 ? [1, 0.97, 0.93] : [0.75, 0.85, 1.0];
    right.set(0, 1, 0).cross(d);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    up.crossVectors(d, right).normalize();
    const base = pos.length / 3;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const p = d.clone().multiplyScalar(R).addScaledVector(right, sx * size).addScaledVector(up, sy * size);
      pos.push(p.x, p.y, p.z);
      uvs.push((sx + 1) / 2, (sy + 1) / 2);
      col.push(c[0]! * b, c[1]! * b, c[2]! * b);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('starColor', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  m.forceSinglePass = true;
  const r: N = length(uv().sub(0.5)).mul(2);
  m.colorNode = attribute('starColor', 'vec3').mul(exp(r.mul(r).mul(-4.5))).mul(skyGain);
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  return mesh;
}

/** A faint generated Milky Way band on a background sphere (dust lanes from noise). Visual backdrop only. */
function buildMilkyWay(): THREE.Mesh {
  const g = new THREE.SphereGeometry(3e6, 64, 32);
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false });
  // Galactic plane tilted across the sky.
  const pole = normalize(vec3(0.62, 0.78, 0.12));
  const d: N = normalize(positionWorld);
  const lat = dot(d, pole);
  const core = exp(lat.mul(lat).mul(-1 / (2 * 0.075 * 0.075)));
  const wide = exp(lat.mul(lat).mul(-1 / (2 * 0.22 * 0.22)));
  const n1 = mx_fractal_noise_float(d.mul(6.0), 5, 2.1, 0.55).mul(0.5).add(0.5);
  const dust = smoothstep(0.35, 0.75, mx_fractal_noise_float(d.mul(11.0).add(vec3(2.0, 0, 0)), 4, 2.0, 0.5).mul(0.5).add(0.5));
  const glow = core.mul(n1).mul(float(1).sub(dust.mul(core).mul(0.85))).mul(0.032).add(wide.mul(0.0035));
  m.colorNode = vec3(0.86, 0.88, 1.0).mul(glow).mul(skyGain);
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

/** The Sun: a bright disc and halo in the background pass. */
function buildSun(): { mesh: THREE.Mesh; dir: N } {
  const dir = uniform(new THREE.Vector3(0, 0, -1));
  const g = new THREE.PlaneGeometry(1, 1);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
  const r: N = length(uv().sub(0.5)).mul(2);
  // Disc (~0.53 deg) plus a soft halo; HDR so the bloom pass blooms it.
  const disc = smoothstep(0.034, 0.026, r).mul(60);
  const halo = exp(r.mul(-9)).mul(1.4).add(exp(r.mul(-3.2)).mul(0.12)).mul(smoothstep(1.0, 0.6, r));
  m.colorNode = vec3(1.0, 0.95, 0.86).mul(disc.add(halo));
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.scale.setScalar(2e6 * 0.32);
  return { mesh, dir };
}

/** A generated ocean planet with clouds and an atmospheric rim, lit by the demo Sun. Visual backdrop only. */
function buildPlanet(radius: number, sunDir: N): THREE.Mesh {
  const g = new THREE.SphereGeometry(radius, 128, 96);
  const m = new THREE.MeshBasicNodeMaterial();
  const n: N = normalWorld;
  const V: N = normalize(positionWorld.sub(cameraPosition));
  const p: N = normalize(positionWorld.sub(uniformCenter));
  const land = smoothstep(0.16, 0.24, mx_fractal_noise_float(p.mul(2.2), 5, 2.0, 0.5));
  const cloudsRaw = mx_fractal_noise_float(p.mul(vec3(4.0, 9.0, 4.0)).add(vec3(3.1, 0, 1.7)), 6, 2.1, 0.55);
  const clouds = smoothstep(0.0, 0.45, cloudsRaw).mul(0.85);
  const ocean = vec3(0.01, 0.05, 0.14);
  const ground = mix(vec3(0.05, 0.08, 0.035), vec3(0.15, 0.12, 0.08), smoothstep(0.1, 0.4, mx_fractal_noise_float(p.mul(7.0), 3, 2, 0.5)));
  const surface = mix(ocean, ground, land);
  const albedo = mix(surface, vec3(0.85, 0.87, 0.9), clouds);
  const ndl = dot(n, sunDir);
  const lambert = clamp(ndl, 0, 1);
  const lit = albedo.mul(lambert.mul(1.25)).add(albedo.mul(0.004));
  // Atmosphere: a thin Rayleigh-blue limb on the day side, warming slightly toward the terminator.
  const rim = pow(float(1).sub(clamp(dot(n, V.negate()), 0, 1)), 6);
  const atmCol = mix(vec3(0.3, 0.55, 1.0), vec3(1.0, 0.55, 0.3), smoothstep(0.25, -0.05, ndl).mul(0.4));
  const atm = atmCol.mul(rim.mul(1.3)).mul(smoothstep(-0.12, 0.25, ndl));
  // Specular sun glint on the ocean.
  const H = normalize(sunDir.sub(V));
  const glint = pow(max(dot(n, H), 0), 140).mul(float(1).sub(land)).mul(float(1).sub(clouds)).mul(smoothstep(0.0, 0.2, ndl)).mul(3.0);
  m.colorNode = lit.add(atm).add(vec3(1.0, 0.92, 0.8).mul(glint));
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  return mesh;
}
const uniformCenter = uniform(new THREE.Vector3());

function buildUi(apply: () => void, setPreset: (name: string) => void): void {
  const ui = document.getElementById('cockpit-ui')!;
  if (params.get('ui') === '0') {
    ui.remove();
    return;
  }
  const head = document.createElement('div');
  head.className = 'head';
  const h1 = document.createElement('h1');
  h1.textContent = t('cockpit.demo.title');
  const toggle = document.createElement('button');
  toggle.textContent = t('cockpit.demo.hide');
  toggle.addEventListener('click', () => {
    ui.classList.toggle('collapsed');
    toggle.textContent = t(ui.classList.contains('collapsed') ? 'cockpit.demo.show' : 'cockpit.demo.hide');
  });
  head.append(h1, toggle);
  ui.append(head);
  const sec = (key: string): void => {
    const d = document.createElement('div');
    d.className = 'section';
    d.textContent = t(key);
    ui.append(d);
  };
  sec('cockpit.demo.presets');
  const presets = document.createElement('div');
  presets.className = 'presets';
  for (const name of Object.keys(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = t(`cockpit.demo.preset.${name}`);
    b.addEventListener('click', () => {
      setPreset(name);
      sync();
    });
    presets.append(b);
  }
  ui.append(presets);
  const syncers: (() => void)[] = [];
  const sync = (): void => syncers.forEach((f) => f());
  type NumKey = 'sunAz' | 'sunEl' | 'sunIntensity' | 'throttle' | 'speed' | 'alert' | 'lookYaw' | 'lookPitch';
  const slider = (key: NumKey, label: string, min: number, max: number, step: number, digits = 0): void => {
    const l = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = t(label);
    const out = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', t(label));
    const show = (): void => {
      input.value = String(settings[key]);
      out.textContent = formatNumber(settings[key], digits, digits);
    };
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      show();
      apply();
    });
    syncers.push(show);
    show();
    l.append(span, out, input);
    ui.append(l);
  };
  sec('cockpit.sun');
  slider('sunAz', 'cockpit.demo.sunAz', -180, 180, 1);
  slider('sunEl', 'cockpit.demo.sunEl', -90, 90, 1);
  slider('sunIntensity', 'cockpit.demo.sunIntensity', 0, 3, 0.05, 2);
  sec('cockpit.drive');
  slider('throttle', 'cockpit.demo.throttle', 0, 1, 0.01, 2);
  slider('speed', 'cockpit.demo.speed', 0, 1, 0.01, 2);
  slider('alert', 'cockpit.demo.alert', 0, 1, 0.01, 2);
  const ml = document.createElement('label');
  ml.className = 'wide';
  const mspan = document.createElement('span');
  mspan.textContent = t('cockpit.demo.mode');
  const sel = document.createElement('select');
  for (const m of ['thrusters', 'impulse', 'cruise', 'hyperspeed'] as const) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = t(`cockpit.mode.${m}`);
    sel.append(o);
  }
  sel.addEventListener('change', () => {
    settings.mode = sel.value as FlightMode;
    apply();
  });
  syncers.push(() => (sel.value = settings.mode));
  sel.value = settings.mode;
  ml.append(mspan, sel);
  ui.append(ml);
  const check = (key: 'reducedMotion' | 'planetOn', label: string): void => {
    const cl = document.createElement('label');
    cl.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = settings[key];
    cb.addEventListener('change', () => {
      settings[key] = cb.checked;
      apply();
    });
    syncers.push(() => (cb.checked = settings[key]));
    const cs = document.createElement('span');
    cs.textContent = t(label);
    cl.append(cb, cs);
    ui.append(cl);
  };
  check('reducedMotion', 'cockpit.demo.reducedMotion');
  check('planetOn', 'cockpit.demo.planet');
  sec('cockpit.demo.view');
  slider('lookYaw', 'cockpit.demo.lookYaw', -150, 150, 1);
  slider('lookPitch', 'cockpit.demo.lookPitch', -70, 70, 1);
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = t('cockpit.demo.note');
  ui.append(note);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const backend = (params.get('backend') ?? 'auto') as BackendRequest;
  const requested = (params.get('depth') ?? 'reversed') as DepthMode;
  const { renderer, info } = await createRenderer(canvas, backend, requested);
  const depthMode = effectiveDepthMode(requested, info);
  const fr = new FrameRenderer(renderer, { depthMode, msaaSamples: params.get('msaa') === '0' ? 0 : 4 });
  fr.bloomStrength.value = Number(params.get('bloom') ?? 0.5);

  // Backdrop.
  const stars = buildStars(Number(params.get('stars') ?? 1400));
  fr.backgroundScene.add(buildMilkyWay(), stars);
  const sun = buildSun();
  fr.backgroundScene.add(sun.mesh);
  const planetRadius = 6.4e6;
  const planetDist = 1.02e7;
  const planet = buildPlanet(planetRadius, sun.dir);
  fr.add({ object: planet, radius: planetRadius });

  // Cockpit.
  const quality = params.get('quality') === 'low' ? 'low' : 'high';
  const cockpit = new Cockpit({ quality });
  fr.cockpitScene.add(cockpit.group);

  const preset = params.get('preset');
  if (preset && PRESETS[preset]) Object.assign(settings, PRESETS[preset]);
  if (params.get('reduced') === '1') settings.reducedMotion = true;

  const resize = (): void => fr.resize(innerWidth, innerHeight);
  window.addEventListener('resize', resize);
  resize();

  const state: CockpitState = {
    time: 0,
    throttle: 0,
    speedFraction: 0,
    mode: 'impulse',
    sunDirLocal: new THREE.Vector3(0, 0, -1),
    sunIntensity: 1,
    planetGlow: null,
    alert: 0,
    reducedMotion: false,
  };
  const planetGlowColor = new THREE.Color(0.32, 0.5, 0.85);
  const look = new THREE.Quaternion();
  const apply = (): void => {
    const sd = dirAzEl(settings.sunAz, settings.sunEl);
    state.sunDirLocal.copy(sd);
    state.sunIntensity = settings.sunIntensity;
    state.throttle = settings.throttle;
    state.speedFraction = settings.speed;
    state.mode = settings.mode;
    state.alert = settings.alert;
    state.reducedMotion = settings.reducedMotion;
    sun.dir.value.copy(sd);
    sun.mesh.position.copy(sd).multiplyScalar(2e6);
    sun.mesh.lookAt(0, 0, 0);
    sun.mesh.visible = settings.sunIntensity > 0;
    const pd = dirAzEl(settings.planetAz, settings.planetEl);
    planet.position.copy(pd).multiplyScalar(planetDist);
    uniformCenter.value.copy(planet.position);
    planet.visible = settings.planetOn;
    skyGain.value = settings.planetOn && settings.sunIntensity > 0 ? 0.45 : 1;
    // Planet fill: sunlit fraction of the visible disc (phase) times the disc's solid angle, Earth-like colour.
    if (settings.planetOn) {
      const phase = (1 + sd.dot(pd.clone().negate())) / 2;
      const solid = 1 - Math.sqrt(1 - (planetRadius / planetDist) ** 2);
      state.planetGlow = { dirLocal: pd, color: planetGlowColor, intensity: settings.sunIntensity * phase * solid * 0.9 };
    } else {
      state.planetGlow = null;
    }
    cockpit.setVisible(settings.cockpitOn);
    look.setFromEuler(new THREE.Euler(settings.lookPitch * DEG, -settings.lookYaw * DEG, 0, 'YXZ'));
    fr.camera.quaternion.copy(look);
    fr.cockpitCamera.quaternion.copy(look);
  };
  const setPreset = (name: string): void => {
    const p = PRESETS[name];
    if (p) Object.assign(settings, p);
    apply();
  };
  apply();
  buildUi(apply, setPreset);

  const statsEl = document.getElementById('cockpit-stats')!;
  let last = performance.now();
  let frameMs = 16;
  let base = { drawCalls: 0, triangles: 0 };
  const t0 = performance.now();

  const render = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    frameMs = frameMs * 0.9 + (now - last) * 0.1;
    last = now;
    state.time = settings.time ?? (now - t0) / 1000;
    cockpit.update(dt, state);
    fr.camera.position.set(0, 0, 0);
    fr.render();
  };

  // Measure the backdrop alone once, so the cockpit's own draw calls can be reported separately.
  fr.cockpitEnabled = false;
  render();
  base = { drawCalls: fr.stats.drawCalls, triangles: fr.stats.triangles };
  fr.cockpitEnabled = true;
  render();

  /** Exact cockpit cost: render the same frame without and with the cockpit pass and subtract. */
  const stats = (): Record<string, unknown> => {
    fr.cockpitEnabled = false;
    render();
    base = { drawCalls: fr.stats.drawCalls, triangles: fr.stats.triangles };
    fr.cockpitEnabled = true;
    render();
    return {
      backend: info.backend,
      depthMode,
      quality,
      drawCalls: fr.stats.drawCalls,
      triangles: fr.stats.triangles,
      baseDrawCalls: base.drawCalls,
      baseTriangles: base.triangles,
      cockpitDrawCalls: fr.stats.drawCalls - base.drawCalls,
      cockpitTriangles: fr.stats.triangles - base.triangles,
      cockpitStatic: cockpit.stats(),
      frameMs,
    };
  };

  let statsTimer = 0;
  const loop = (): void => {
    render();
    if (--statsTimer <= 0) {
      statsTimer = 15;
      statsEl.textContent = t('cockpit.demo.stats', {
        backend: info.backend,
        draws: fr.stats.drawCalls - base.drawCalls,
        tris: fr.stats.triangles - base.triangles,
        ms: Math.round(frameMs),
      });
    }
    requestAnimationFrame(loop);
  };
  if (params.get('loop') !== '0') requestAnimationFrame(loop);

  (window as unknown as { __ks: unknown }).__ks = {
    info,
    depthMode,
    settings,
    presets: Object.keys(PRESETS),
    set: (patch: Partial<DemoSettings>) => {
      Object.assign(settings, patch);
      apply();
    },
    preset: (name: string) => setPreset(name),
    stats,
    renderOnce: () => render(),
    /** Render and read back in the same task (canvas contents are only valid right after a render). */
    capture: (type = 'image/png', quality = 0.92) => {
      render();
      return renderer.domElement.toDataURL(type, quality);
    },
  };
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const el = document.getElementById('cockpit-stats');
  if (el) el.textContent = t('cockpit.demo.failed', { reason: msg });
  console.error(err);
});
