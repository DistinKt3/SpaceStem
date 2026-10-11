/**
 * PNG text metadata (PNG specification, 3rd edition, §11.3.3 tEXt and iTXt; W3C 2025). Screenshots carry the share
 * link in an iTXt "Comment" chunk, so an image found later still leads back to the place it shows: dropping it on the
 * game reads the link back with findShareInPng(). Only uncompressed text is written or read.
 */
import { crc32 } from './shareLink';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Reading limits: a hostile file can declare huge chunk lengths. */
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_CHUNKS = 100_000;

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

function keywordOk(k: string): boolean {
  // 1-79 Latin-1 printable characters, no leading/trailing or double spaces.
  return k.length >= 1 && k.length <= 79 && /^[\x21-\x7e\xa1-\xff](?:[\x20-\x7e\xa1-\xff]*[\x21-\x7e\xa1-\xff])?$/.test(k) && !k.includes('  ');
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** iTXt chunk payload: keyword, null, compression flag 0, method 0, empty language tag and translated keyword, UTF-8. */
function itxt(keyword: string, text: string): Uint8Array {
  const kw = Uint8Array.from(Array.from(keyword, (c) => c.charCodeAt(0)));
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(kw.length + 5 + body.length);
  out.set(kw, 0);
  // kw.length: null separator; +1 compression flag; +2 method; +3 empty language tag's null; +4 translated keyword's null.
  out.set(body, kw.length + 5);
  return out;
}

/**
 * Returns a copy of `png` with iTXt chunks inserted right after IHDR. Entries with an invalid keyword are skipped.
 * Returns the input unchanged when it is not a PNG.
 */
export function addPngText(png: Uint8Array, entries: Readonly<Record<string, string>>): Uint8Array {
  if (!isPng(png) || png.length < 33) return png;
  const ihdrLen = new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(8);
  const ihdrEnd = 8 + 12 + ihdrLen;
  if (ihdrEnd > png.length) return png;
  const extra = Object.entries(entries)
    .filter(([k, v]) => keywordOk(k) && typeof v === 'string')
    .map(([k, v]) => chunk('iTXt', itxt(k, v)));
  const size = extra.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(png.length + size);
  out.set(png.subarray(0, ihdrEnd), 0);
  let o = ihdrEnd;
  for (const c of extra) {
    out.set(c, o);
    o += c.length;
  }
  out.set(png.subarray(ihdrEnd), o);
  return out;
}

/** Text entries (tEXt and uncompressed iTXt) of a PNG, in file order. Never throws; malformed files give []. */
export function readPngText(png: Uint8Array): { keyword: string; text: string }[] {
  const out: { keyword: string; text: string }[] = [];
  try {
    if (!isPng(png)) return out;
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const latin1 = (a: Uint8Array): string => String.fromCharCode(...a);
    const utf8 = new TextDecoder('utf-8', { fatal: false });
    let i = 8;
    for (let n = 0; n < MAX_CHUNKS && i + 12 <= png.length; n++) {
      const len = dv.getUint32(i);
      const type = latin1(png.subarray(i + 4, i + 8));
      const start = i + 8;
      const end = start + len;
      if (end + 4 > png.length) break;
      if ((type === 'tEXt' || type === 'iTXt') && len <= MAX_TEXT_BYTES) {
        const data = png.subarray(start, end);
        const z = data.indexOf(0);
        if (z > 0) {
          const keyword = latin1(data.subarray(0, z));
          if (type === 'tEXt') out.push({ keyword, text: latin1(data.subarray(z + 1)) });
          else if (data[z + 1] === 0) {
            // Skip the language tag and translated keyword (each null-terminated).
            const lang = data.indexOf(0, z + 3);
            const trans = lang >= 0 ? data.indexOf(0, lang + 1) : -1;
            if (trans >= 0) out.push({ keyword, text: utf8.decode(data.subarray(trans + 1)) });
          }
        }
      }
      if (type === 'IEND') break;
      i = end + 4;
    }
  } catch {
    return out;
  }
  return out;
}

const TOKEN_IN_TEXT = /#(ks(?:0|[1-9][0-9]{0,2})\.[A-Za-z0-9_-]{1,600})/;

/** The share token ('ks1.…') carried by a PNG's text chunks ("Comment" first), or null. */
export function findShareInPng(png: Uint8Array): string | null {
  const entries = readPngText(png);
  entries.sort((a, b) => Number(b.keyword === 'Comment') - Number(a.keyword === 'Comment'));
  for (const e of entries) {
    const m = TOKEN_IN_TEXT.exec(e.text);
    if (m) return m[1]!;
  }
  return null;
}
