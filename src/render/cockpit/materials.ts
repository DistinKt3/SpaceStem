/**
 * Cockpit materials, all TSL node materials (compile to WGSL and GLSL):
 *  - interior surfaces lit by the Sun through the canopy, with analytic soft shadows of the canopy frame and hull
 *    (the canopy model in layout.ts, evaluated here on nodes, so shadows line up with the struts; no shadow maps),
 *  - the canopy glass: Fresnel reflection of the lit instrument cluster, smudges and micro-scratches that glint in
 *    concentric arcs around the Sun, and a subtle tint toward the frame,
 *  - holographic and physical display panels driven by CockpitState through uniforms.
 *
 * Units: ship-local metres; the cockpit group sits at the scene origin (positionWorld == ship-local position).
 * Every smoothstep here has e0 < e1 (GLSL ES leaves reversed edges undefined); falling edges use `fall()`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import * as THREE from 'three/webgpu';
import {
  Discard,
  Fn,
  If,
  abs,
  acos,
  atan,
  attribute,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  length,
  lights,
  max,
  min,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  reflect,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { CANOPY, DEG, FRAME, LIP_DISTANCE, LIP_Y, azElG, canopyTransmissionG, frameDistanceG, type ScalarOps } from './layout';
import { ATLAS_H, ATLAS_W, DIGITS, LAYOUT, MODE_STRIP, PLATES, REGIONS, STATUS_STRIP, type Box, type Rect } from './displayAtlas';
import type { PanelKind } from './geometry';
import { AMBER_EMISSION } from './state';

type N = any;
/** Use a typed uniform (colour, vector) inside a node graph. */
const col = (x: unknown): N => x;

/** Falling edge: 1 below `lo`, 0 above `hi` (lo < hi). */
const fall = (hi: N, lo: N, x: N): N => float(1).sub(smoothstep(lo, hi, x));

/** The canopy model's scalar operations on TSL nodes (see layout.ScalarOps): shader and CPU share one formula. */
const nodeOps: ScalarOps<N> = {
  k: (v) => float(v),
  add: (a, b) => a.add(b),
  sub: (a, b) => a.sub(b),
  mul: (a, b) => a.mul(b),
  div: (a, b) => a.div(b),
  abs: (a) => abs(a),
  min: (a, b) => min(a, b),
  max: (a, b) => max(a, b),
  sqrt: (a) => sqrt(a),
  pow: (a, e) => pow(a, e),
  cos: (a) => cos(a),
  atan2: (y, x) => atan(y, x),
  smoothstep: (e0, e1, x) => smoothstep(e0, e1, x),
  step: (edge, x) => step(edge, x),
};
const xyz = (v: N): [N, N, N] => [v.x, v.y, v.z];

/** Every per-frame input of the cockpit shaders. Values are written by Cockpit.update(). */
export class CockpitUniforms {
  readonly time = uniform(0);
  readonly throttle = uniform(0);
  readonly speed = uniform(0);
  readonly mode = uniform(0);
  readonly alert = uniform(0);
  /** 1 when reduced motion is requested: no scrolling scanlines, flicker or spinning rings. */
  readonly still = uniform(0);
  readonly sunDir = uniform(new THREE.Vector3(0, 0, -1));
  /** Sun intensity times exposure compensation (display-referred, 0..~3). */
  readonly sunI = uniform(0);
  /** Linear sunlight colour times intensity times pi times exposure compensation (light colour). */
  readonly sunColor = uniform(new THREE.Color(0, 0, 0));
  readonly planetDir = uniform(new THREE.Vector3(0, -1, 0));
  readonly planetColor = uniform(new THREE.Color(0, 0, 0));
  /** Emission of a fully lit display line: the accent blended toward amber/red by the alert (linear HDR). */
  readonly accent = uniform(new THREE.Color(0.0, 0.49, 1.29));
  /** Panel emission gain (includes exposure compensation). */
  readonly panelGain = uniform(1);
  /** Attitude display: sun marker (region px, visibility), planet marker (region px, visibility). */
  readonly sunMarker = uniform(new THREE.Vector3(0, 0, 0));
  readonly planetMarker = uniform(new THREE.Vector3(0, 0, 0));
  /** Exposure compensation for the interior ambient (1 by default). */
  readonly gain = uniform(1);
  /** Percent readouts in this locale: unit before the number (1) or after (0), and the gap in cells. */
  readonly pctBefore = uniform(0);
  readonly pctGap = uniform(0);
}

/**
 * Fraction of a distant light (unit direction l, toward the light) reaching interior point p through the canopy.
 * The same formula as layout.canopyTransmission (shared generic code).
 */
export function canopyTransmissionNode(p: N, l: N, penRad: number, struts = true): N {
  return canopyTransmissionG(nodeOps, xyz(p), xyz(l), penRad, struts);
}

