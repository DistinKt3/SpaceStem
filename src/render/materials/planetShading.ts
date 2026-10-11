/**
 * Planet shading in TSL (compiles to WGSL and GLSL): physically based single scattering (Rayleigh + Mie + ozone),
 * an analytic cloud layer, surface reflectance models, night lights and ocean glint.
 *
 * Units inside shaders: kilometres for positions/lengths, km^-1 for scattering coefficients. All positions are
 * camera-relative world space (the camera sits at the origin); `centerKm` is the planet centre relative to the camera.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  abs,
  atan,
  asin,
  attribute,
  clamp,
  dFdx,
  dFdy,
  cross,
  sign,
  dot,
  exp,
  float,
  length,
  log2,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  select,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL node graphs are dynamically typed */
type N = any;

export interface AtmosphereSpec {
  heightM: number;
  rayleigh: [number, number, number];
  rayleighScaleHeightM: number;
  mie: number;
  mieExtinction: number;
  mieScaleHeightM: number;
  mieG: number;
  mieColor?: [number, number, number];
  ozone: [number, number, number];
}

/** Per-body uniforms shared by the body's materials; updated every frame on the CPU. */
export class BodyUniforms {
  /** Planet centre relative to the camera, km, world (ICRF) axes. */
  readonly centerKm = uniform(new THREE.Vector3());
  /** Unit vector from the planet toward the Sun, world axes. */
  readonly sunDir = uniform(new THREE.Vector3(1, 0, 0));
  /** Solar irradiance at the body relative to 1 au, times pi (so a white Lambertian surface at 1 au -> 1.0). */
  readonly sunIrradiance = uniform(Math.PI);
  /** World (ICRF) -> body-fixed rotation, for lat/lon lookups of analytic layers. */
  readonly worldToBody = uniform(new THREE.Matrix3());
  /** Radians per pixel (vertical FOV / viewport height), for explicit texture LOD. */
  readonly radPerPixel = uniform(0.001);
  /** Ambient fill (earthshine, starlight), relative radiance. */
  readonly ambient = uniform(0.0015);
}

const PI = Math.PI;

/** Ray-sphere intersection (sphere at origin). Returns vec2(tNear, tFar); tFar < 0 or NaN-free miss as (-1,-1). */
function raySphere(ro: N, rd: N, r: N): N {
  const b = dot(ro, rd);
  const c = dot(ro, ro).sub(r.mul(r));
  const disc = b.mul(b).sub(c);
  const s = sqrt(max(disc, 0));
  return select(disc.lessThan(0), vec2(-1, -1), vec2(b.negate().sub(s), b.negate().add(s)));
}

/** Equirectangular UV from a body-fixed unit direction (column 0 = lon -180, row 0 = north). */
function equirectUv(dirBody: N): N {
  const lon = atan(dirBody.y, dirBody.x);
  const lat = asin(clamp(dirBody.z, -1, 1));
  return vec2(lon.div(2 * PI).add(0.5), lat.div(PI).add(0.5));
}

export interface AtmosphereNodes {
  /** In-scattered radiance and transmittance along a camera ray segment [t0, t1] (km). */
  scatter: (ro: N, rd: N, t0: N, t1: N, viewSamples: number) => { inscatter: N; transmittance: N };
  /** Transmittance from a point toward the Sun (0 if the planet blocks it). */
  sunTransmittance: (p: N) => N;
  Rt: number;
  R: number;
}

