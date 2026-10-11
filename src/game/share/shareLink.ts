/**
 * Shareable coordinates: a compact, versioned URL fragment that reproduces a view (anchor body, float64 offset,
 * orientation, time and optional target, flight mode and field of view). Format and validation rules are documented
 * in docs/SHARE.md; the summary:
 *
 *   #ks1.<base64url payload>
 *
 * The payload is little-endian binary: flags, anchor, offset (3 × float64, so positions round-trip bit for bit),
 * quaternion (4 × float32, ~1e-7), UTC time (float64 ms), optional fields, then a CRC-32 over the version and the
 * payload so a truncated or mistyped link is rejected instead of sending the player somewhere else.
 *
 * Decoding never throws: hostile or malformed input yields null (decodeShare) or a reason (parseShare). Syntactic
 * validity is all this module can check; the game must still confirm that the anchor and target exist in its world.
 *
 * This file has no DOM or three.js dependency except copyText(), which feature-tests the browser APIs it uses.
 */

/** Format version written by encodeShare. */
export const SHARE_VERSION = 1;

export interface ShareState {
  v: 1;
  /** Anchor id: a body ('399'), a catalogue star ('*123'), 'ism' (interstellar frame) or a system id ('trappist-1b'). */
  anchor: string;
  /** Position relative to the anchor's centre (m, ICRF axes, float64). */
  offset: [number, number, number];
  /** Camera orientation (x, y, z, w), unit length. */
  quat: [number, number, number, number];
  /** Simulation time as UTC Unix milliseconds. */
  timeMs: number;
  /** Targeted body or star id (same syntax as anchor). */
  target?: string;
  /** Flight mode token, e.g. 'thrusters', 'impulse', 'cruise'. */
  mode?: string;
  /** Vertical field of view of the sharer (degrees). Informational: the game keeps the viewer's comfort setting. */
  fovDeg?: number;
}

export type ShareError =
  /** Nothing to decode (no fragment). */
  | 'empty'
  /** A fragment that is not a Known Sky link (other apps may use the fragment). */
  | 'not-share'
  /** Longer than any valid link: refused before decoding. */
  | 'too-long'
  /** A Known Sky link in a format version this build does not read. */
  | 'version'
  /** Characters outside base64url, or a non-canonical encoding. */
  | 'encoding'
  /** Checksum mismatch: truncated or altered. */
  | 'checksum'
  /** Byte layout does not match the version (lengths, flags, trailing data). */
  | 'malformed'
  /** Well-formed, but a value fails validation (non-finite, out of range, not a unit quaternion, bad id). */
  | 'invalid';

export type ShareParse = { ok: true; state: ShareState } | { ok: false; error: ShareError; version?: number };

/** Validation limits (see docs/SHARE.md for the reasoning behind each). */
export const SHARE_LIMITS = {
  /** Whole input accepted by parseShare (a full URL may be passed). */
  maxInputChars: 4096,
  /** The `ks1.` token. */
  maxTokenChars: 512,
  /** Anchor and target ids, bytes. */
  maxIdChars: 32,
  /** Mode token, bytes. */
  maxModeChars: 16,
  /**
   * Largest offset component (m): 1e22 m is about 320 kpc, beyond the Milky Way's disc. The game's star set reaches
   * 1,000 pc (3.1e19 m, docs/DECISIONS.md D-007), so real positions sit far inside this.
   */
  maxOffsetM: 1e22,
  /** ECMAScript Date range (ECMA-262 §21.4.1.1: ±8.64e15 ms). The game clamps to its ephemeris window. */
  maxAbsTimeMs: 8.64e15,
  /** A decoded quaternion must have |q| within this of 1 (float32 rounding is ~1e-7); it is then renormalised. */
  quatNormTolerance: 1e-3,
  fovDeg: { min: 1, max: 179 },
} as const;

const PREFIX = 'ks';
const TOKEN_RE = /^ks(0|[1-9][0-9]{0,2})\.([A-Za-z0-9_-]*)$/;
/**
 * Anchor and target ids: a NAIF-style integer body id without leading zeros ('10', '399'), a catalogue star index
 * ('*0'..'*9999999'), or a lowercase slug ('ism', 'trappist-1b'). Nothing else is accepted, so ids can never carry
 * markup, whitespace, path characters or property names such as '__proto__'.
 */