export interface CockpitLights {
  /** Lights for interior surfaces (Sun and planet filtered by the canopy). */
  interior: THREE.LightsNode;
  /** Lights for the canopy frame itself (hull mask only: a strut cannot shadow itself). */
  frame: THREE.LightsNode;
  /** Lights for glossy screens: no point lights (they would show as specular hot spots). */
  screens: THREE.LightsNode;
  objects: THREE.Object3D[];
  sunShadowed: THREE.DirectionalLight;
  sunPlain: THREE.DirectionalLight;
  planetShadowed: THREE.DirectionalLight;
  planetPlain: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  glows: THREE.PointLight[];
}

export function createLights(u: CockpitUniforms, glowAnchors: THREE.Vector3[]): CockpitLights {
  const mk = (): THREE.DirectionalLight => {
    const l = new THREE.DirectionalLight(0xffffff, 0);
    l.target.position.set(0, 0, 0);
    return l;
  };
  const sunShadowed = mk();
  const sunPlain = mk();
  const planetShadowed = mk();
  const planetPlain = mk();
  // three r186: a light's optional `colorNode` replaces its colour uniform; we use it to filter by the canopy.
  (sunShadowed as unknown as { colorNode: N }).colorNode = col(u.sunColor).mul(canopyTransmissionNode(positionWorld, u.sunDir, 0.0047));
  (sunPlain as unknown as { colorNode: N }).colorNode = col(u.sunColor).mul(canopyTransmissionNode(positionWorld, u.sunDir, 0.0047, false));
  (planetShadowed as unknown as { colorNode: N }).colorNode = col(u.planetColor).mul(canopyTransmissionNode(positionWorld, u.planetDir, 0.06));
  (planetPlain as unknown as { colorNode: N }).colorNode = col(u.planetColor);
  const hemi = new THREE.HemisphereLight(0x8fa6c4, 0x1a1f26, 0.1);
  const glows = glowAnchors.map((a) => {
    const l = new THREE.PointLight(0x7fd4ff, 0, 0.9, 2);
    l.position.copy(a);
    return l;
  });
  const objects: THREE.Object3D[] = [sunShadowed, sunShadowed.target, sunPlain, sunPlain.target, planetShadowed, planetShadowed.target, planetPlain, planetPlain.target, hemi, ...glows];
  return {
    interior: lights([sunShadowed, planetShadowed, hemi, ...glows]),
    frame: lights([sunPlain, planetPlain, hemi, ...glows]),
    screens: lights([sunShadowed, planetShadowed, hemi]),
    objects,
    sunShadowed,
    sunPlain,
    planetShadowed,
    planetPlain,
    hemi,
    glows,
  };
}

/**
 * Cheap environment reflection for glossy surfaces: the planet (a broad bright lobe), the instrument glow below and a
 * dark cabin. Returned as radiance to add to emission, weighted by Fresnel.
 */
function envReflection(u: CockpitUniforms, f0: number, rough: number, tintNode: N, glowAnchor: THREE.Vector3): N {
  const P = positionWorld;
  const V = normalize(P.sub(cameraPosition));
  const Nn = normalWorld;
  const R = reflect(V, Nn);
  const ndv = clamp(dot(Nn, V.negate()), 0, 1);
  const fres = float(f0).add(float(1 - f0).mul(pow(float(1).sub(ndv), 5)));
  const sharp = 1 - rough;
  const planetLobe = smoothstep(0.55 - 0.3 * sharp, 1.0, dot(R, u.planetDir)).mul(0.25);
  const toGlowV = vec3(glowAnchor.x, glowAnchor.y, glowAnchor.z).sub(P);
  const gd = length(toGlowV);
  const toGlow = toGlowV.div(gd);
  // Reflection of the instrument cluster: a lobe toward it that fades with distance (it is a finite source).
  const glowLobe = pow(max(dot(R, toGlow), 0), 4 + 20 * sharp)
    .mul(0.05)
    .div(gd.mul(gd).div(0.09).add(1));
  const cabin = vec3(0.012, 0.015, 0.02).mul(u.gain);
  const env = col(u.planetColor).mul(planetLobe).mul(1 / Math.PI).add(col(u.accent).mul(u.panelGain).mul(glowLobe)).add(cabin);
  return env.mul(fres).mul(tintNode);
}

export interface SurfaceSpec {
  color: [number, number, number];
  roughness: number;
  metalness: number;
  /** Fresnel F0 for the fake environment reflection. */
  f0: number;
  /** Panel seams: draw thin grooves from the uv grid (shell loft only). */
  seams?: boolean;
}