export function makeAtmosphere(spec: AtmosphereSpec, radiusM: number, u: BodyUniforms, lightSamples = 4): AtmosphereNodes {
  const R = radiusM / 1000;
  const Rt = (radiusM + spec.heightM) / 1000;
  const betaR = vec3(...(spec.rayleigh.map((v) => v * 1000) as [number, number, number]));
  const mieTint = vec3(...(spec.mieColor ?? [1, 1, 1]));
  const betaMs = float(spec.mie * 1000);
  const betaMe = float(spec.mieExtinction * 1000);
  const betaO = vec3(...(spec.ozone.map((v) => v * 1000) as [number, number, number]));
  const HR = spec.rayleighScaleHeightM / 1000;
  const HM = spec.mieScaleHeightM / 1000;
  const g = spec.mieG;
  const hasOzone = spec.ozone.some((v) => v > 0);

  const densities = (h: N): N => {
    const ozone = hasOzone ? max(float(0), float(1).sub(abs(h.sub(25)).div(15))) : float(0);
    return vec3(exp(h.negate().div(HR)), exp(h.negate().div(HM)), ozone);
  };
  const extinction = (od: N): N => betaR.mul(od.x).add(vec3(betaMe).mul(od.y)).add(betaO.mul(od.z));

  const sunTransmittance = (p: N): N => {
    const out = vec3(1).toVar();
    const sunDir = u.sunDir;
    const hitPlanet = raySphere(p, sunDir, float(R));
    const exit = raySphere(p, sunDir, float(Rt)).y;
    // Planet in the way (sun below the horizon): shadow, softened slightly near the terminator.
    If(hitPlanet.x.greaterThan(0), () => {
      out.assign(vec3(0));
    }).Else(() => {
      const step = max(exit, 0).div(lightSamples);
      const od = vec3(0).toVar();
      Loop(lightSamples, ({ i }: { i: N }) => {
        const q = p.add(sunDir.mul(step.mul(float(i).add(0.5))));
        od.addAssign(densities(length(q).sub(R)).mul(step));
      });
      out.assign(exp(extinction(od).negate()));
    });
    return out;
  };

  const scatter = (ro: N, rd: N, t0: N, t1: N, viewSamples: number): { inscatter: N; transmittance: N } => {
    const inscatter = vec3(0).toVar();
    const odView = vec3(0).toVar();
    const segment = max(t1.sub(t0), 0);
    const step = segment.div(viewSamples);
    const mu = dot(rd, u.sunDir);
    const phaseR = float(3 / (16 * PI)).mul(mu.mul(mu).add(1));
    const g2 = g * g;
    const phaseM = float((3 / (8 * PI)) * ((1 - g2) / (2 + g2)))
      .mul(mu.mul(mu).add(1))
      .div(pow(float(1 + g2).sub(mu.mul(2 * g)), 1.5));
    Loop(viewSamples, ({ i }: { i: N }) => {
      const t = t0.add(step.mul(float(i).add(0.5)));
      const p = ro.add(rd.mul(t));
      const d = densities(length(p).sub(R));
      const odStep = d.mul(step);
      const tView = exp(extinction(odView.add(odStep.mul(0.5))).negate());
      const tSun = sunTransmittance(p);
      const s = betaR.mul(d.x).mul(phaseR).add(mieTint.mul(betaMs).mul(d.y).mul(phaseM));
      inscatter.addAssign(s.mul(tView).mul(tSun).mul(step));
      odView.addAssign(odStep);
    });
    return { inscatter: inscatter.mul(u.sunIrradiance), transmittance: exp(extinction(odView).negate()) };
  };

  return { scatter, sunTransmittance, Rt, R };
}

export interface CloudSpec {
  texture: THREE.Texture;
  /** Cloud deck altitude, m. */
  altitudeM: number;
  /** Texture width in texels (for LOD). */
  widthTexels: number;
  channel: 'r' | 'a';
}

function cloudSample(cloud: CloudSpec, u: BodyUniforms, pRel: N, distKm: N, radiusKm: number): N {
  const dirBody = u.worldToBody.mul(normalize(pRel));
  const uvc = equirectUv(dirBody);
  const texelKm = (2 * PI * radiusKm) / cloud.widthTexels;
  const footprint = max(distKm.mul(u.radPerPixel), 1e-6);
  const lod = max(log2(footprint.div(texelKm)), 0);
  const t = texture(cloud.texture, uvc).level(lod);
  return cloud.channel === 'a' ? t.a : t.r;
}

