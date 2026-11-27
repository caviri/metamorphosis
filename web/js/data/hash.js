// data/hash — digests. SHA-1/256/384/512 come from WebCrypto; MD5, CRC-32, Adler-32, XXH32, XXH64 and BLAKE3 are implemented here.
// Every function takes a Uint8Array and returns the digest as a Uint8Array (big-endian for the checksum/xxhash words, i.e. canonical hex).

export const ALGOS = ['md5', 'sha1', 'sha256', 'sha384', 'sha512', 'crc32', 'adler32', 'xxh32', 'xxh64', 'blake3'];
const SUBTLE = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
export const BLOCK = { md5: 64, sha1: 64, sha256: 64, sha384: 128, sha512: 128 };
const ALIAS = { 'sha-1': 'sha1', 'sha-256': 'sha256', 'sha-384': 'sha384', 'sha-512': 'sha512', xxhash32: 'xxh32', xxhash64: 'xxh64', xxhash: 'xxh64', 'crc-32': 'crc32', 'adler-32': 'adler32', 'blake3-256': 'blake3' };
export function algoName(a) {
  const k = String(a).toLowerCase().trim(); const n = ALIAS[k] || k;
  if (!ALGOS.includes(n)) throw new Error(`unknown hash algorithm "${a}" — accepted: ${ALGOS.join(', ')}`);
  return n;
}
const be32 = (x) => new Uint8Array([x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]);

// ── CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) ──
let crcT;
export function crc32(bytes, seed = 0) {
  if (!crcT) { crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c; } }
  let c = ~seed >>> 0;
  for (let i = 0; i < bytes.length; i++) c = crcT[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
export function adler32(bytes) {
  let a = 1; let b = 0; const n = bytes.length;
  for (let i = 0; i < n;) { const end = Math.min(n, i + 3800); for (; i < end; i++) { a += bytes[i]; b += a; } a %= 65521; b %= 65521; }
  return ((b << 16) | a) >>> 0;
}

// ── MD5 (RFC 1321) ──
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
let MD5_K;
export function md5(bytes) {
  if (!MD5_K) { MD5_K = new Int32Array(64); for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0; }
  const n = bytes.length; const total = (((n + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(total); buf.set(bytes); buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, (n * 8) >>> 0, true); dv.setUint32(total - 4, Math.floor(n / 536870912) >>> 0, true);
  let a0 = 0x67452301; let b0 = 0xefcdab89 | 0; let c0 = 0x98badcfe | 0; let d0 = 0x10325476;
  const m = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getInt32(off + i * 4, true);
    let a = a0; let b = b0; let c = c0; let d = d0;
    for (let i = 0; i < 64; i++) {
      let f; let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; } else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; } else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; } else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      f = (f + a + MD5_K[i] + m[g]) | 0; a = d; d = c; c = b;
      b = (b + ((f << MD5_S[i]) | (f >>> (32 - MD5_S[i])))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16); const o = new DataView(out.buffer);
  o.setInt32(0, a0, true); o.setInt32(4, b0, true); o.setInt32(8, c0, true); o.setInt32(12, d0, true);
  return out;
}

// ── XXH32 ──
const rotl = (x, r) => (x << r) | (x >>> (32 - r));
export function xxh32(b, seed = 0) {
  const P1 = 0x9e3779b1; const P2 = 0x85ebca77; const P3 = 0xc2b2ae3d; const P4 = 0x27d4eb2f; const P5 = 0x165667b1;
  const n = b.length; let i = 0; let h;
  const rd = (p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24));
  if (n >= 16) {
    let v1 = (seed + P1 + P2) | 0; let v2 = (seed + P2) | 0; let v3 = seed | 0; let v4 = (seed - P1) | 0;
    for (; i <= n - 16; i += 16) {
      v1 = Math.imul(rotl((v1 + Math.imul(rd(i), P2)) | 0, 13), P1);
      v2 = Math.imul(rotl((v2 + Math.imul(rd(i + 4), P2)) | 0, 13), P1);
      v3 = Math.imul(rotl((v3 + Math.imul(rd(i + 8), P2)) | 0, 13), P1);
      v4 = Math.imul(rotl((v4 + Math.imul(rd(i + 12), P2)) | 0, 13), P1);
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else h = (seed + P5) | 0;
  h = (h + n) | 0;
  for (; i <= n - 4; i += 4) h = Math.imul(rotl((h + Math.imul(rd(i), P3)) | 0, 17), P4);
  for (; i < n; i++) h = Math.imul(rotl((h + Math.imul(b[i], P5)) | 0, 11), P1);
  h ^= h >>> 15; h = Math.imul(h, P2); h ^= h >>> 13; h = Math.imul(h, P3); h ^= h >>> 16;
  return h >>> 0;
}

// ── XXH64 (BigInt arithmetic — correct but slow on very large inputs) ──
export function xxh64(b, seed = 0n) {
  const M = 0xffffffffffffffffn; const P1 = 11400714785074694791n; const P2 = 14029467366897019727n; const P3 = 1609587929392839161n; const P4 = 9650029242287828579n; const P5 = 2870177450012600261n;
  const rot = (x, r) => ((x << r) | (x >> (64n - r))) & M;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); const n = b.length; let i = 0; let h;
  const round = (acc, v) => (rot((acc + v * P2) & M, 31n) * P1) & M;
  const merge = (hh, v) => (((hh ^ round(0n, v)) * P1) + P4) & M;
  if (n >= 32) {
    let v1 = (seed + P1 + P2) & M; let v2 = (seed + P2) & M; let v3 = seed & M; let v4 = (seed - P1) & M;
    for (; i <= n - 32; i += 32) { v1 = round(v1, dv.getBigUint64(i, true)); v2 = round(v2, dv.getBigUint64(i + 8, true)); v3 = round(v3, dv.getBigUint64(i + 16, true)); v4 = round(v4, dv.getBigUint64(i + 24, true)); }
    h = (rot(v1, 1n) + rot(v2, 7n) + rot(v3, 12n) + rot(v4, 18n)) & M;
    h = merge(h, v1); h = merge(h, v2); h = merge(h, v3); h = merge(h, v4);
  } else h = (seed + P5) & M;
  h = (h + BigInt(n)) & M;
  for (; i <= n - 8; i += 8) h = ((rot(h ^ round(0n, dv.getBigUint64(i, true)), 27n) * P1) + P4) & M;
  if (i <= n - 4) { h = ((rot(h ^ ((BigInt(dv.getUint32(i, true)) * P1) & M), 23n) * P2) + P3) & M; i += 4; }
  for (; i < n; i++) h = (rot(h ^ ((BigInt(b[i]) * P5) & M), 11n) * P1) & M;
  h ^= h >> 33n; h = (h * P2) & M; h ^= h >> 29n; h = (h * P3) & M; h ^= h >> 32n;
  const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, h, false); return out;
}

