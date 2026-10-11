import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { captionFor, captionLayout, fitText, formatUtc, wrapSegments } from '../../src/game/share/caption';
import { addPngText, findShareInPng, isPng, readPngText } from '../../src/game/share/pngText';
import { screenshotFilename } from '../../src/game/share/screenshot';
import { toastDuration } from '../../src/game/share/toast';
import {
  SHARE_LIMITS,
  base64urlDecode,
  base64urlEncode,
  crc32,
  decodeShare,
  encodeShare,
  isShareId,
  makeShareState,
  parseShare,
  shareStateProblem,
  shareUrl,
  type ShareState,
} from '../../src/game/share/shareLink';

/** Deterministic test generator (xorshift32); keeps runs reproducible without Math.random. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function unitQuat(r: () => number): [number, number, number, number] {
  const q: [number, number, number, number] = [r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5];
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

const base: ShareState = {
  v: 1,
  anchor: '399',
  offset: [6_778_137.123456789, -12_345.678901234567, 1_234_567.000000001],
  quat: [0.1, -0.2, 0.3, Math.sqrt(1 - 0.01 - 0.04 - 0.09)],
  timeMs: Date.UTC(2026, 9, 11, 14, 3, 12, 345),
};

/** Builds a v1 token from raw payload bytes with a correct checksum (for crafting hostile input). */
function craft(body: number[] | Uint8Array, version = 1): string {
  const b = Uint8Array.from(body);
  const out = new Uint8Array(b.length + 4);
  out.set(b);
  new DataView(out.buffer).setUint32(b.length, crc32(b, crc32(Uint8Array.of(version))), true);
  return `ks${version}.${base64urlEncode(out)}`;
}

/** Raw v1 payload writer mirroring docs/SHARE.md (independent of the module's private writer). */
function payload(p: {
  flags?: number;
  anchor?: string;
  offset?: number[];
  quat?: number[];
  timeMs?: number;
  target?: string;
  mode?: string;
  fov?: number;
  extra?: number[];
}): number[] {
  const bytes: number[] = [];
  const f64 = (v: number): void => {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, true);
    bytes.push(...new Uint8Array(dv.buffer));
  };
  const f32 = (v: number): void => {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v, true);
    bytes.push(...new Uint8Array(dv.buffer));
  };
  const str = (s: string): void => {
    bytes.push(s.length, ...Array.from(s, (c) => c.charCodeAt(0) & 0xff));
  };
  const flags = p.flags ?? (p.target !== undefined ? 1 : 0) | (p.mode !== undefined ? 2 : 0) | (p.fov !== undefined ? 4 : 0);
  bytes.push(flags);
  str(p.anchor ?? '399');
  for (const c of p.offset ?? [1, 2, 3]) f64(c);
  for (const c of p.quat ?? [0, 0, 0, 1]) f32(c);
  f64(p.timeMs ?? base.timeMs);
  if (p.target !== undefined) str(p.target);
  if (p.mode !== undefined) str(p.mode);
  if (p.fov !== undefined) f32(p.fov);
  bytes.push(...(p.extra ?? []));
  return bytes;
}