export interface SurfaceOptions {
  radiusM: number;
  uniforms: BodyUniforms;
  /** Albedo node (linear RGB). */
  albedo: THREE.Node;
  brdf?: 'lambert' | 'lunar' | 'gas';
  atmosphere?: AtmosphereNodes;
  clouds?: CloudSpec;
  /** Equirect night-lights texture sampled with the geometry 'uv' attribute. */
  night?: THREE.Texture;
  /** Ocean glint from the per-vertex ocean flag (extras.x). */
  ocean?: boolean;
  /** Linear albedo multiplier (display-stretched maps -> physical reflectance). */
  albedoScale?: number;
  /**
   * Procedural micro-detail (Generated): bump and albedo variation driven by cube-face coordinates. Value = face
   * edge length in metres (sets the noise scale); omit for gas giants and stars.
   */
  detailFaceEdgeM?: number;
  viewSamples?: number;
}

/** Surface material for terrain chunks and gas-giant spheres. */
export function createSurfaceMaterial(o: SurfaceOptions): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const u = o.uniforms;
  const Rkm = o.radiusM / 1000;
  m.fragmentNode = Fn(() => {
    const fragKm = positionWorld.div(1000);
    const pRel = fragKm.sub(u.centerKm); // fragment relative to planet centre, km
    const camRel = u.centerKm.negate(); // camera relative to planet centre, km
    const viewDist = length(fragKm);
    const rd = fragKm.div(max(viewDist, 1e-9));
    let n: N = normalize(normalWorld);
    const l = u.sunDir;
    let albedoVar: N = float(1);
    if (o.detailFaceEdgeM) {
      // Two octave bands of face-uv noise (~40 m and ~4 m features). Float32 face-uv resolution is ~0.2 m on the
      // largest bodies, so features stay >= 2 m. Bump uses screen-space derivatives in world space (Mikkelsen 2010).
      const fuv = attribute('fuv', 'vec2');
      const coarse = mx_fractal_noise_float(vec3(fuv.mul(o.detailFaceEdgeM / 40), 0.5), 3, 2.0, 0.5, 1.0);
      const fine = mx_fractal_noise_float(vec3(fuv.mul(o.detailFaceEdgeM / 4), 1.5), 3, 2.0, 0.5, 1.0);
      // Band-limit: fade a band out when its smallest feature (wavelength/4) drops below ~3 pixels.
      const pxM = viewDist.mul(1000).mul(u.radPerPixel);
      const fadeFine = smoothstep(float(1.0), float(0.25), pxM);
      const fadeCoarse = smoothstep(float(10.0), float(2.5), pxM);
      const h = coarse.mul(2.5).mul(fadeCoarse).add(fine.mul(0.3).mul(fadeFine));
      const p = positionWorld;
      const dpdx = dFdx(p);
      const dpdy = dFdy(p);
      const r1 = cross(dpdy, n);
      const r2 = cross(n, dpdx);
      const det = dot(dpdx, r1);
      const grad = sign(det).mul(r1.mul(dFdx(h)).add(r2.mul(dFdy(h))));
      const bumped = abs(det).mul(n).sub(grad);
      // Guard degenerate derivatives (silhouettes): keep the geometric normal and never flip it.
      const ok = length(bumped).greaterThan(abs(det).mul(0.05)).and(dot(bumped, n).greaterThan(0));
      n = select(ok, normalize(bumped), n);
      albedoVar = float(1).add(coarse.mul(0.18).mul(fadeCoarse)).add(fine.mul(0.1).mul(fadeFine));
    }
    const ndl = dot(n, l);
    const nGeo = normalize(pRel);
    const sunHere = o.atmosphere ? o.atmosphere.sunTransmittance(pRel) : vec3(1);
    const albedo = (o.albedo as N).mul(o.albedoScale ?? 1).mul(albedoVar);
    let diffuse: N;
    if (o.brdf === 'lunar') {
      // Lunar-Lambert (McEwen 1991 style blend of Lommel-Seeliger and Lambert): flat-looking full Moon.
      const mu0 = max(ndl, 0);
      const mu = max(dot(n, rd.negate()), 1e-4);
      diffuse = mix(mu0, mu0.mul(2).div(mu0.add(mu)), 0.6);
    } else if (o.brdf === 'gas') {
      const mu = max(dot(n, rd.negate()), 0);
      diffuse = max(ndl, 0).mul(mix(float(0.75), float(1), sqrt(mu)));
    } else {
      diffuse = max(ndl, 0);
    }
    const color = albedo.mul(diffuse).mul(sunHere).mul(u.sunIrradiance.div(PI)).toVar();
    // Ambient fill so night sides are not pure black (earthshine/starlight scale).
    color.addAssign(albedo.mul(u.ambient));

    if (o.ocean) {
      const isOcean = attribute('extras', 'vec2').x;
      const h = normalize(l.sub(rd));
      const spec = pow(max(dot(nGeo, h), 0), 300).mul(18).add(pow(max(dot(nGeo, h), 0), 40).mul(0.25));
      const fres = float(0.02).add(pow(float(1).sub(max(dot(nGeo, rd.negate()), 0)), 5).mul(0.98));
      color.addAssign(sunHere.mul(spec.mul(fres).mul(isOcean).mul(max(ndl, 0)).mul(u.sunIrradiance.div(PI))));
    }

    if (o.clouds) {
      const cl = o.clouds;
      const cloudR = Rkm + cl.altitudeM / 1000;
      // Cloud shadow on the ground: cloud cover where the sun ray from this point crosses the deck.
      const tSunCloud = raySphere(pRel, l, float(cloudR)).y;
      const shadowP = pRel.add(l.mul(max(tSunCloud, 0)));
      const shadow = cloudSample(cl, u, shadowP, viewDist, cloudR);
      color.mulAssign(float(1).sub(shadow.mul(0.55)));
      // Clouds between the camera and the ground (camera above the deck).
      const hit = raySphere(camRel, rd, float(cloudR));
      const camAbove = length(camRel).greaterThan(cloudR);
      If(camAbove.and(hit.x.greaterThan(0)).and(hit.x.lessThan(viewDist)), () => {
        const cp = camRel.add(rd.mul(hit.x));
        const a = cloudSample(cl, u, cp, hit.x, cloudR);
        const cn = normalize(cp);
        const cSun = o.atmosphere ? o.atmosphere.sunTransmittance(cp) : vec3(1);
        const lit = max(dot(cn, l), 0).mul(0.9).add(0.04);
        const cloudColor = cSun.mul(lit).mul(u.sunIrradiance.div(PI)).add(u.ambient);
        color.assign(mix(color, cloudColor, smoothstep(0.05, 0.9, a)));
      });
    }

    if (o.night) {
      const lights = texture(o.night, uv()).rgb;
      const dark = smoothstep(0.08, -0.18, dot(nGeo, l));
      color.addAssign(lights.mul(lights).mul(dark).mul(0.9));
    }

    if (o.atmosphere) {
      const atm = o.atmosphere;
      const span = raySphere(camRel, rd, float(atm.Rt));
      const t0 = max(span.x, 0);
      const t1 = min(span.y, viewDist);
      If(t1.greaterThan(t0), () => {
        const s = atm.scatter(camRel, rd, t0, t1, o.viewSamples ?? 8);
        color.assign(color.mul(s.transmittance).add(s.inscatter));
      });
    }
    return vec4(color, 1);
  })();
  return m;
}