// ── BLAKE3 (unkeyed hash mode, 32-byte output) ──
const B3_IV = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const B3_PERM = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
function b3compress(cv, m, counter, blockLen, flags) {
  const s = new Uint32Array(16);
  s.set(cv.subarray(0, 8)); s[8] = B3_IV[0]; s[9] = B3_IV[1]; s[10] = B3_IV[2]; s[11] = B3_IV[3];
  s[12] = counter >>> 0; s[13] = Math.floor(counter / 4294967296) >>> 0; s[14] = blockLen; s[15] = flags;
  let msg = m; let tmp = new Uint32Array(16);
  const g = (a, b, c, d, x, y) => {
    s[a] = (s[a] + s[b] + x) >>> 0; let t = s[d] ^ s[a]; s[d] = (t >>> 16) | (t << 16);
    s[c] = (s[c] + s[d]) >>> 0; t = s[b] ^ s[c]; s[b] = (t >>> 12) | (t << 20);
    s[a] = (s[a] + s[b] + y) >>> 0; t = s[d] ^ s[a]; s[d] = (t >>> 8) | (t << 24);
    s[c] = (s[c] + s[d]) >>> 0; t = s[b] ^ s[c]; s[b] = (t >>> 7) | (t << 25);
  };
  for (let r = 0; r < 7; r++) {
    g(0, 4, 8, 12, msg[0], msg[1]); g(1, 5, 9, 13, msg[2], msg[3]); g(2, 6, 10, 14, msg[4], msg[5]); g(3, 7, 11, 15, msg[6], msg[7]);
    g(0, 5, 10, 15, msg[8], msg[9]); g(1, 6, 11, 12, msg[10], msg[11]); g(2, 7, 8, 13, msg[12], msg[13]); g(3, 4, 9, 14, msg[14], msg[15]);
    if (r < 6) { for (let i = 0; i < 16; i++) tmp[i] = msg[B3_PERM[i]]; const sw = msg === m ? new Uint32Array(16) : msg; msg = tmp; tmp = sw; }
  }
  const out = new Uint32Array(8);
  for (let i = 0; i < 8; i++) out[i] = s[i] ^ s[i + 8];
  return out;
}
export function blake3(bytes) {
  const CHUNK_START = 1; const CHUNK_END = 2; const PARENT = 4; const ROOT = 8;
  const n = bytes.length; const nChunks = Math.max(1, Math.ceil(n / 1024));
  const block = new Uint8Array(64); const words = new Uint32Array(16); const bdv = new DataView(block.buffer);
  const loadBlock = (off, len) => { block.fill(0); block.set(bytes.subarray(off, off + len)); for (let i = 0; i < 16; i++) words[i] = bdv.getUint32(i * 4, true); };
  const chunkCV = (idx, rootFlag) => {
    const start = idx * 1024; const len = Math.min(1024, n - start); const nBlocks = Math.max(1, Math.ceil(len / 64));
    let cv = B3_IV;
    for (let b = 0; b < nBlocks; b++) {
      const bl = Math.min(64, len - b * 64); loadBlock(start + b * 64, bl);
      let flags = 0; if (b === 0) flags |= CHUNK_START; if (b === nBlocks - 1) flags |= CHUNK_END | rootFlag;
      cv = b3compress(cv, words, idx, bl, flags);
    }
    return cv;
  };
  const parent = (l, r, flag) => { const m = new Uint32Array(16); m.set(l); m.set(r, 8); return b3compress(B3_IV, m, 0, 64, PARENT | flag); };
  let root;
  if (nChunks === 1) root = chunkCV(0, ROOT);
  else {
    const stack = [];
    for (let i = 0; i < nChunks - 1; i++) { let cv = chunkCV(i, 0); let k = i + 1; while ((k & 1) === 0) { cv = parent(stack.pop(), cv, 0); k = Math.floor(k / 2); } stack.push(cv); }
    let cv = chunkCV(nChunks - 1, 0);
    while (stack.length > 1) cv = parent(stack.pop(), cv, 0);
    root = parent(stack.pop(), cv, ROOT);
  }
  const out = new Uint8Array(32); const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, root[i], true);
  return out;
}

