// Id helpers shared by client and server.
import type { UUID } from "./types";

// ---------------------------------------------------------------------------
// Random ids
// ---------------------------------------------------------------------------

/** Web Crypto when present (browsers, Node 19+). Looked up at call time so tests can stub it. */
function webCrypto(): Crypto | undefined {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c && typeof c === "object" ? c : undefined;
}

/**
 * n random bytes. getRandomValues exists even on insecure origins (unlike randomUUID).
 * `secure` callers (trip codes) refuse the Math.random fallback.
 */
function randomBytes(n: number, secure = false): Uint8Array {
  const bytes = new Uint8Array(n);
  const c = webCrypto();
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else if (secure) {
    throw new Error("crypto.getRandomValues is unavailable; refusing to make a guessable code");
  } else {
    // Last resort for ancient runtimes. Row ids only need to be unique, not secret.
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** Format 16 bytes as a lowercase 8-4-4-4-12 uuid string. */
function formatUuid(b: Uint8Array): UUID {
  let s = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
    s += HEX[b[i]];
  }
  return s;
}

/**
 * Random v4 uuid. crypto.randomUUID when available; it is missing on insecure origins
 * (e.g. an iPhone hitting the dev server over http on the LAN), so fall back to
 * getRandomValues with the version/variant bits set by hand.
 */
export function newId(): UUID {
  const c = webCrypto();
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(b);
}

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

function rotl32(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h;
}

/**
 * MurmurHash3_x86_128 (Austin Appleby's reference algorithm, public domain), pure 32-bit JS math.
 * Returns the four 32-bit output words h1..h4 as unsigned numbers. Not cryptographic.
 * Verified against SMHasher's verification value (0xB3ECE62A) in tests/ids.test.ts.
 */
export function murmur3x86_128(data: Uint8Array, seed = 0): [number, number, number, number] {
  const len = data.length;
  const nblocks = len >> 4;
  let h1 = seed | 0;
  let h2 = seed | 0;
  let h3 = seed | 0;
  let h4 = seed | 0;
  const c1 = 0x239b961b;
  const c2 = 0xab0e9789;
  const c3 = 0x38b34ae5;
  const c4 = 0xa1e38b93;
  const word = (i: number) => data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);

  for (let b = 0; b < nblocks; b++) {
    const i = b * 16;
    let k1 = word(i);
    let k2 = word(i + 4);
    let k3 = word(i + 8);
    let k4 = word(i + 12);

    k1 = Math.imul(k1, c1); k1 = rotl32(k1, 15); k1 = Math.imul(k1, c2); h1 ^= k1;
    h1 = rotl32(h1, 19); h1 = (h1 + h2) | 0; h1 = (Math.imul(h1, 5) + 0x561ccd1b) | 0;

    k2 = Math.imul(k2, c2); k2 = rotl32(k2, 16); k2 = Math.imul(k2, c3); h2 ^= k2;
    h2 = rotl32(h2, 17); h2 = (h2 + h3) | 0; h2 = (Math.imul(h2, 5) + 0x0bcaa747) | 0;

    k3 = Math.imul(k3, c3); k3 = rotl32(k3, 17); k3 = Math.imul(k3, c4); h3 ^= k3;
    h3 = rotl32(h3, 15); h3 = (h3 + h4) | 0; h3 = (Math.imul(h3, 5) + 0x96cd1c35) | 0;

    k4 = Math.imul(k4, c4); k4 = rotl32(k4, 18); k4 = Math.imul(k4, c1); h4 ^= k4;
    h4 = rotl32(h4, 13); h4 = (h4 + h1) | 0; h4 = (Math.imul(h4, 5) + 0x32ac3b17) | 0;
  }

  // Tail (the reference's fall-through switch, unrolled into byte-lane accumulation).
  const tail = nblocks * 16;
  const rem = len & 15;
  let k1 = 0;
  let k2 = 0;
  let k3 = 0;
  let k4 = 0;
  for (let j = rem - 1; j >= 0; j--) {
    const byte = data[tail + j];
    const shift = (j & 3) * 8;
    if (j >= 12) k4 ^= byte << shift;
    else if (j >= 8) k3 ^= byte << shift;
    else if (j >= 4) k2 ^= byte << shift;
    else k1 ^= byte << shift;
  }
  if (rem > 12) { k4 = Math.imul(k4, c4); k4 = rotl32(k4, 18); k4 = Math.imul(k4, c1); h4 ^= k4; }
  if (rem > 8) { k3 = Math.imul(k3, c3); k3 = rotl32(k3, 17); k3 = Math.imul(k3, c4); h3 ^= k3; }
  if (rem > 4) { k2 = Math.imul(k2, c2); k2 = rotl32(k2, 16); k2 = Math.imul(k2, c3); h2 ^= k2; }
  if (rem > 0) { k1 = Math.imul(k1, c1); k1 = rotl32(k1, 15); k1 = Math.imul(k1, c2); h1 ^= k1; }

  // Finalization.
  h1 ^= len; h2 ^= len; h3 ^= len; h4 ^= len;
  h1 = (h1 + h2) | 0; h1 = (h1 + h3) | 0; h1 = (h1 + h4) | 0;
  h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
  h1 = fmix32(h1); h2 = fmix32(h2); h3 = fmix32(h3); h4 = fmix32(h4);
  h1 = (h1 + h2) | 0; h1 = (h1 + h3) | 0; h1 = (h1 + h4) | 0;
  h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;

  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/**
 * Unambiguous byte encoding of the parts: each part is prefixed with its length, and every UTF-16
 * code unit is written as 2 bytes (little-endian). JS strings are UTF-16 on every platform, so the
 * client and the server always produce identical bytes, and ("a","bc") never collides with ("ab","c").
 */
function encodeParts(parts: string[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += 4 + p.length * 2;
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    const n = p.length;
    out[o++] = n & 0xff;
    out[o++] = (n >>> 8) & 0xff;
    out[o++] = (n >>> 16) & 0xff;
    out[o++] = (n >>> 24) & 0xff;
    for (let i = 0; i < n; i++) {
      const cu = p.charCodeAt(i);
      out[o++] = cu & 0xff;
      out[o++] = cu >>> 8;
    }
  }
  return out;
}

/** Fixed hash seed for deriveId. Changing it changes every derived id: don't. */
const DERIVE_SEED = 0x5c7a3b1e;

/**
 * Deterministic uuid-formatted id from string parts (so the client's optimistic row and the
 * server's row get the same id when both derive it from the same op). Not cryptographic.
 * Output is a valid RFC 4122 uuid (version nibble 5, variant 10xx) so it fits a Postgres uuid column.
 */
export function deriveId(...parts: string[]): UUID {
  const words = murmur3x86_128(encodeParts(parts.map(String)), DERIVE_SEED);
  const b = new Uint8Array(16);
  for (let w = 0; w < 4; w++) {
    const v = words[w];
    b[w * 4] = v >>> 24;
    b[w * 4 + 1] = (v >>> 16) & 0xff;
    b[w * 4 + 2] = (v >>> 8) & 0xff;
    b[w * 4 + 3] = v & 0xff;
  }
  b[6] = (b[6] & 0x0f) | 0x50; // version 5 (name-based)
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(b);
}

// ---------------------------------------------------------------------------
// Trip codes
// ---------------------------------------------------------------------------

/** No 0/o, 1/l/i: easy to read aloud and type. 31 symbols. */
export const TRIP_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const TRIP_CODE_LENGTH = 10;

/**
 * Unguessable trip code: 10 chars from "abcdefghjkmnpqrstuvwxyz23456789" via crypto.getRandomValues.
 * Rejection sampling keeps every symbol equally likely (bytes >= 248 = 31*8 are discarded, so
 * byte % 31 has no modulo bias). ~49.5 bits of entropy.
 */
export function newTripCode(): string {
  const alphabet = TRIP_CODE_ALPHABET;
  const limit = 256 - (256 % alphabet.length); // 248
  let code = "";
  while (code.length < TRIP_CODE_LENGTH) {
    const bytes = randomBytes(TRIP_CODE_LENGTH * 2, true);
    for (let i = 0; i < bytes.length && code.length < TRIP_CODE_LENGTH; i++) {
      if (bytes[i] < limit) code += alphabet[bytes[i] % alphabet.length];
    }
  }
  return code;
}