/** Sky shell: renders in-scattered light (and analytic clouds) for rays that do not hit opaque geometry. */
export function createSkyMaterial(radiusM: number, atm: AtmosphereNodes, u: BodyUniforms, clouds?: CloudSpec, viewSamples = 12): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  m.premultipliedAlpha = false;
  const Rkm = radiusM / 1000;
  m.fragmentNode = Fn(() => {
    const camRel = u.centerKm.negate();
    const rd = normalize(positionWorld);
    const span = raySphere(camRel, rd, float(atm.Rt));
    const ground = raySphere(camRel, rd, float(Rkm));
    const t0 = max(span.x, 0);
    const tEnd = select(ground.x.greaterThan(0), ground.x, span.y);
    const outColor = vec3(0).toVar();
    const alpha = float(0).toVar();
    If(tEnd.greaterThan(t0), () => {
      const s = atm.scatter(camRel, rd, t0, tEnd, viewSamples);
      outColor.assign(s.inscatter);
      alpha.assign(float(1).sub(dot(s.transmittance, vec3(1 / 3))));
      if (clouds) {
        const cloudR = Rkm + clouds.altitudeM / 1000;
        const hit = raySphere(camRel, rd, float(cloudR));
        const below = length(camRel).lessThan(cloudR);
        // From below the deck we see its underside; from above, rays that miss the ground can graze it at the limb.
        const tc = select(below, hit.y, hit.x);
        If(tc.greaterThan(0).and(tc.lessThan(tEnd)), () => {
          const cp = camRel.add(rd.mul(tc));
          const a = cloudSample(clouds, u, cp, tc, cloudR);
          const cSun = atm.sunTransmittance(cp);
          const lit = max(dot(normalize(cp), u.sunDir), 0).mul(0.85).add(0.05);
          const cloudColor = cSun.mul(lit).mul(u.sunIrradiance.div(PI));
          const k = smoothstep(0.05, 0.9, a).mul(select(below, float(1), float(0.7)));
          const frac = clamp(tc.sub(t0).div(max(tEnd.sub(t0), 1e-6)), 0, 1);
          outColor.assign(mix(outColor, cloudColor.add(s.inscatter.mul(frac)), k));
          alpha.assign(mix(alpha, float(1), k));
        });
      }
    });
    return vec4(outColor, alpha);
  })();
  return m;
}