const ID_RE = /^(?:0|[1-9][0-9]{0,8}|\*(?:0|[1-9][0-9]{0,6})|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const MODE_RE = /^[a-z][a-z0-9-]*$/;

const FLAG_TARGET = 1;
const FLAG_MODE = 2;
const FLAG_FOV = 4;
const KNOWN_FLAGS = FLAG_TARGET | FLAG_MODE | FLAG_FOV;

/** True when `id` is a syntactically valid anchor or target id. */
export function isShareId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= SHARE_LIMITS.maxIdChars && ID_RE.test(id);
}

/** Why a state cannot be shared, or null when it is valid. */
export function shareStateProblem(s: ShareState): string | null {
  if (typeof s !== 'object' || s === null) return 'state is not an object';
  if (s.v !== 1) return 'unsupported version';
  if (!isShareId(s.anchor)) return 'anchor id is not valid';
  if (!Array.isArray(s.offset) || s.offset.length !== 3) return 'offset needs 3 components';
  for (const c of s.offset) {
    if (typeof c !== 'number' || !Number.isFinite(c) || Math.abs(c) > SHARE_LIMITS.maxOffsetM) return 'offset out of range';
  }
  if (!Array.isArray(s.quat) || s.quat.length !== 4) return 'quaternion needs 4 components';
  if (s.quat.some((c) => typeof c !== 'number' || !Number.isFinite(c))) return 'quaternion is not finite';
  const n = Math.hypot(...s.quat);
  if (Math.abs(n - 1) > SHARE_LIMITS.quatNormTolerance) return 'quaternion is not unit length';
  if (typeof s.timeMs !== 'number' || !Number.isFinite(s.timeMs) || Math.abs(s.timeMs) > SHARE_LIMITS.maxAbsTimeMs) return 'time out of range';
  if (s.target !== undefined && !isShareId(s.target)) return 'target id is not valid';
  if (s.mode !== undefined && (typeof s.mode !== 'string' || s.mode.length > SHARE_LIMITS.maxModeChars || !MODE_RE.test(s.mode))) return 'mode is not valid';
  if (s.fovDeg !== undefined) {
    const f = s.fovDeg;
    if (typeof f !== 'number' || !Number.isFinite(f) || f < SHARE_LIMITS.fovDeg.min || f > SHARE_LIMITS.fovDeg.max) return 'field of view out of range';
  }
  return null;
}

/**
 * Builds a ShareState from game-side values (SystemPos-like position, quaternion-like orientation). The quaternion is
 * normalised; null/undefined extras are left out.
 */
export function makeShareState(
  pos: { readonly anchor: string; readonly offset: { readonly x: number; readonly y: number; readonly z: number } },
  quat: { readonly x: number; readonly y: number; readonly z: number; readonly w: number },
  timeMs: number,
  extra: { target?: string | null | undefined; mode?: string | null | undefined; fovDeg?: number | null | undefined } = {},
): ShareState {
  const n = Math.hypot(quat.x, quat.y, quat.z, quat.w) || 1;
  const s: ShareState = {
    v: 1,
    anchor: pos.anchor,
    offset: [pos.offset.x, pos.offset.y, pos.offset.z],
    quat: [quat.x / n, quat.y / n, quat.z / n, quat.w / n],
    timeMs,
  };
  if (extra.target !== null && extra.target !== undefined) s.target = extra.target;
  if (extra.mode !== null && extra.mode !== undefined) s.mode = extra.mode;
  if (extra.fovDeg !== null && extra.fovDeg !== undefined) s.fovDeg = extra.fovDeg;
  return s;
}

// --- Encoding -------------------------------------------------------------------------------------------------------

/**
 * Encodes a state as a URL fragment token (without '#'): `ks1.<base64url>`. Throws RangeError for a state that would
 * not decode (a programming error in the caller); use shareStateProblem() to test first.
 */