describe('share link: round trip', () => {
  it('reproduces offsets bit for bit, including 1e13 m and extreme float64 values', () => {
    const offsets: [number, number, number][] = [
      // 1e13 m and its float64 neighbours (one ulp at 1e13 is 2^-9 m).
      [1e13, -1e13, 1e13 - 2 ** -9],
      [1e13 + 2 ** -9, -(1e13 + 3 * 2 ** -9), 12_345_678_901_234.5],
      [2 ** 64 + 2 ** 12, -2.5e19, 1e22],
      [-0, 0, Number.MIN_VALUE],
      [Number.EPSILON, -Number.EPSILON, 2 ** -1074],
      [6_371_000.000000001, 0.1 + 0.2, -1 / 3],
    ];
    const r = rng(42);
    for (let i = 0; i < 200; i++) {
      const mag = 10 ** (r() * 26 - 4);
      offsets.push([(r() - 0.5) * mag, (r() - 0.5) * mag, (r() - 0.5) * mag]);
    }
    for (const offset of offsets) {
      const s: ShareState = { ...base, offset };
      const back = decodeShare(encodeShare(s));
      expect(back).not.toBeNull();
      for (let k = 0; k < 3; k++) expect(Object.is(back!.offset[k], offset[k]), `component ${k} of ${offset.join(',')}`).toBe(true);
    }
  });

  it('keeps the quaternion within 1e-6 and returns it unit length', () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const quat = unitQuat(r);
      const back = decodeShare(encodeShare({ ...base, quat }))!;
      for (let k = 0; k < 4; k++) expect(Math.abs(back.quat[k]! - quat[k]!)).toBeLessThan(1e-6);
      expect(Math.abs(Math.hypot(...back.quat) - 1)).toBeLessThan(1e-12);
    }
  });

  it('keeps time exactly (UTC milliseconds, fractional too)', () => {
    for (const timeMs of [0, -1, base.timeMs, 1_760_000_000_000.25, 4_102_444_800_000, -8.64e15, 8.64e15]) {
      expect(decodeShare(encodeShare({ ...base, timeMs }))!.timeMs).toBe(timeMs);
    }
  });

  it('accepts every anchor family, including odd but valid ids', () => {
    const ids = ['0', '10', '399', '301', '999999999', '*0', '*1', '*9999999', 'ism', 'trappist-1', 'trappist-1b', 'a', 'x1-2-3', 'proxima-cen-b'];
    for (const anchor of ids) {
      expect(isShareId(anchor), anchor).toBe(true);
      expect(decodeShare(encodeShare({ ...base, anchor, target: anchor }))).toMatchObject({ anchor, target: anchor });
    }
    // Maximum length (32) round-trips; 33 does not encode.
    const long = `a${'b'.repeat(31)}`;
    expect(decodeShare(encodeShare({ ...base, anchor: long }))!.anchor).toBe(long);
    expect(() => encodeShare({ ...base, anchor: `${long}c` })).toThrow(RangeError);
  });

  it('round-trips optional fields and omits absent ones', () => {
    const full: ShareState = { ...base, target: '*42', mode: 'cruise', fovDeg: 72.5 };
    const back = decodeShare(encodeShare(full))!;
    expect({ ...back, quat: null }).toEqual({ ...full, quat: null });
    back.quat.forEach((c, k) => expect(Math.abs(c - full.quat[k]!)).toBeLessThan(1e-7));
    const bare = decodeShare(encodeShare(base))!;
    expect(Object.keys(bare).sort()).toEqual(['anchor', 'offset', 'quat', 'timeMs', 'v']);
    expect(decodeShare(encodeShare({ ...base, mode: 'thrusters' }))!.mode).toBe('thrusters');
  });

  it('is compact and URL-safe', () => {
    const token = encodeShare({ ...base, target: '301', mode: 'cruise', fovDeg: 60 });
    expect(token).toMatch(/^ks1\.[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThan(110);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('is stable: a known state encodes to a fixed token (links made today keep working)', () => {
    const s: ShareState = { v: 1, anchor: '301', offset: [1_737_400, -250.5, 1e13], quat: [0, 0, 0, 1], timeMs: 1_760_184_000_000, target: '399' };
    const token = encodeShare(s);
    expect(token).toBe('ks1.AQMzMDEAAAAAuII6QQAAAAAAUG_AAABA5ZwwokIAAAAAAAAAAAAAAAAAAIA_AADgRTKdeUIDMzk5CewyZA');
    expect(decodeShare(`#${token}`)).toEqual(s);
  });

  it('makeShareState copies SystemPos-like values and normalises the quaternion', () => {
    const s = makeShareState({ anchor: '*12', offset: { x: 1e13, y: -2, z: 0.5 } }, { x: 0, y: 0, z: 0, w: 2 }, 5, { target: null, mode: 'impulse', fovDeg: undefined });
    expect(s).toEqual({ v: 1, anchor: '*12', offset: [1e13, -2, 0.5], quat: [0, 0, 0, 1], timeMs: 5, mode: 'impulse' });
    expect('target' in s).toBe(false);
  });

  it('shareUrl replaces any existing fragment and keeps the query', () => {
    const url = shareUrl('https://example.org/known-sky/?free=1#old', base);
    expect(url.startsWith('https://example.org/known-sky/?free=1#ks1.')).toBe(true);
    expect(url.split('#')).toHaveLength(2);
    expect(decodeShare(new URL(url).hash)).toEqual(decodeShare(encodeShare(base)));
    // A full URL is accepted by the decoder too.
    expect(parseShare(url).ok).toBe(true);
    expect(shareUrl('index.html', base)).toMatch(/^index\.html#ks1\./);
  });
});

describe('share link: validation and hostile input', () => {
  const good = encodeShare(base);

  it('reports why a fragment was refused', () => {
    expect(parseShare('')).toEqual({ ok: false, error: 'empty' });
    expect(parseShare('#')).toEqual({ ok: false, error: 'empty' });
    expect(parseShare('#section-2')).toEqual({ ok: false, error: 'not-share' });
    expect(parseShare('#ks1')).toEqual({ ok: false, error: 'not-share' });
    expect(parseShare('ks1.')).toEqual({ ok: false, error: 'malformed' });
    expect(parseShare('ks1.abc$')).toEqual({ ok: false, error: 'encoding' });
    expect(parseShare('ks1.a')).toEqual({ ok: false, error: 'encoding' });
    expect(parseShare(`ks1.${'A'.repeat(600)}`)).toEqual({ ok: false, error: 'too-long' });
    expect(parseShare(`#ks1.${'A'.repeat(5000)}`)).toEqual({ ok: false, error: 'too-long' });
  });

  it('distinguishes newer and older format versions', () => {
    expect(parseShare(`#ks2.${good.slice(4)}`)).toEqual({ ok: false, error: 'version', version: 2 });
    expect(parseShare('#ks0.AAAA')).toEqual({ ok: false, error: 'version', version: 0 });
    expect(parseShare('#ks999.AAAA')).toEqual({ ok: false, error: 'version', version: 999 });
    // A v1 payload relabelled as another version also fails its checksum if that version were ever read as v1.
    expect(parseShare(`ks01.${good.slice(4)}`).ok).toBe(false);
  });

  it('rejects any single-character change and any truncation (checksum)', () => {
    const body = good.slice(4);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let changed = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!;
      const swap = alphabet[(alphabet.indexOf(c) + 17) % 64]!;
      const r = parseShare(`ks1.${body.slice(0, i)}${swap}${body.slice(i + 1)}`);
      expect(r.ok, `edit at ${i}`).toBe(false);
      changed++;
    }
    expect(changed).toBe(body.length);
    for (let n = 1; n < body.length; n++) expect(decodeShare(`ks1.${body.slice(0, body.length - n)}`), `truncated by ${n}`).toBeNull();
  });

  it('rejects well-checksummed payloads with a bad layout', () => {
    expect(parseShare(craft(payload({}))).ok).toBe(true);
    expect(parseShare(craft(payload({ extra: [0] })))).toEqual({ ok: false, error: 'malformed' });
    expect(parseShare(craft(payload({ flags: 8 })))).toEqual({ ok: false, error: 'malformed' });
    expect(parseShare(craft(payload({ flags: 1 })))).toEqual({ ok: false, error: 'malformed' });
    expect(parseShare(craft(payload({}).slice(0, 30))).ok).toBe(false);
    expect(parseShare(craft([]))).toEqual({ ok: false, error: 'malformed' });
    // Zero-length and over-long strings.
    expect(parseShare(craft(payload({ anchor: '' })))).toEqual({ ok: false, error: 'malformed' });
    expect(parseShare(craft(payload({ anchor: 'a'.repeat(33) })))).toEqual({ ok: false, error: 'malformed' });
    expect(parseShare(craft(payload({ mode: 'm'.repeat(17) })))).toEqual({ ok: false, error: 'malformed' });
    // Non-printable and non-ASCII bytes inside ids.
    expect(parseShare(craft(payload({ anchor: '39\u00009' })))).toEqual({ ok: false, error: 'malformed' });
    expect(parseShare(craft(payload({ anchor: ' 399' })))).toEqual({ ok: false, error: 'malformed' });
    expect(parseShare(craft(payload({ anchor: 'é' })))).toEqual({ ok: false, error: 'malformed' });
  });

  it('rejects hostile ids that are printable but outside the whitelist', () => {
    for (const anchor of ['<script>', '__proto__', 'constructor()', '../../etc', '0399', '*01', '*', '-1', 'ISM', 'a_b', 'a--b', 'a-', 'x.y', '1e3', '"', "'", 'javascript:alert(1)']) {
      expect(isShareId(anchor), anchor).toBe(false);
      if (anchor.length <= 32) expect(parseShare(craft(payload({ anchor }))), anchor).toEqual({ ok: false, error: 'invalid' });
    }
    expect(parseShare(craft(payload({ target: '<b>' })))).toEqual({ ok: false, error: 'invalid' });
    expect(parseShare(craft(payload({ mode: 'Cruise' })))).toEqual({ ok: false, error: 'invalid' });
  });

  it('rejects non-finite and out-of-range numbers', () => {
    const bad = [
      payload({ offset: [NaN, 0, 0] }),
      payload({ offset: [0, Infinity, 0] }),
      payload({ offset: [0, 0, -Infinity] }),
      payload({ offset: [0, 0, 1.0000001e22] }),
      payload({ timeMs: NaN }),
      payload({ timeMs: Infinity }),
      payload({ timeMs: 8.64e15 + 1 }),
      payload({ fov: 0 }),
      payload({ fov: 180 }),
      payload({ fov: NaN }),
    ];
    for (const b of bad) expect(parseShare(craft(b)), JSON.stringify(b.slice(0, 4))).toEqual({ ok: false, error: 'invalid' });
  });

  it('requires a unit quaternion: renormalises small drift, rejects the rest', () => {
    const drift = decodeShare(craft(payload({ quat: [0, 0, 0, 1.0005] })))!;
    expect(drift.quat).toEqual([0, 0, 0, 1]);
    for (const quat of [
      [0, 0, 0, 0],
      [0, 0, 0, 1.01],
      [0.5, 0.5, 0.5, 0.4],
      [NaN, 0, 0, 1],
      [0, 0, 0, Infinity],
      [3e38, 3e38, 0, 0],
    ]) {
      expect(parseShare(craft(payload({ quat }))), quat.join(',')).toEqual({ ok: false, error: 'invalid' });
    }
  });

  it('never throws on arbitrary input', () => {
    const r = rng(99);
    const inputs: unknown[] = [null, undefined, 42, {}, [], 'ks1.' + '_'.repeat(511), '#'.repeat(100), '\u0000ks1.AAAA', 'ks1.\uD800'];
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(r() * 120);
      const bytes = new Uint8Array(len);
      for (let k = 0; k < len; k++) bytes[k] = Math.floor(r() * 256);
      inputs.push(`ks1.${base64urlEncode(bytes)}`);
      inputs.push(String.fromCharCode(...Array.from(bytes.slice(0, 40))));
    }
    for (const input of inputs) {
      expect(() => parseShare(input as string)).not.toThrow();
      expect(decodeShare(input as string)).toBeNull();
    }
  });

  it('encodeShare refuses states that would not decode', () => {
    expect(() => encodeShare({ ...base, anchor: '' })).toThrow(RangeError);
    expect(() => encodeShare({ ...base, offset: [NaN, 0, 0] })).toThrow(RangeError);
    expect(() => encodeShare({ ...base, quat: [0, 0, 0, 0] })).toThrow(RangeError);
    expect(() => encodeShare({ ...base, timeMs: Infinity })).toThrow(RangeError);
    expect(() => encodeShare({ ...base, target: 'Earth' })).toThrow(RangeError);
    expect(() => encodeShare({ ...base, fovDeg: 500 })).toThrow(RangeError);
    expect(shareStateProblem(base)).toBeNull();
    expect(shareStateProblem({ ...base, mode: 'x'.repeat(SHARE_LIMITS.maxModeChars + 1) })).not.toBeNull();
  });
});

describe('share link: helpers', () => {
  it('base64url is strict and canonical', () => {
    const r = rng(5);
    for (let len = 0; len < 40; len++) {
      const b = new Uint8Array(len);
      for (let k = 0; k < len; k++) b[k] = Math.floor(r() * 256);
      const s = base64urlEncode(b);
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(Array.from(base64urlDecode(s)!)).toEqual(Array.from(b));
    }
    expect(Array.from(base64urlDecode('AQ')!)).toEqual([1]);
    expect(base64urlDecode('AQ==')).toBeNull();
    expect(base64urlDecode('AB')).toBeNull(); // non-zero trailing bits: a second spelling of [0]
    expect(base64urlDecode('A+B/')).toBeNull();
    expect(base64urlDecode('A')).toBeNull();
  });

  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const a = new TextEncoder().encode('1234');
    const b = new TextEncoder().encode('56789');
    expect(crc32(b, crc32(a))).toBe(0xcbf43926);
  });
});