export function surfaceMaterial(spec: SurfaceSpec, u: CockpitUniforms, lightsNode: THREE.LightsNode, glowAnchor: THREE.Vector3): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  const base = vec3(...spec.color);
  let color: N = base;
  if (spec.seams) {
    // Panel breaks on the dashboard face: two vertical seams either side of centre and one horizontal seam under the
    // screens (uv.y is the loft profile parameter; the floor carries uv.y = 0.9, outside the face).
    const v = uv().y;
    const ax = abs(positionWorld.x);
    const aaX = fwidth(ax).mul(1.2).add(1e-4);
    const aaV = fwidth(v).mul(1.2).add(1e-4);
    const lineX = (x: number): N => float(1).sub(smoothstep(0, aaX, abs(ax.sub(x))));
    const face = step(v, 0.47);
    const vertical = max(lineX(0.112), lineX(0.296)).mul(face);
    const horizontal = float(1).sub(smoothstep(0, aaV, abs(v.sub(0.262)))).mul(step(ax, 0.47));
    const seam = max(vertical, horizontal);
    // Cheap cavity darkening: the face falls off into the footwell below the displays.
    const cavity = mix(float(0.35), float(1), smoothstep(0.08, 0.26, v));
    color = base.mul(float(1).sub(seam.mul(0.75))).mul(cavity);
  }
  m.colorNode = color;
  m.roughnessNode = float(spec.roughness);
  m.metalnessNode = float(spec.metalness);
  m.emissiveNode = envReflection(u, spec.f0, spec.roughness, mix(vec3(1, 1, 1), base.mul(4), spec.metalness), glowAnchor);
  m.lightsNode = lightsNode;
  return m;
}

/**
 * Hull interior skin: the part of the canopy ellipsoid that is not glass. Panelled on an azimuth / elevation grid
 * with recessed, slightly lighter panels, and a row of small status lights along the rear bulkhead.
 */
export function skinMaterial(u: CockpitUniforms, lightsNode: THREE.LightsNode, glowAnchor: THREE.Vector3): THREE.MeshStandardNodeMaterial {
  const base: [number, number, number] = [0.045, 0.049, 0.056];
  const m = surfaceMaterial({ color: base, roughness: 0.65, metalness: 0, f0: 0.03 }, u, lightsNode, glowAnchor);
  m.side = THREE.BackSide;
  const P = positionWorld;
  const { az, el } = azElG(nodeOps, xyz(P));
  /** Distance (in units of x) to the nearest multiple of `pitch`. */
  const gridDist = (x: N, pitch: number): N => abs(fract(x.div(pitch)).sub(0.5)).mul(pitch).negate().add(pitch / 2);
  const line = (x: N, pitch: number, width: number): N => fall(fwidth(x).mul(1.5).add(width), 0, gridDist(x, pitch));
  m.colorNode = Fn(() => {
    If(el.greaterThan(CANOPY.sillEl + 0.3).and(P.z.lessThan(CANOPY.bowZ - FRAME.bowWidth * 0.3)), () => {
      Discard();
    });
    // Panel seams, and a lighter inset in the middle of each panel.
    const seam = max(line(az.add(180), 22.5, 0.05), line(el.add(90), 15, 0.05));
    const inset = smoothstep(1.2, 2.2, min(gridDist(az.add(180), 22.5), gridDist(el.add(90), 15)));
    return vec3(...base)
      .mul(float(1).add(inset.mul(0.35)))
      .mul(float(1).sub(seam.mul(0.6)));
  })();
  // Status lights: small dots along the rear bulkhead (two rows), every 7.5 degrees, some dim, some lit.
  const rear = smoothstep(100, 110, abs(az));
  const cell = floor(az.add(180).div(7.5));
  const lit = fract(sin(cell.mul(12.9898)).mul(43758.5453));
  const du = gridDist(az.add(180).add(3.75), 7.5).mul(cos(el.mul(DEG)));
  const row = min(abs(el.sub(6)), abs(el.sub(3.6)));
  const dot2 = du.mul(du).add(row.mul(row));
  const led = fall(0.42, 0.22, sqrt(dot2)).mul(rear).mul(step(0.35, lit));
  const ledCol = mix(col(u.accent), vec3(...AMBER_EMISSION), step(0.88, lit));
  m.emissiveNode = ledCol.mul(u.panelGain).mul(led.mul(0.55)).add(col(m.emissiveNode));
  return m;
}

/** Accent light strips and lit details: pure emission, tinted per vertex, following the panel accent. */
export function glowMaterial(u: CockpitUniforms): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const tint = attribute('tint', 'vec4');
  // tint.rgb > 1 marks white-hot emitters; the accent colour is mixed in by tint.a.
  m.colorNode = mix(vec3(1, 1, 1), col(u.accent), tint.a).mul(tint.rgb).mul(u.panelGain);
  return m;
}

/** Backlit keys: dark caps with a glowing top. */
export function keyMaterial(u: CockpitUniforms, lightsNode: THREE.LightsNode, glowAnchor: THREE.Vector3): THREE.MeshStandardNodeMaterial {
  const m = surfaceMaterial({ color: [0.02, 0.022, 0.026], roughness: 0.4, metalness: 0, f0: 0.04 }, u, lightsNode, glowAnchor);
  const tint = attribute('tint', 'vec4');
  const n = normalWorld;
  // Only the top face glows (the face whose normal points most upward toward the pilot).
  const top = smoothstep(0.6, 0.9, n.y);
  m.emissiveNode = tint.rgb.mul(top).mul(u.panelGain).mul(0.35);
  return m;
}