export function encodeShare(s: ShareState): string {
  const problem = shareStateProblem(s);
  if (problem) throw new RangeError(`encodeShare: ${problem}`);
  const w = new ByteWriter();
  const flags = (s.target !== undefined ? FLAG_TARGET : 0) | (s.mode !== undefined ? FLAG_MODE : 0) | (s.fovDeg !== undefined ? FLAG_FOV : 0);
  w.u8(flags);
  w.str(s.anchor);
  for (const c of s.offset) w.f64(c);
  const n = Math.hypot(...s.quat);
  for (const c of s.quat) w.f32(c / n);
  w.f64(s.timeMs);
  if (s.target !== undefined) w.str(s.target);
  if (s.mode !== undefined) w.str(s.mode);
  if (s.fovDeg !== undefined) w.f32(s.fovDeg);
  const body = w.bytes();
  const crc = crc32(body, crc32(Uint8Array.of(SHARE_VERSION)));
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  new DataView(out.buffer).setUint32(body.length, crc, true);
  return `${PREFIX}${SHARE_VERSION}.${base64urlEncode(out)}`;
}

/** `base` without any fragment, plus `#` and the encoded state. */
export function shareUrl(base: string, s: ShareState): string {
  const hash = base.indexOf('#');
  return `${hash >= 0 ? base.slice(0, hash) : base}#${encodeShare(s)}`;
}

// --- Decoding -------------------------------------------------------------------------------------------------------

/**
 * Decodes a fragment ('#ks1.…' or 'ks1.…'; a full URL is also accepted and its fragment used). Never throws.
 * Returns the reason on failure so the UI can tell "made by a newer version" from "damaged link".
 */
export function parseShare(input: string): ShareParse {
  try {
    if (typeof input !== 'string') return { ok: false, error: 'empty' };
    if (input.length > SHARE_LIMITS.maxInputChars) return { ok: false, error: 'too-long' };
    let token = input.trim();
    const hash = token.indexOf('#');
    if (hash >= 0) token = token.slice(hash + 1);
    if (token.length === 0) return { ok: false, error: 'empty' };
    if (!token.startsWith(PREFIX)) return { ok: false, error: 'not-share' };
    if (token.length > SHARE_LIMITS.maxTokenChars) return { ok: false, error: 'too-long' };
    const m = TOKEN_RE.exec(token);
    if (!m) return { ok: false, error: /^ks(0|[1-9][0-9]{0,2})\./.test(token) ? 'encoding' : 'not-share' };
    const version = Number(m[1]);
    if (version !== SHARE_VERSION) return { ok: false, error: 'version', version };
    const bytes = base64urlDecode(m[2]!);
    if (!bytes) return { ok: false, error: 'encoding' };
    if (bytes.length < 5) return { ok: false, error: 'malformed' };
    const body = bytes.subarray(0, bytes.length - 4);
    const crc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4, true);
    if (crc32(body, crc32(Uint8Array.of(version))) !== crc) return { ok: false, error: 'checksum' };
    return decodeV1(body);
  } catch {
    return { ok: false, error: 'malformed' };
  }
}

/** Decodes a fragment, or null when it is missing, malformed, hostile or from an unsupported version. Never throws. */
export function decodeShare(fragment: string): ShareState | null {
  const r = parseShare(fragment);
  return r.ok ? r.state : null;
}

function decodeV1(body: Uint8Array): ShareParse {
  const r = new ByteReader(body);
  const flags = r.u8();
  if (flags === null || (flags & ~KNOWN_FLAGS) !== 0) return { ok: false, error: 'malformed' };
  const anchor = r.str(SHARE_LIMITS.maxIdChars);
  const ox = r.f64();
  const oy = r.f64();
  const oz = r.f64();
  const qx = r.f32();
  const qy = r.f32();
  const qz = r.f32();
  const qw = r.f32();
  const timeMs = r.f64();
  const target = flags & FLAG_TARGET ? r.str(SHARE_LIMITS.maxIdChars) : undefined;
  const mode = flags & FLAG_MODE ? r.str(SHARE_LIMITS.maxModeChars) : undefined;
  const fovDeg = flags & FLAG_FOV ? r.f32() : undefined;
  if (
    anchor === null ||
    ox === null ||
    oy === null ||
    oz === null ||
    qx === null ||
    qy === null ||
    qz === null ||
    qw === null ||
    timeMs === null ||
    target === null ||
    mode === null ||
    fovDeg === null ||
    !r.done
  ) {
    return { ok: false, error: 'malformed' };
  }
  const state: ShareState = { v: 1, anchor, offset: [ox, oy, oz], quat: [qx, qy, qz, qw], timeMs };
  if (target !== undefined) state.target = target;
  if (mode !== undefined) state.mode = mode;
  if (fovDeg !== undefined) state.fovDeg = fovDeg;
  if (shareStateProblem(state)) return { ok: false, error: 'invalid' };
  const n = Math.hypot(qx, qy, qz, qw);
  state.quat = [qx / n, qy / n, qz / n, qw / n];
  return { ok: true, state };
}