describe('caption text and layout', () => {
  const mono = { measureText: (s: string) => ({ width: Array.from(s).length * 10 }) };

  it('describes the place with real, computed quantities', () => {
    const utcMs = Date.UTC(2026, 9, 11, 14, 3, 12);
    const body = captionFor({ nearName: 'Moon', nearIsStar: false, altitudeM: 60, starName: 'Sun', starDistanceM: 1.496e11, utcMs });
    expect(body.title).toBe('Moon · 60 m above the surface');
    expect(body.subtitle).toBe('2026-10-11 14:03:12 UTC · Sun 1 au · light time 8 min 19 s');
    expect(body.credits).toContain('Some surface detail is Generated');
    expect(captionFor({ nearName: 'Moon', nearIsStar: false, altitudeM: 0.4, starName: 'Sun', starDistanceM: 1.496e11, utcMs }).title).toBe('Moon · on the surface');
    expect(captionFor({ nearName: 'Mars', nearIsStar: false, altitudeM: 5e6, landed: true, starName: 'Sun', starDistanceM: 2.3e11, utcMs }).title).toBe('Mars · on the surface');
    const star = captionFor({ nearName: 'Proxima Centauri', nearIsStar: true, altitudeM: 1.8e11, starName: 'Proxima Centauri', starDistanceM: 1.8e11, utcMs });
    expect(star.title).toBe('Proxima Centauri · 1.203 au away');
    expect(star.subtitle).toBe('2026-10-11 14:03:12 UTC · light time 10 min 0 s');
    const deep = captionFor({ nearName: 'Sun', nearIsStar: true, altitudeM: 1.3e16, starName: 'Sun', starDistanceM: 1.3e16, utcMs });
    expect(deep.title).toBe('Interstellar space · Sun 1.374 ly away');
    expect(deep.subtitle).toBe('2026-10-11 14:03:12 UTC');
    expect(formatUtc(NaN)).toBe('—');
  });

  it('scales with the image and keeps text legible on small images', () => {
    const hd = captionLayout(1920, 1080);
    const uhd = captionLayout(3840, 2160);
    expect(uhd.titlePx / hd.titlePx).toBeCloseTo(2, 5);
    const tiny = captionLayout(320, 180);
    expect(tiny.titlePx).toBeGreaterThanOrEqual(13);
    expect(tiny.creditsPx).toBeGreaterThanOrEqual(9);
    // The text block (title, subtitle, two credit lines, gaps) stays under a fifth of a 16:9 frame.
    const band = hd.padBottom + 2 * hd.creditsLineH + hd.gap + hd.titlePx * 1.15 + hd.subtitlePx * 1.5;
    expect(band / 1080).toBeLessThan(0.2);
  });

  it('fits and wraps text, keeping the provenance note whole', () => {
    expect(fitText(mono, 'abcdef', 60)).toBe('abcdef');
    expect(fitText(mono, 'abcdefgh', 60)).toBe('abcde…');
    expect(fitText(mono, 'abc', 0)).toBe('');
    const credits = 'Positions: A · Stars: BBBB · Sky: CCCCCC · Some surface detail is Generated';
    expect(wrapSegments(mono, credits, 1000, 2)).toEqual([credits]);
    const two = wrapSegments(mono, credits, 330, 2);
    expect(two).toHaveLength(2);
    expect(two[1]).toBe('Some surface detail is Generated');
    expect(two[0]!.endsWith('…')).toBe(true);
    const many = wrapSegments(mono, credits, 340, 4);
    expect(many).toEqual(['Positions: A · Stars: BBBB', 'Sky: CCCCCC', 'Some surface detail is Generated']);
  });

  it('names screenshot files by local capture time', () => {
    expect(screenshotFilename(new Date(2026, 9, 11, 4, 3, 2))).toBe('knownsky-20261011-040302.png');
    expect(screenshotFilename(new Date(2027, 0, 1, 23, 59, 59))).toBe('knownsky-20270101-235959.png');
  });

  it('gives toasts a reading time between 4 and 12 seconds', () => {
    expect(toastDuration('Saved')).toBe(4000);
    expect(toastDuration('x'.repeat(100), 'y'.repeat(30))).toBe(1800 + 55 * 130);
    expect(toastDuration('x'.repeat(1000))).toBe(12_000);
  });
});