/** digest(algo, bytes) → Promise<Uint8Array> */
export async function digest(algo, bytes) {
  algo = algoName(algo);
  if (SUBTLE[algo]) {
    if (!globalThis.crypto?.subtle) throw new Error(`${algo} needs WebCrypto (crypto.subtle), which is only available in secure contexts (https or localhost)`);
    return new Uint8Array(await crypto.subtle.digest(SUBTLE[algo], bytes));
  }
  if (algo === 'md5') return md5(bytes);
  if (algo === 'crc32') return be32(crc32(bytes));
  if (algo === 'adler32') return be32(adler32(bytes));
  if (algo === 'xxh32') return be32(xxh32(bytes));
  if (algo === 'xxh64') return xxh64(bytes);
  return blake3(bytes);
}

/** HMAC (RFC 2104) over md5 / sha1 / sha256 / sha384 / sha512 */
export async function hmac(algo, key, msg) {
  algo = algoName(algo); const bs = BLOCK[algo];
  if (!bs) throw new Error(`hmac supports: ${Object.keys(BLOCK).join(', ')} (got ${algo})`);
  if (key.length > bs) key = await digest(algo, key);
  const ipad = new Uint8Array(bs + msg.length); const k = new Uint8Array(bs); k.set(key);
  for (let i = 0; i < bs; i++) ipad[i] = k[i] ^ 0x36;
  ipad.set(msg, bs);
  const inner = await digest(algo, ipad);
  const opad = new Uint8Array(bs + inner.length);
  for (let i = 0; i < bs; i++) opad[i] = k[i] ^ 0x5c;
  opad.set(inner, bs);
  return digest(algo, opad);
}

export const toHex = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; };
export function fromHex(s) {
  const h = String(s).replace(/0x/gi, '').replace(/[\s:,_-]/g, '');
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('not valid hex: need an even number of 0-9 a-f digits (spaces, colons and 0x prefixes are ignored)');
  const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out;
}