// --- Clipboard ------------------------------------------------------------------------------------------------------

/**
 * Copies text to the clipboard: the async Clipboard API first, then the legacy execCommand('copy') path (older
 * browsers, insecure contexts, or a denied permission). Resolves false when neither works; never throws.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clip = typeof navigator !== 'undefined' ? (navigator as Partial<Navigator>).clipboard : undefined;
    if (clip && typeof clip.writeText === 'function') {
      await clip.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or document not focused: fall through to the legacy path.
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const sel = document.getSelection();
  const saved = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.tabIndex = -1;
  ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;';
  document.body.append(ta);
  let ok: boolean;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    // The legacy API is deprecated but remains the only synchronous fallback where the Clipboard API is missing.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
    if (saved && sel) {
      sel.removeAllRanges();
      sel.addRange(saved);
    }
    active?.focus({ preventScroll: true });
  }
  return ok;
}

// --- Bytes ----------------------------------------------------------------------------------------------------------

class ByteWriter {
  private buf = new Uint8Array(128);
  private view = new DataView(this.buf.buffer);
  private n = 0;

  private need(k: number): void {
    if (this.n + k <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): void {
    this.need(1);
    this.view.setUint8(this.n, v);
    this.n += 1;
  }
  f32(v: number): void {
    this.need(4);
    this.view.setFloat32(this.n, v, true);
    this.n += 4;
  }
  f64(v: number): void {
    this.need(8);
    this.view.setFloat64(this.n, v, true);
    this.n += 8;
  }
  /** Length-prefixed ASCII (callers validate the character set first). */
  str(s: string): void {
    this.u8(s.length);
    this.need(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.n + i] = s.charCodeAt(i) & 0x7f;
    this.n += s.length;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

class ByteReader {
  private readonly view: DataView;
  private i = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get done(): boolean {
    return this.i === this.buf.length;
  }
  u8(): number | null {
    if (this.i + 1 > this.buf.length) return null;
    return this.view.getUint8(this.i++);
  }
  f32(): number | null {
    if (this.i + 4 > this.buf.length) return null;
    const v = this.view.getFloat32(this.i, true);
    this.i += 4;
    return v;
  }
  f64(): number | null {
    if (this.i + 8 > this.buf.length) return null;
    const v = this.view.getFloat64(this.i, true);
    this.i += 8;
    return v;
  }
  /** Length-prefixed printable ASCII of 1..max bytes; null on any violation. */
  str(max: number): string | null {
    const len = this.u8();
    if (len === null || len === 0 || len > max || this.i + len > this.buf.length) return null;
    let s = '';
    for (let k = 0; k < len; k++) {
      const c = this.buf[this.i + k]!;
      if (c < 0x21 || c > 0x7e) return null;
      s += String.fromCharCode(c);
    }
    this.i += len;
    return s;
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX: Int8Array = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** RFC 4648 §5 base64url without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]! + B64[(v >> 6) & 63]! + B64[v & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const v = bytes[i]! << 16;
    out += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]!;
  } else if (rest === 2) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]! + B64[(v >> 6) & 63]!;
  }
  return out;
}

/** Strict base64url decode (no padding, no whitespace, canonical trailing bits); null when invalid. */
export function base64urlDecode(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c]! : -1;
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, so every byte string has exactly one encoding.
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return out.subarray(0, o);
}

let CRC_TABLE: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3 polynomial, as used by PNG and zip). Pass a previous result to continue a running CRC. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = (previous ^ 0xffffffff) >>> 0;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