describe('PNG text metadata', () => {
  function chunk(type: string, data: Uint8Array): Buffer {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  }

  /** A valid 2x1 RGBA PNG built from scratch (IHDR, IDAT, IEND). */
  function tinyPng(): Uint8Array {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255]);
    return new Uint8Array(
      Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]),
    );
  }

  /** Chunk types in order, checking every CRC on the way. */
  function chunkTypes(png: Uint8Array): string[] {
    const b = Buffer.from(png);
    const types: string[] = [];
    for (let i = 8; i < b.length; ) {
      const len = b.readUInt32BE(i);
      const type = b.toString('latin1', i + 4, i + 8);
      expect(b.readUInt32BE(i + 8 + len), `${type} CRC`).toBe(crc32(b.subarray(i + 4, i + 8 + len)));
      types.push(type);
      i += 12 + len;
    }
    return types;
  }

  it('adds UTF-8 text after IHDR and reads it back, with the share link', () => {
    const link = `https://example.org/known-sky/#${encodeShare(base)}`;
    const png = addPngText(tinyPng(), { Software: 'Known Sky', Title: 'Moon · 60 m above the surface', Comment: `Open this link: ${link}`, 'bad\nkey': 'x', '': 'y' });
    expect(isPng(png)).toBe(true);
    expect(chunkTypes(png)).toEqual(['IHDR', 'iTXt', 'iTXt', 'iTXt', 'IDAT', 'IEND']);
    expect(readPngText(png)).toEqual([
      { keyword: 'Software', text: 'Known Sky' },
      { keyword: 'Title', text: 'Moon · 60 m above the surface' },
      { keyword: 'Comment', text: `Open this link: ${link}` },
    ]);
    expect(decodeShare(findShareInPng(png)!)).toEqual(decodeShare(encodeShare(base)));
  });

  it('reads tEXt, ignores files without a link, and never throws on damaged files', () => {
    expect(findShareInPng(tinyPng())).toBeNull();
    expect(addPngText(new Uint8Array([1, 2, 3]), { Comment: 'x' })).toEqual(new Uint8Array([1, 2, 3]));
    const png = tinyPng();
    // A hand-made tEXt chunk (Latin-1) after IHDR, which ends at byte 33.
    const text = chunk('tEXt', new Uint8Array(Buffer.from(`Comment\0see #${encodeShare({ ...base, anchor: '*7' })}`, 'latin1')));
    const withText = new Uint8Array(Buffer.concat([Buffer.from(png.subarray(0, 33)), text, Buffer.from(png.subarray(33))]));
    expect(chunkTypes(withText)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
    expect(decodeShare(findShareInPng(withText)!)?.anchor).toBe('*7');
    // Truncations and a chunk claiming 4 GB must not throw.
    for (let n = 0; n < withText.length; n += 7) expect(() => readPngText(withText.subarray(0, n))).not.toThrow();
    const huge = new Uint8Array(withText);
    new DataView(huge.buffer).setUint32(33, 0xffffffff);
    expect(readPngText(huge)).toEqual([]);
  });
});
