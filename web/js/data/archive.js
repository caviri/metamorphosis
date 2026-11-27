// data/archive — zip central-directory reader, guarded inflate, tar reader/writer, safe entry paths, globs.
import { libFflate } from './formats.js';
import { crc32 } from './hash.js';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 4294967296;
const decName = (bytes, utf8) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(bytes); } };

/**
 * Map an archive entry name to a safe relative path, or say why not.
 * Refused: ".." segments (zip-slip), drive-letter paths, NUL bytes, empty names. Leading "/" and "./" are stripped (as tar/unzip do).
 */
export function safePath(name) {
  if (typeof name !== 'string' || name === '') return { reason: 'empty name' };
  if (name.includes('\0')) return { reason: 'NUL byte in name' };
  const n = name.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(n)) return { reason: 'drive-letter path' };
  const segs = n.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) return { reason: 'path traversal ("..")' };
  if (!segs.length) return { reason: 'empty name' };
  return { path: segs.join('/'), absolute: n.startsWith('/') };
}

export function globToRegExp(glob) {
  let re = ''; let i = 0; let depth = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { i += 2; if (glob[i] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; continue; } re += '[^/]*'; } else if (c === '?') re += '[^/]';
    else if (c === '{') { depth++; re += '(?:'; } else if (c === '}' && depth) { depth--; re += ')'; } else if (c === ',' && depth) re += '|';
    else if (c === '[') { const j = glob.indexOf(']', i + 1); if (j > i + 1) { re += '[' + glob.slice(i + 1, j).replace(/\\/g, '\\\\').replace(/^!/, '^') + ']'; i = j; } else re += '\\['; } else re += c.replace(/[.+^$()|\\\]{}]/g, '\\$&');
    i++;
  }
  return new RegExp(`^${re}$`);
}
/** matcher for a list of globs; a pattern without "/" also matches the base name */
export function globMatcher(patterns) {
  if (!patterns || !patterns.length) return () => true;
  const res = patterns.map((p) => ({ re: globToRegExp(p.replace(/^\.\//, '')), base: !p.includes('/') }));
  return (path) => res.some(({ re, base }) => re.test(path) || (base && re.test(path.split('/').pop())));
}

const METHODS = { 0: 'store', 8: 'deflate', 9: 'deflate64', 12: 'bzip2', 14: 'lzma', 93: 'zstd', 95: 'xz', 98: 'ppmd', 99: 'aes' };
const dosTime = (d, t) => { if (!d) return null; const y = 1980 + (d >> 9); const iso = `${y}-${String((d >> 5) & 15).padStart(2, '0')}-${String(d & 31).padStart(2, '0')}T${String(t >> 11).padStart(2, '0')}:${String((t >> 5) & 63).padStart(2, '0')}:${String((t & 31) * 2).padStart(2, '0')}`; return iso; };

/** zipEntries(bytes) → [{name, dir, size, compressedSize, method, encrypted, crc, modified, offset, symlink}] from the central directory (zip64 aware) */
export function zipEntries(b) {
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { e = i; break; }
  if (e < 0) throw new Error('zip: end-of-central-directory record not found — the file is truncated or not a zip');
  let count = u16(b, e + 10); let cdOff = u32(b, e + 16); let cdSize = u32(b, e + 12);
  if (e >= 20 && u32(b, e - 20) === 0x07064b50) {
    const z = u64(b, e - 12);
    if (z + 56 <= b.length && u32(b, z) === 0x06064b50) { count = u64(b, z + 32); cdSize = u64(b, z + 40); cdOff = u64(b, z + 48); }
  }
  // tolerate data prepended to the zip (self-extractors): offsets are then shifted by a constant
  let shift = 0;
  if (u32(b, cdOff) !== 0x02014b50 && e - cdSize >= 0 && u32(b, e - cdSize) === 0x02014b50) shift = e - cdSize - cdOff;
  const out = []; let p = cdOff + shift;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new Error(`zip: corrupt central directory at entry ${i}`);
    const made = u16(b, p + 4); const flags = u16(b, p + 8); const method = u16(b, p + 10);
    let csize = u32(b, p + 20); let size = u32(b, p + 24); const nl = u16(b, p + 28); const xl = u16(b, p + 30); const cl = u16(b, p + 32);
    const ext = u32(b, p + 38); let off = u32(b, p + 42);
    const name = decName(b.subarray(p + 46, p + 46 + nl), !!(flags & 0x800));
    for (let x = p + 46 + nl; x + 4 <= p + 46 + nl + xl;) {
      const id = u16(b, x); const len = u16(b, x + 2);
      if (id === 1) { let q = x + 4; if (size === 0xffffffff) { size = u64(b, q); q += 8; } if (csize === 0xffffffff) { csize = u64(b, q); q += 8; } if (off === 0xffffffff) off = u64(b, q); }
      x += 4 + len;
    }
    const mode = (made >> 8) === 3 ? ext >>> 16 : 0;
    out.push({ name, dir: name.endsWith('/') || !!(ext & 0x10 && size === 0 && name.endsWith('/')), size, compressedSize: csize, method: METHODS[method] || `method-${method}`, methodId: method, encrypted: !!(flags & 1), crc: u32(b, p + 16), modified: dosTime(u16(b, p + 14), u16(b, p + 12)), offset: off + shift, symlink: (mode & 0xf000) === 0xa000 });
    p += 46 + nl + xl + cl;
  }
  return out;
}

export class LimitError extends Error {}
/** inflate with a hard output cap (zip-bomb guard): kind = 'inflate' | 'gunzip' | 'unzlib' | 'auto' */
export async function guardedInflate(comp, limit, kind = 'inflate') {
  const f = await libFflate();
  const S = kind === 'gunzip' ? f.Gunzip : kind === 'unzlib' ? f.Unzlib : kind === 'auto' ? f.Decompress : f.Inflate;
  const chunks = []; let total = 0;
  const s = new S();
  s.ondata = (chunk) => { total += chunk.length; if (total > limit) throw new LimitError(`decompressed size exceeds the limit of ${limit} bytes`); chunks.push(chunk); };
  const STEP = 65536;
  try {
    if (!comp.length) s.push(new Uint8Array(0), true);
    for (let p = 0; p < comp.length; p += STEP) s.push(comp.subarray(p, Math.min(comp.length, p + STEP)), p + STEP >= comp.length);
  } catch (e) {
    if (e instanceof LimitError) throw e;
    throw new Error(`corrupt compressed data (${e?.message || e})`);
  }
  const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** bytes of one zip entry, verified against its CRC-32; budget = max bytes this entry may inflate to */
export async function zipRead(b, entry, budget) {
  if (entry.encrypted) throw new Error('entry is encrypted (password-protected zips are not supported)');
  const p = entry.offset;
  if (p + 30 > b.length || u32(b, p) !== 0x04034b50) throw new Error('local file header missing (corrupt zip)');
  const start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
  if (start + entry.compressedSize > b.length) throw new Error('entry data runs past the end of the file (truncated zip)');
  const comp = b.subarray(start, start + entry.compressedSize);
  let data;
  if (entry.methodId === 0) { if (comp.length > budget) throw new LimitError(`decompressed size exceeds the limit`); data = comp.slice(); } else if (entry.methodId === 8) data = await guardedInflate(comp, budget, 'inflate');
  else throw new Error(`compression method "${entry.method}" is not supported (only store and deflate)`);
  if (crc32(data) !== entry.crc) throw new Error('CRC-32 mismatch (corrupt entry)');
  return data;
}

// ─────────────────────────────────────────────────────────────── tar ──
const tstr = (b, o, n) => { let e = o; while (e < o + n && b[e]) e++; return decName(b.subarray(o, e), true); };
const toct = (b, o, n) => { if (b[o] & 0x80) { let v = 0; for (let i = o + 1; i < o + n; i++) v = v * 256 + b[i]; return v; } const s = tstr(b, o, n).replace(/[^0-7]/g, ''); return s ? parseInt(s, 8) : 0; };
export function isTar(b) {
  if (b.length < 512) return false;
  let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[i];
  return sum > 256 && toct(b, 148, 8) === sum;
}
/** tarEntries(bytes) → [{name, dir, size, type, modified, mode, linkname, dataOffset}] (ustar, GNU long names, pax path/size) */
export function tarEntries(b) {
  const out = []; let p = 0; let longName = null; let longLink = null; let pax = {};
  while (p + 512 <= b.length) {
    let zero = true; for (let i = p; i < p + 512; i++) if (b[i]) { zero = false; break; }
    if (zero) break;
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[p + i];
    if (toct(b, p + 148, 8) !== sum) { if (!out.length) throw new Error('tar: bad header checksum — not a tar archive'); throw new Error(`tar: corrupt header at offset ${p}`); }
    let size = toct(b, p + 124, 12); const type = String.fromCharCode(b[p + 156] || 48);
    const data = p + 512; const next = data + Math.ceil(size / 512) * 512;
    if (type === 'L' || type === 'K') { const s = tstr(b, data, Math.min(size, b.length - data)); if (type === 'L') longName = s; else longLink = s; p = next; continue; }
    if (type === 'x' || type === 'g') {
      const end = Math.min(b.length, data + size); let q = data; const rec = {};
      while (q < end) { // records are "<len> <key>=<value>\n", len counting the whole record in bytes
        let sp = q; while (sp < end && b[sp] !== 32) sp++;
        const len = parseInt(tstr(b, q, sp - q), 10); if (!(len > 0) || q + len > end) break;
        const body = new TextDecoder().decode(b.subarray(sp + 1, q + len - 1)); const eqi = body.indexOf('=');
        if (eqi > 0) rec[body.slice(0, eqi)] = body.slice(eqi + 1);
        q += len;
      }
      if (type === 'x') pax = rec; p = next; continue;
    }
    let name = tstr(b, p, 100); const ustar = tstr(b, p + 257, 5) === 'ustar';
    if (ustar) { const prefix = tstr(b, p + 345, 155); if (prefix) name = `${prefix}/${name}`; }
    if (longName !== null) name = longName; if (pax.path) name = pax.path;
    if (pax.size) size = Number(pax.size);
    let linkname = tstr(b, p + 157, 100); if (longLink !== null) linkname = longLink; if (pax.linkpath) linkname = pax.linkpath;
    const mt = pax.mtime ? Number(pax.mtime) : toct(b, p + 136, 12);
    const kind = type === '0' || type === '7' ? 'file' : type === '5' ? 'dir' : type === '2' ? 'symlink' : type === '1' ? 'hardlink' : `type-${type}`;
    out.push({ name, dir: kind === 'dir' || (kind === 'file' && name.endsWith('/')), size: kind === 'file' ? size : 0, type: kind, modified: mt ? new Date(mt * 1000).toISOString().slice(0, 19) : null, mode: toct(b, p + 100, 8) & 0o7777, linkname: linkname || undefined, dataOffset: data });
    longName = longLink = null; pax = {};
    p = data + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** tarCreate([{name, data: Uint8Array, mtime?: seconds}]) → Uint8Array (ustar; pax headers for names that do not fit) */
export function tarCreate(files) {
  const enc = new TextEncoder(); const parts = []; let total = 0;
  const header = (nameBytes, prefixBytes, size, type, mtime) => {
    const h = new Uint8Array(512); h.set(nameBytes.subarray(0, 100), 0);
    const oct = (v, n, o) => h.set(enc.encode(v.toString(8).padStart(n - 1, '0')), o);
    oct(type === '5' ? 0o755 : 0o644, 8, 100); oct(0, 8, 108); oct(0, 8, 116); oct(size, 12, 124); oct(mtime, 12, 136);
    h[156] = type.charCodeAt(0); h.set(enc.encode('ustar\0' + '00'), 257);
    if (prefixBytes) h.set(prefixBytes.subarray(0, 155), 345);
    for (let i = 148; i < 156; i++) h[i] = 32;
    let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
    h.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    return h;
  };
  const push = (u8) => { parts.push(u8); total += u8.length; const pad = (512 - (u8.length % 512)) % 512; if (pad) { parts.push(new Uint8Array(pad)); total += pad; } };
  for (const f of files) {
    const nb = enc.encode(f.name); const mtime = Math.floor(f.mtime ?? Date.now() / 1000);
    let name = nb; let prefix = null;
    if (nb.length > 100) {
      let split = -1;
      for (let i = Math.min(nb.length - 1, 155); i > 0; i--) if (nb[i] === 47 && nb.length - i - 1 <= 100 && i <= 155) { split = i; break; }
      if (split > 0) { prefix = nb.subarray(0, split); name = nb.subarray(split + 1); } else {
        let rec = ` path=${f.name}\n`; let len = enc.encode(rec).length; let L = len + String(len).length; if (String(L).length !== String(len).length) L = len + String(L).length; rec = `${L}${rec}`;
        const body = enc.encode(rec);
        push(header(enc.encode('PaxHeader/' + f.name.split('/').pop()).subarray(0, 100), null, body.length, 'x', mtime)); push(body);
        name = nb.subarray(nb.length - 100);
      }
    }
    push(header(name, prefix, f.data.length, '0', mtime)); if (f.data.length) push(f.data);
  }
  parts.push(new Uint8Array(1024)); total += 1024;
  const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