/** Henyey-Greenstein phase function. */
function hg(cosA: N, g: number): N {
  const g2 = g * g;
  return float((1 - g2) / (4 * Math.PI)).div(pow(float(1 + g2).sub(cosA.mul(2 * g)), 1.5));
}

/** A display seen in reflection: plan-view centre (x, z), half extents (metres) and relative brightness. */
export interface GlowSource {
  x: number;
  z: number;
  halfW: number;
  halfD: number;
  weight: number;
}

/** Canopy glass. Premultiplied output: rgb is added light, alpha is how much of the world behind is attenuated. */
export function glassMaterial(u: CockpitUniforms, wear: THREE.Texture, sources: GlowSource[]): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    premultipliedAlpha: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.BackSide,
  });
  m.outputNode = Fn(() => {
    const P = positionWorld;
    const { el } = azElG(nodeOps, xyz(P));
    // Only where the canopy is glass.
    If(el.lessThan(CANOPY.sillEl - 0.5).or(P.z.greaterThan(CANOPY.bowZ)), () => {
      Discard();
    });
    const V = normalize(P.sub(cameraPosition)).toVar();
    const nOut = normalize(P.sub(vec3(...CANOPY.center)).div(vec3(...CANOPY.semi).mul(vec3(...CANOPY.semi)))).toVar();
    const cosI = abs(dot(V, nOut));
    const fres = float(0.035).add(float(0.965).mul(pow(float(1).sub(cosI), 5))).toVar();

    // --- Wear texture: stereographic projection from straight behind (conformal, so scratch angles survive).
    const proj = V.xy.div(float(1).sub(V.z));
    const tex = texture(wear, proj.mul(1.6)).toVar();
    const smudge = tex.a;

    // --- Interior reflection: the instrument cluster seen in the glass (a glow plane just below the lip).
    const Rv = reflect(V, nOut.negate());
    const yPlane = LIP_Y - 0.02;
    const tP = float(yPlane).sub(P.y).div(min(Rv.y, -1e-3));
    const H = P.add(Rv.mul(max(tP, 0)));
    const hx = H.x;
    const hz = H.z;
    const box = (cx: number, cz: number, hw: number, hd: number, soft: number): N => {
      const dx = max(abs(hx.sub(cx)).sub(hw), 0);
      const dz = max(abs(hz.sub(cz)).sub(hd), 0);
      return exp(dx.mul(dx).add(dz.mul(dz)).div(-soft * soft));
    };
    let screens: N = float(0);
    for (const g of sources) screens = screens.add(box(g.x, g.z, g.halfW, g.halfD, 0.022).mul(g.weight));
    const lipD = abs(length(vec2(hx, hz)).sub(LIP_DISTANCE - 0.01));
    const lip = exp(lipD.mul(lipD).div(-0.004 * 0.004)).mul(step(abs(hx), 0.47)).mul(0.2);
    const valid = step(Rv.y, -0.02).mul(step(0, tP));
    const panelLight = col(u.accent).mul(u.panelGain).mul(screens.mul(0.4).add(lip)).mul(valid);
    // The cabin itself, faintly lit by the displays, mirrored at grazing angles near the frame.
    const cabin = vec3(0.006, 0.007, 0.009).mul(u.gain).add(col(u.accent).mul(u.panelGain).mul(0.02));
    const refl = panelLight.add(cabin).mul(fres).mul(float(1).add(smudge.mul(0.6)));

    // --- Sun glare: scratches perpendicular to the direction toward the Sun light up; forward-scattering haze.
    const sd = u.sunDir;
    const sunProj = sd.xy.div(max(float(1).sub(sd.z), 0.05));
    const radial = proj.sub(sunProj);
    const rl = length(radial).add(1e-5);
    const tang = vec2(radial.y.negate(), radial.x).div(rl);
    const tDA = vec2(tang.x.mul(tang.x).sub(tang.y.mul(tang.y)), tang.x.mul(tang.y).mul(2));
    const sDA = tex.gb.mul(2).sub(1);
    const align = dot(sDA, tDA).div(max(length(sDA), 0.05));
    const glint = tex.r.mul(pow(clamp(align, 0, 1), 40));
    const cosA = clamp(dot(V, sd), -1, 1);
    const ang = acos(cosA);
    const fallOff = exp(ang.div(-0.075)).mul(1.4).add(exp(ang.div(-0.26)).mul(0.035));
    const sunOnGlass = smoothstep(0.0, 0.12, dot(sd, nOut));
    // Veiling glare: a smooth forward-scattering core from the glass itself, structured by the smudges.
    const veil = hg(cosA, 0.93).mul(0.006).add(hg(cosA, 0.7).mul(0.004));
    const haze = smudge.mul(hg(cosA, 0.85)).mul(0.022);
    const sunTint = vec3(1.0, 0.9, 0.76);
    const glare = sunTint.mul(u.sunI).mul(sunOnGlass).mul(glint.mul(fallOff).mul(1.7).add(haze).add(veil));

    // --- Planet light scattering in the smudges (subtle).
    const cosP = clamp(dot(V, u.planetDir), -1, 1);
    const planetScatter = col(u.planetColor).mul(smudge.mul(0.5).add(0.05)).mul(hg(cosP, 0.6)).mul(0.025 / Math.PI);

    // --- Edge tint near the frame: a thin darker, slightly cyan band where the glass meets the struts.
    const dEdge = frameDistanceG(nodeOps, xyz(P));
    const edge = fall(0.055, 0.0, dEdge);
    const tintCol = vec3(0.003, 0.009, 0.011).mul(u.gain);

    const rgb = refl.add(glare).add(planetScatter).add(tintCol.mul(edge));
    const alpha = clamp(float(0.035).add(fres.mul(0.6)).add(edge.mul(0.2)).add(smudge.mul(0.03)), 0, 1);
    return vec4(rgb, alpha);
  })();
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Display panels.