/** Limb-darkened stellar photosphere; colour from effective temperature, HDR intensity for bloom. */
export function createStarMaterial(colorLinear: THREE.Color, intensity: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const c = vec3(colorLinear.r, colorLinear.g, colorLinear.b);
  m.fragmentNode = Fn(() => {
    const rd = normalize(positionWorld);
    const n = normalize(normalWorld);
    const mu = max(dot(n, rd.negate()), 0);
    // Quadratic limb darkening, coefficients typical of the Sun in the visible (Cox 2000).
    const limb = float(1).sub(float(0.47).mul(float(1).sub(mu))).sub(float(0.23).mul(pow(float(1).sub(mu), 2)));
    return vec4(c.mul(limb).mul(intensity), 1);
  })();
  return m;
}

/** Planetary rings in the body's equatorial plane: radial texture, lit, shadowed by the planet. */
export function createRingMaterial(tex: THREE.Texture, innerM: number, outerM: number, radiusM: number, u: BodyUniforms): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const inner = innerM / 1000;
  const outer = outerM / 1000;
  m.fragmentNode = Fn(() => {
    const pRel = positionWorld.div(1000).sub(u.centerKm);
    const r = length(pRel);
    const t = clamp(r.sub(inner).div(outer - inner), 0, 1);
    const sample = texture(tex, vec2(t, 0.5));
    const blocked = raySphere(pRel, u.sunDir, float(radiusM / 1000)).x.greaterThan(0);
    const light = select(blocked, float(0.03), float(1));
    const col = sample.rgb.mul(light).mul(u.sunIrradiance.div(PI)).mul(0.9).add(sample.rgb.mul(u.ambient));
    return vec4(col, sample.a.mul(0.95));
  })();
  return m;
}

/** Albedo from a cube-face tile with a per-material transform (scale = 2^L, offset = tile x,y). */
export function tileAlbedo(tex: THREE.Texture, level: number, tx: number, ty: number): THREE.Node {
  const fuv = attribute('fuv', 'vec2');
  const s = 1 << level;
  const tuv = fuv.mul(s).sub(vec2(tx, ty));
  return texture(tex, tuv).rgb;
}

/** Albedo from an equirectangular map using the chunk's continuous lon/lat 'uv' attribute. */
export function equirectAlbedo(tex: THREE.Texture): THREE.Node {
  return texture(tex, uv()).rgb;
}

/** Blackbody colour (linear sRGB, normalised) for an effective temperature, via Tanner Helland's fit. */
export function blackbodyColor(teffK: number): THREE.Color {
  const t = teffK / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = new THREE.Color().setRGB(
    Math.min(255, Math.max(0, r)) / 255,
    Math.min(255, Math.max(0, g)) / 255,
    Math.min(255, Math.max(0, b)) / 255,
    THREE.SRGBColorSpace,
  );
  return c;
}