/** Sample the atlas at region-pixel coordinates q (origin top-left) of rect r. */
function atlasAt(atlas: THREE.Texture, r: Rect, q: N): N {
  const uvA = vec2(q.x.add(r.x).div(ATLAS_W), q.y.add(r.y).div(ATLAS_H));
  return texture(atlas, uvA);
}

/** Anti-aliased box mask in region pixels. */
function boxMask(q: N, b: Box): N {
  const mx = smoothstep(b[0] - 0.5, b[0] + 0.5, q.x).mul(fall(b[2] + 0.5, b[2] - 0.5, q.x));
  const my = smoothstep(b[1] - 0.5, b[1] + 0.5, q.y).mul(fall(b[3] + 0.5, b[3] - 0.5, q.y));
  return mx.mul(my);
}

/** Soft rounded-rectangle coverage in region pixels (corner radius rad, edge softness soft). */
function roundBox(q: N, b: Box, rad: number, soft: number): N {
  const c = vec2((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
  const hs = vec2((b[2] - b[0]) / 2 - rad, (b[3] - b[1]) / 2 - rad);
  const d = abs(q.sub(c)).sub(hs);
  const sd = length(max(d, 0)).add(min(max(d.x, d.y), 0)).sub(rad);
  return fall(soft, -soft, sd);
}

/**
 * Percent readout: value (integer 0..999) in up to 3 digit cells plus the unit glyph, laid out for the locale
 * (u.pctBefore, u.pctGap): '62%' right-aligns the digits against the unit; '%62' puts the unit just before the first
 * digit. Uses explicit gradients so the cell seams do not pick a tiny mip level.
 */
function digitsNode(atlas: THREE.Texture, q: N, box: Box, value: N, u: CockpitUniforms): N {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  const lx = q.x.sub(box[0]).div(w);
  const ly = q.y.sub(box[1]).div(h);
  const inside = step(0, lx).mul(step(lx, 1)).mul(step(0, ly)).mul(step(ly, 1));
  const gap = col(u.pctGap);
  const cells = gap.add(4);
  const cf = lx.mul(cells);
  const v = floor(value.add(0.5));
  const nd = float(1).add(step(10, v)).add(step(100, v));
  const firstDigit = float(3).sub(nd);
  const d2 = floor(v.div(100));
  const d1 = floor(v.div(10)).sub(floor(v.div(100)).mul(10));
  const d0 = v.sub(floor(v.div(10)).mul(10));
  const digitAt = (j: N): N => select(j.equal(0), d2, select(j.equal(1), d1, d0));
  // Unit after the number: digits in cells [0, 3), the unit at [3 + gap, 4 + gap).
  const sj = floor(cf);
  const sIsDigit = step(cf, 2.9999);
  const sGlyph = select(sIsDigit.greaterThan(0.5), digitAt(sj), float(10));
  const sFx = select(sIsDigit.greaterThan(0.5), fract(cf), cf.sub(gap).sub(3));
  const sShow = select(sIsDigit.greaterThan(0.5), step(firstDigit, sj), step(gap.add(3), cf));
  // Unit before the number: digits in cells [1 + gap, 4 + gap); the unit sits at [firstDigit, firstDigit + 1), just
  // before the first shown digit (over the cells of the hidden leading digits).
  const pc = cf.sub(gap).sub(1);
  const pj = floor(pc);
  const pDigit = step(0, pc).mul(step(firstDigit, pj));
  const pUnit = step(firstDigit, cf).mul(step(cf, firstDigit.add(0.9999))).mul(float(1).sub(pDigit));
  const pGlyph = select(pDigit.greaterThan(0.5), digitAt(pj), float(10));
  const pFx = select(pDigit.greaterThan(0.5), fract(pc), cf.sub(firstDigit));
  const pShow = max(pDigit, pUnit);
  const before = u.pctBefore.greaterThan(0.5);
  const glyph = select(before, pGlyph, sGlyph);
  const fx = clamp(select(before, pFx, sFx), 0, 1);
  const show = select(before, pShow, sShow);
  const gx = float(DIGITS.x).add(glyph.add(fx).mul(DIGITS.glyphW)).div(ATLAS_W);
  const gy = float(DIGITS.y).add(ly.mul(DIGITS.h)).div(ATLAS_H);
  const cont = vec2(lx.mul(cells).mul(DIGITS.glyphW / ATLAS_W), gy);
  const s = texture(atlas, vec2(gx, gy)).grad(cont.dFdx(), cont.dFdy());
  // The glow of neighbouring glyphs bleeds into a cell; fade it out toward the cell edges so cells never show as boxes.
  const win: N = smoothstep(0, 0.14, fx).mul(fall(1, 0.86, fx)).mul(smoothstep(0, 0.12, ly)).mul(fall(1, 0.88, ly));
  return vec2(col(s.r), col(s.g).mul(win)).mul(inside).mul(show);
}

/** A row of a label strip (mode names / status words) placed into a box. */
function stripNode(atlas: THREE.Texture, q: N, box: Box, strip: { x: number; y: number; w: number; rowH: number }, row: N): N {
  const lx = q.x.sub(box[0]).div(box[2] - box[0]);
  const ly = q.y.sub(box[1]).div(box[3] - box[1]);
  const inside = step(0, lx).mul(step(lx, 1)).mul(step(0, ly)).mul(step(ly, 1));
  const sx = float(strip.x).add(lx.mul(strip.w)).div(ATLAS_W);
  const sy = float(strip.y).add(row.add(clamp(ly, 0, 1)).mul(strip.rowH)).div(ATLAS_H);
  const cont = vec2(lx.mul(strip.w).div(ATLAS_W), ly.mul(strip.rowH).div(ATLAS_H));
  const s = texture(atlas, vec2(sx, sy)).grad(cont.dFdx(), cont.dFdy());
  const win: N = smoothstep(0, 0.12, ly).mul(fall(1, 0.88, ly)).mul(smoothstep(0, 0.03, lx)).mul(fall(1, 0.97, lx));
  return vec2(col(s.r), col(s.g).mul(win)).mul(inside);
}

/**
 * Segmented bar pattern along continuous segment coordinate s: lit between fract(s) in (a0..a1) rising and (b0..b1)
 * falling. When segments get smaller than a few pixels it fades to its mean, so it never aliases into moire.
 */
function segmentMask(s: N, a0: number, a1: number, b0: number, b1: number): N {
  const f = fract(s);
  const m = smoothstep(a0, a1, f).mul(fall(b1, b0, f));
  const mean = (b0 + b1) / 2 - (a0 + a1) / 2;
  return mix(m, float(mean), smoothstep(0.15, 0.4, fwidth(s)));
}

interface PanelOut {
  /** Bright (accent) emission weight. */
  prim: N;
  /** Soft glow weight. */
  glow: N;
  /** Amber warning weight (independent of the accent). */
  warn: N;
}

function throttleOverlay(atlas: THREE.Texture, q: N, u: CockpitUniforms): PanelOut {
  const T = LAYOUT.throttle;
  const [x0, y0, x1, y1] = T.bar;
  const fy = float(y1).sub(q.y).div(y1 - y0); // 0 at the bottom, 1 at the top
  const seg = fy.mul(T.segments);
  const segIdx = floor(seg);
  const gap = segmentMask(seg, 0.08, 0.2, 0.8, 0.92);
  const inBar = boxMask(q, [x0, y0, x1, y1]);
  const lit = step(segIdx.add(0.5).div(T.segments), u.throttle);
  const segFill = inBar.mul(gap).mul(lit.mul(0.95).add(0.07));
  // Leading edge marker.
  const edgeY = float(y1).sub(u.throttle.mul(y1 - y0));
  const marker = fall(2.5, 1.0, abs(q.y.sub(edgeY))).mul(boxMask(q, [x0 - 12, y0 - 4, x1 + 12, y1 + 4]));
  const pct = u.throttle.mul(100);
  const dg = digitsNode(atlas, q, T.digits, pct, u);
  const ml = stripNode(atlas, q, T.modeBox, MODE_STRIP, u.mode);
  // The top two segments warn in amber when lit (sustained full power).
  const hot = step(0.9, fy).mul(segFill).mul(lit);
  return { prim: segFill.mul(float(1).sub(hot)).add(marker).add(dg.x).add(ml.x), glow: dg.y.add(ml.y).add(segFill.mul(0.4)), warn: hot };
}

function speedOverlay(atlas: THREE.Texture, q: N, u: CockpitUniforms): PanelOut {
  const Sp = LAYOUT.speed;
  const d = q.sub(vec2(Sp.cx, Sp.cy));
  const rr = length(d);
  const ang = atan(d.x, d.y.negate()); // clockwise from up, radians
  const frac = ang.add(Sp.a).div(2 * Sp.a);
  const inArc = step(-Sp.a, ang).mul(step(ang, Sp.a));
  const band = fall(Sp.width / 2 + 1, Sp.width / 2 - 1, abs(rr.sub(Sp.r)));
  // Fine segmentation of the band.
  const segGap = segmentMask(frac.mul(60), 0.05, 0.18, 0.82, 0.95);
  const fill = band.mul(inArc).mul(segGap).mul(step(frac, u.speed).mul(0.95).add(0.06));
  // Bright tip at the current value.
  const tipA = u.speed.mul(2 * Sp.a).sub(Sp.a);
  const tip = vec2(sin(tipA), cos(tipA).negate()).mul(Sp.r).add(vec2(Sp.cx, Sp.cy));
  const tipD = length(q.sub(tip));
  const tipGlow = fall(14, 3, tipD);
  const dg = digitsNode(atlas, q, Sp.digits, u.speed.mul(100), u);
  return { prim: fill.add(tipGlow.mul(0.8)).add(dg.x), glow: dg.y.add(fill.mul(0.5)).add(tipGlow), warn: float(0) };
}

function attitudeOverlay(q: N, u: CockpitUniforms): PanelOut {
  const A = LAYOUT.attitude;
  const c = vec2(A.cx, A.cy);
  const d = q.sub(c);
  const rr = length(d);
  // Sun marker: disc with a ring of short rays.
  const ds = q.sub(u.sunMarker.xy);
  const sr = length(ds);
  const sa = atan(ds.y, ds.x);
  const rays = smoothstep(0.55, 0.85, cos(sa.mul(8))).mul(smoothstep(11, 13, sr)).mul(fall(20, 17, sr));
  const sun = fall(8.5, 6.5, sr).add(rays).mul(u.sunMarker.z);
  // Planet marker: ring.
  const pr = length(q.sub(u.planetMarker.xy));
  const planet = fall(2.4, 1.0, abs(pr.sub(9))).mul(u.planetMarker.z);
  // Outer dashed ring, slowly turning unless reduced motion.
  const turn = u.time.mul(0.15).mul(float(1).sub(u.still));
  const a = atan(d.x, d.y.negate()).add(turn);
  const dash = smoothstep(0.2, 0.35, fract(a.mul(36 / (2 * Math.PI))));
  const outer = fall(2.2, 0.8, abs(rr.sub(A.rMax))).mul(dash).mul(0.5);
  return { prim: sun.add(planet).add(outer), glow: sun.mul(1.2).add(planet.mul(0.6)), warn: float(0) };
}

function modeOverlay(q: N, u: CockpitUniforms, base: N): PanelOut {
  const M = LAYOUT.mode;
  const row = floor(q.y.sub(M.rowY0).div(M.rowH));
  const inRows = step(0, row).mul(step(row, 3));
  const active = select(row.equal(u.mode), float(1), float(0));
  const yIn = q.y.sub(M.rowY0).sub(u.mode.mul(M.rowH));
  const hl = boxMask(q, [M.x0 + 3, -9999, M.x1 - 3, 9999])
    .mul(step(8, yIn))
    .mul(step(yIn, M.rowH - 8));
  // Chevron '>' at the right end of the active row.
  const local = q.sub(vec2(M.x1 - 22, float(M.rowY0).add(u.mode.add(0.5).mul(M.rowH))));
  const chev = fall(2.8, 1.4, abs(local.x.add(abs(local.y).mul(0.8))))
    .mul(step(abs(local.y), 10))
    .mul(step(-10, local.x));
  // Inactive labels are dimmed (the label art is in the base primary channel).
  const dim = mix(float(1), mix(float(0.3), float(1), active), inRows);
  return { prim: base.r.mul(dim.sub(1)).add(hl.mul(0.16)).add(chev), glow: hl.mul(0.25).add(chev.mul(0.5)), warn: float(0) };
}

function statusOverlay(atlas: THREE.Texture, q: N, u: CockpitUniforms): PanelOut {
  const St = LAYOUT.status;
  const alertOn = step(0.5, u.alert);
  const word = stripNode(atlas, q, St.word, STATUS_STRIP, alertOn);
  const bar = (b: Box, v: N): N => {
    const f = q.x.sub(b[0]).div(b[2] - b[0]);
    const g = segmentMask(f.mul(24), 0.06, 0.2, 0.8, 0.94);
    return boxMask(q, b).mul(g).mul(step(f, v).mul(0.95).add(0.06));
  };
  const sunBar = bar(St.sunBar, clamp(u.sunI.div(3), 0, 1));
  // Alert bar: empty track in the accent, filled part in amber.
  const alertTrack = bar(St.alertBar, float(0));
  const alertFill = bar(St.alertBar, u.alert).sub(alertTrack);
  // Carrier wave: a calm sine, choppier with the alert; frozen under reduced motion.
  const [wx0, wy0, wx1, wy1] = St.wave;
  const wf = q.x.sub(wx0).div(wx1 - wx0);
  const ph = u.time.mul(2.2).mul(float(1).sub(u.still));
  const amp = float(0.28).add(u.alert.mul(0.5));
  const wave = sin(wf.mul(18).sub(ph)).mul(amp).add(sin(wf.mul(47).add(ph.mul(1.7))).mul(u.alert.mul(0.2)));
  const wy = float((wy0 + wy1) / 2).sub(wave.mul((wy1 - wy0) / 2));
  const line = fall(2.6, 1.0, abs(q.y.sub(wy))).mul(boxMask(q, St.wave));
  return {
    prim: word.x.mul(float(1).sub(alertOn)).add(sunBar).add(line).add(alertTrack),
    glow: word.y.add(line.mul(0.4)).add(sunBar.mul(0.3)),
    warn: word.x.mul(alertOn).add(alertFill).add(word.y.mul(alertOn).mul(0.5)),
  };
}

/**
 * Backplate coverage (0..~0.85) of a panel at region pixel q: a rounded panel with a brighter header band, plus
 * darker plates behind the readouts (for holo panes this is how much of the world behind is dimmed).
 */
function backplate(kind: PanelKind, q: N): N {
  const r = REGIONS[kind];
  const panel = roundBox(q, [6, 6, r.w - 6, r.h - 6], 14, 1);
  const fy = q.y.div(r.h);
  const grad = float(0.55).sub(clamp(fy.div(0.18), 0, 1).mul(0.23)).sub(clamp(fy.sub(0.18).div(0.82), 0, 1).mul(0.14));
  let plate: N = float(0);
  for (const b of PLATES[kind]) plate = max(plate, roundBox(q, b, 12, 8));
  return panel.mul(grad.add(plate.mul(0.3)));
}

/** Emission of a panel at its uv (canvas convention), in linear radiance, plus the backplate coverage. */
function panelEmission(kind: PanelKind, atlas: THREE.Texture, u: CockpitUniforms, holo: boolean): { color: N; fill: N } {
  const r = REGIONS[kind];
  const t = uv();
  const q = vec2(t.x.mul(r.w), t.y.mul(r.h)).toVar();
  const base = atlasAt(atlas, r, q).toVar();
  let o: PanelOut;
  switch (kind) {
    case 'throttle':
      o = throttleOverlay(atlas, q, u);
      break;
    case 'speed':
      o = speedOverlay(atlas, q, u);
      break;
    case 'attitude':
      o = attitudeOverlay(q, u);
      break;
    case 'mode':
      o = modeOverlay(q, u, base);
      break;
    case 'status':
      o = statusOverlay(atlas, q, u);
      break;
  }
  const accent = col(u.accent);
  const amber = vec3(...AMBER_EMISSION);
  // Scanlines (fixed pitch in region pixels), drifting slowly unless reduced motion.
  const drift = u.time.mul(14).mul(float(1).sub(u.still));
  // Scanline contrast fades out when a scanline period (4.4 region px) covers fewer than ~3 screen pixels (no moire).
  const scanAmp = fall(0.7, 0.35, fwidth(q.y).div(4.4)).mul(0.14);
  const scan = float(1).sub(scanAmp).add(scanAmp.mul(smoothstep(-0.3, 0.6, sin(q.y.add(drift).mul(Math.PI / 2.2)))));
  const flicker = float(1).add(sin(u.time.mul(57)).mul(sin(u.time.mul(13.3))).mul(0.025).mul(float(1).sub(u.still)));
  const prim = base.r.add(o.prim);
  const glow = base.g.add(o.glow);
  const sec = base.b;
  const fill = backplate(kind, q);
  // `accent` is the emission of a fully lit line (tone-map compensated); secondary art at half that.
  const lines = accent.mul(prim.add(sec.mul(0.5)));
  const halo = accent.mul(glow.mul(holo ? 0.3 : 0.22));
  const plate = accent.mul(fill.mul(holo ? 0.025 : 0.018));
  const warn = amber.mul(o.warn);
  return { color: lines.add(warn).mul(scan).add(halo).add(plate).mul(flicker).mul(u.panelGain), fill };
}

/** Physical display on a dashboard or console surface: dark glossy glass lit by the cabin, plus emission. */
export function screenMaterial(kind: PanelKind, atlas: THREE.Texture, u: CockpitUniforms, lightsNode: THREE.LightsNode, glowAnchor: THREE.Vector3): THREE.MeshStandardNodeMaterial {
  const m = surfaceMaterial({ color: [0.006, 0.008, 0.011], roughness: 0.18, metalness: 0, f0: 0.04 }, u, lightsNode, glowAnchor);
  const env = m.emissiveNode;
  m.emissiveNode = panelEmission(kind, atlas, u, false).color.add(env);
  return m;
}

/** Floating holographic pane: added emission over a smoked backing that keeps it readable over a sunlit planet. */
export function holoMaterial(kind: PanelKind, atlas: THREE.Texture, u: CockpitUniforms): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    premultipliedAlpha: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  m.forceSinglePass = true;
  const t = uv();
  // Fades out along the bottom edge, below the instruments, where the pane rises from its projector.
  const fadeIn = fall(1.0, 0.94, t.y);
  const e = panelEmission(kind, atlas, u, true);
  m.outputNode = vec4(e.color.mul(fadeIn), clamp(e.fill.mul(0.92), 0, 0.72).mul(fadeIn));
  return m;
}
