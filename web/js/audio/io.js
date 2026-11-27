// μεταμόρφωσις :: audio/io — container sniffing + tag reading from header bytes, WAV/AIFF PCM decode, WAV encode,
// and the browser decoder (decodeAudioData on an OfflineAudioContext) for everything else.

const ascii = (b, o, n) => { let s = ''; for (let i = o; i < o + n && i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const clean = (s) => String(s).replace(/\0+$/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 300);
const MAX_TAGS = 40;
function putTag(tags, k, v) { v = clean(v); if (!v || k in tags || Object.keys(tags).length >= MAX_TAGS) return; tags[k] = v; }
const utf8 = (b) => new TextDecoder('utf-8').decode(b);
const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };

// ───────────────────────────────────────────────────────────── wav ──
const WAV_CODECS = { 1: 'pcm', 2: 'adpcm_ms', 3: 'pcm_float', 6: 'alaw', 7: 'mulaw', 17: 'adpcm_ima', 85: 'mp3', 0xFFFE: 'extensible' };
/** Parse RIFF/WAVE chunks. Returns {tag, channels, sampleRate, bits, blockAlign, byteRate, dataOffset, dataSize, tags} or null. */
export function wavHeader(b) {
  if (b.length < 12) return null;
  const riff = ascii(b, 0, 4);
  if ((riff !== 'RIFF' && riff !== 'RF64') || ascii(b, 8, 4) !== 'WAVE') return null;
  const dv = view(b); let o = 12; const h = { tags: {} };
  while (o + 8 <= b.length) {
    const id = ascii(b, o, 4); let size = dv.getUint32(o + 4, true); const body = o + 8;
    if (id === 'fmt ' && size >= 16) {
      h.tag = dv.getUint16(body, true); h.channels = dv.getUint16(body + 2, true); h.sampleRate = dv.getUint32(body + 4, true);
      h.byteRate = dv.getUint32(body + 8, true); h.blockAlign = dv.getUint16(body + 12, true); h.bits = dv.getUint16(body + 14, true);
      if (h.tag === 0xFFFE && size >= 26) { h.extensible = true; h.tag = dv.getUint16(body + 24, true); }
    } else if (id === 'data') {
      if (size === 0xFFFFFFFF || size === 0 || body + size > b.length) { h.truncated = size !== 0 && size !== 0xFFFFFFFF && body + size > b.length; size = b.length - body; }
      h.dataOffset = body; h.dataSize = size;
    } else if (id === 'LIST' && ascii(b, body, 4) === 'INFO') {
      const map = { INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'date', ICMT: 'comment', IGNR: 'genre', ISFT: 'encoder', ITRK: 'track', ICOP: 'copyright' };
      let p = body + 4; const end = Math.min(b.length, body + size);
      while (p + 8 <= end) { const k = ascii(b, p, 4), n = dv.getUint32(p + 4, true); if (map[k]) putTag(h.tags, map[k], utf8(b.subarray(p + 8, Math.min(end, p + 8 + n)))); p += 8 + n + (n & 1); }
    }
    o = body + size + (size & 1);
  }
  return h.sampleRate ? h : null;
}
/** Decode linear PCM / IEEE float WAV → {sampleRate, channels: Float32Array[], bitDepth} or null when the codec is not plain PCM. */
export function decodeWav(b, h = wavHeader(b)) {
  if (!h || h.dataOffset === undefined || !h.channels || !h.blockAlign) return null;
  const bps = h.blockAlign / h.channels; // bytes per sample
  const isInt = h.tag === 1 && [1, 2, 3, 4].includes(bps), isFloat = h.tag === 3 && (bps === 4 || bps === 8);
  if (!isInt && !isFloat) return null;
  const frames = Math.floor(h.dataSize / h.blockAlign), nch = h.channels, dv = view(b);
  const out = Array.from({ length: nch }, () => new Float32Array(frames));
  let o = h.dataOffset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, o += bps) {
      let v;
      if (isFloat) v = bps === 4 ? dv.getFloat32(o, true) : dv.getFloat64(o, true);
      else if (bps === 2) v = dv.getInt16(o, true) / 32768;
      else if (bps === 3) v = ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8 >> 8) / 8388608;
      else if (bps === 4) v = dv.getInt32(o, true) / 2147483648;
      else v = (b[o] - 128) / 128;
      out[c][i] = v;
    }
  }
  return { sampleRate: h.sampleRate, channels: out, bitDepth: isFloat ? (bps === 4 ? 32 : 64) : bps * 8, float: isFloat };
}

/**
 * Encode WAV. bitDepth 16 | 24 (integer PCM) | 32 (IEEE float). Integer formats clip at ±1.0 and count the clipped samples.
 * More than two channels are written as WAVE_FORMAT_EXTENSIBLE.
 */
export function encodeWav(chs, sampleRate, bitDepth = 16) {
  if (![16, 24, 32].includes(bitDepth)) throw new Error(`bitDepth must be 16, 24 or 32 (float) — got ${bitDepth}`);
  const nch = chs.length, n = chs[0].length, bps = bitDepth / 8, float = bitDepth === 32, ext = nch > 2;
  const fmtSize = ext ? 40 : 16, dataSize = n * nch * bps, factSize = float ? 12 : 0;
  const total = 12 + 8 + fmtSize + factSize + 8 + dataSize + (dataSize & 1);
  if (total > 0xFFFFFFFF) throw new Error('WAV output would exceed 4 GiB');
  const bytes = new Uint8Array(total), dv = view(bytes);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); dv.setUint32(4, total - 8, true); put(8, 'WAVE'); put(12, 'fmt '); dv.setUint32(16, fmtSize, true);
  dv.setUint16(20, ext ? 0xFFFE : float ? 3 : 1, true); dv.setUint16(22, nch, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nch * bps, true); dv.setUint16(32, nch * bps, true); dv.setUint16(34, bitDepth, true);
  let o = 36;
  if (ext) {
    dv.setUint16(36, 22, true); dv.setUint16(38, bitDepth, true); dv.setUint32(40, nch === 6 ? 0x3F : 0, true);
    const guid = [float ? 3 : 1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71]; bytes.set(guid, 44); o = 60;
  }
  if (float) { put(o, 'fact'); dv.setUint32(o + 4, 4, true); dv.setUint32(o + 8, n, true); o += 12; }
  put(o, 'data'); dv.setUint32(o + 4, dataSize, true); o += 8;
  let clipped = 0;
  if (float) {
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++, o += 4) dv.setFloat32(o, chs[c][i], true);
  } else if (bitDepth === 16) {
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++, o += 2) {
      let v = Math.round(chs[c][i] * 32768);
      if (v > 32767) { if (v > 32768) clipped++; v = 32767; } else if (v < -32768) { clipped++; v = -32768; }
      dv.setInt16(o, v, true);
    }
  } else {
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++, o += 3) {
      let v = Math.round(chs[c][i] * 8388608);
      if (v > 8388607) { if (v > 8388608) clipped++; v = 8388607; } else if (v < -8388608) { clipped++; v = -8388608; }
      bytes[o] = v & 255; bytes[o + 1] = (v >> 8) & 255; bytes[o + 2] = (v >> 16) & 255;
    }
  }
  return { bytes, clipped };
}

// ──────────────────────────────────────────────────────────── aiff ──
function ext80(dv, o) { const e = ((dv.getUint8(o) & 0x7f) << 8) | dv.getUint8(o + 1); const hi = dv.getUint32(o + 2), lo = dv.getUint32(o + 6); return (hi * 4294967296 + lo) * 2 ** (e - 16383 - 63); }
export function aiffHeader(b) {
  if (b.length < 12 || ascii(b, 0, 4) !== 'FORM' || !['AIFF', 'AIFC'].includes(ascii(b, 8, 4))) return null;
  const dv = view(b); const h = { aifc: ascii(b, 8, 4) === 'AIFC', compression: 'NONE', tags: {} }; let o = 12;
  while (o + 8 <= b.length) {
    const id = ascii(b, o, 4), size = dv.getUint32(o + 4), body = o + 8;
    if (id === 'COMM' && size >= 18) { h.channels = dv.getUint16(body); h.frames = dv.getUint32(body + 2); h.bits = dv.getUint16(body + 6); h.sampleRate = ext80(dv, body + 8); if (h.aifc && size >= 22) h.compression = ascii(b, body + 18, 4); }
    else if (id === 'SSND') { const off = dv.getUint32(body); h.dataOffset = body + 8 + off; h.dataSize = Math.min(size - 8 - off, b.length - h.dataOffset); }
    else if (id === 'NAME') putTag(h.tags, 'title', latin1(b.subarray(body, body + size)));
    else if (id === 'AUTH') putTag(h.tags, 'artist', latin1(b.subarray(body, body + size)));
    o = body + size + (size & 1);
  }
  return h.sampleRate ? h : null;
}
export function decodeAiff(b, h = aiffHeader(b)) {
  if (!h || h.dataOffset === undefined || !h.channels) return null;
  const comp = h.compression, le = comp === 'sowt', float = comp === 'fl32' || comp === 'FL32';
  if (!['NONE', 'twos', 'sowt', 'fl32', 'FL32'].includes(comp)) return null;
  const bps = Math.ceil(h.bits / 8); if (![1, 2, 3, 4].includes(bps)) return null;
  const nch = h.channels, frames = Math.min(h.frames, Math.floor(h.dataSize / (bps * nch))), dv = view(b);
  const out = Array.from({ length: nch }, () => new Float32Array(frames)); let o = h.dataOffset;
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++, o += bps) {
    let v;
    if (float) v = dv.getFloat32(o, false);
    else if (bps === 1) v = dv.getInt8(o) / 128;
    else if (bps === 2) v = dv.getInt16(o, le) / 32768;
    else if (bps === 3) v = (le ? ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8 >> 8) : ((b[o + 2] | (b[o + 1] << 8) | (b[o] << 16)) << 8 >> 8)) / 8388608;
    else v = dv.getInt32(o, le) / 2147483648;
    out[c][i] = v;
  }
  return { sampleRate: Math.round(h.sampleRate), channels: out, bitDepth: h.bits, float };
}

// ───────────────────────────────────────────────────────────── id3 ──
const ID3_MAP = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TDRC: 'date', TYER: 'date', TRCK: 'track', TCON: 'genre', TPE2: 'albumArtist', TCOM: 'composer', TBPM: 'bpm', TSSE: 'encoder', TENC: 'encodedBy', TPOS: 'disc', TKEY: 'key', TCOP: 'copyright',
  TT2: 'title', TP1: 'artist', TAL: 'album', TYE: 'date', TRK: 'track', TCO: 'genre', TCM: 'composer' };
function id3Text(b) {
  if (!b.length) return '';
  const enc = b[0], body = b.subarray(1);
  try {
    if (enc === 1) return new TextDecoder('utf-16').decode(body);
    if (enc === 2) return new TextDecoder('utf-16be').decode(body);
    if (enc === 3) return utf8(body);
  } catch { /* fall through */ }
  return latin1(body);
}
/** Parse an ID3v2 tag at offset 0. Returns {size (bytes to skip), version, tags, pictures}. */
function id3v2(b) {
  if (b.length < 10 || ascii(b, 0, 3) !== 'ID3') return null;
  const ver = b[3], flags = b[5];
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const total = 10 + size + (flags & 0x10 ? 10 : 0), tags = {}; let pictures = 0;
  let o = 10; const end = Math.min(b.length, 10 + size);
  if (flags & 0x40 && ver >= 3) { const es = ver === 4 ? (((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f)) : view(b).getUint32(o) + 4; o += es; }
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  while (o + hdr <= end) {
    const id = ascii(b, o, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let fs;
    if (ver === 2) fs = (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5];
    else if (ver === 4) fs = ((b[o + 4] & 0x7f) << 21) | ((b[o + 5] & 0x7f) << 14) | ((b[o + 6] & 0x7f) << 7) | (b[o + 7] & 0x7f);
    else fs = view(b).getUint32(o + 4);
    const body = b.subarray(o + hdr, Math.min(end, o + hdr + fs));
    if (id === 'APIC' || id === 'PIC') pictures++;
    else if (id === 'COMM' || id === 'COM') { const t = id3Text(body.length > 4 ? Uint8Array.from([body[0], ...body.subarray(4)]) : body); putTag(tags, 'comment', t.split('\0').filter(Boolean).pop() || ''); }
    else if (id === 'TXXX' || id === 'TXX') { const [k, v] = id3Text(body).split('\0'); if (k && v) putTag(tags, clean(k).slice(0, 40), v); }
    else if (ID3_MAP[id]) putTag(tags, ID3_MAP[id], id3Text(body).split('\0')[0]);
    else if (id[0] === 'T' && body.length < 400) putTag(tags, id, id3Text(body).split('\0')[0]);
    o += hdr + fs;
    if (fs <= 0) break;
  }
  return { size: total, version: `2.${ver}`, tags, pictures };
}
const ID3V1_GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise'];
function id3v1(b) {
  if (b.length < 128 || ascii(b, b.length - 128, 3) !== 'TAG') return null;
  const t = b.subarray(b.length - 128), tags = {}; const s = (o, n) => latin1(t.subarray(o, o + n));
  putTag(tags, 'title', s(3, 30)); putTag(tags, 'artist', s(33, 30)); putTag(tags, 'album', s(63, 30)); putTag(tags, 'date', s(93, 4));
  if (t[125] === 0 && t[126]) { putTag(tags, 'comment', s(97, 28)); putTag(tags, 'track', String(t[126])); } else putTag(tags, 'comment', s(97, 30));
  if (ID3V1_GENRES[t[127]]) putTag(tags, 'genre', ID3V1_GENRES[t[127]]);
  return tags;
}

// ───────────────────────────────────────────────────────────── mp3 ──
const MP3_BR = { // kbps by [version-layer key][index]
  11: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 12: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  13: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 21: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  22: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3Frame(b, o) {
  if (o + 4 > b.length || b[o] !== 0xFF || (b[o + 1] & 0xE0) !== 0xE0) return null;
  const ver = (b[o + 1] >> 3) & 3, layerBits = (b[o + 1] >> 1) & 3, bri = b[o + 2] >> 4, sri = (b[o + 2] >> 2) & 3, pad = (b[o + 2] >> 1) & 1, mode = b[o + 3] >> 6;
  if (ver === 1 || layerBits === 0 || bri === 0 || bri === 15 || sri === 3) return null;
  const layer = 4 - layerBits, v1 = ver === 3;
  const kbps = MP3_BR[v1 ? 10 + layer : layer === 1 ? 21 : 22][bri], sr = MP3_SR[ver][sri];
  const spf = layer === 1 ? 384 : layer === 2 ? 1152 : v1 ? 1152 : 576;
  const size = layer === 1 ? (Math.floor(12 * kbps * 1000 / sr) + pad) * 4 : Math.floor(spf / 8 * kbps * 1000 / sr) + pad;
  return { version: v1 ? 1 : ver === 2 ? 2 : 2.5, layer, kbps, sampleRate: sr, channels: mode === 3 ? 1 : 2, spf, size, side: v1 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17) };
}
function sniffMp3(b, start, info) {
  let o = start, f = null; const lim = Math.min(b.length - 4, start + 131072);
  for (; o < lim; o++) {
    f = mp3Frame(b, o);
    if (f) { const nx = mp3Frame(b, o + f.size); if (nx && nx.sampleRate === f.sampleRate && nx.layer === f.layer) break; if (o + f.size >= b.length - 4) break; f = null; }
  }
  if (!f) return false;
  info.container = 'mp3'; info.codec = `mp${f.layer}`; info.codecDetail = `MPEG-${f.version} Layer ${'I'.repeat(f.layer)}`;
  info.sampleRate = f.sampleRate; info.channels = f.channels;
  const dv = view(b), x = o + 4 + f.side, tagBytes = ascii(b, b.length - 128, 3) === 'TAG' ? 128 : 0, audioBytes = b.length - o - tagBytes;
  const xing = ascii(b, x, 4), vbri = ascii(b, o + 36, 4);
  let frames = 0;
  if ((xing === 'Xing' || xing === 'Info') && x + 12 <= b.length) { if (dv.getUint32(x + 4) & 1) frames = dv.getUint32(x + 8); info.vbr = xing === 'Xing'; }
  else if (vbri === 'VBRI' && o + 54 <= b.length) { frames = dv.getUint32(o + 50); info.vbr = true; }
  if (frames) { info.duration = frames * f.spf / f.sampleRate; info.durationSource = 'vbr header'; info.nominalBitrate = Math.round(audioBytes * 8 / info.duration); }
  else { info.duration = audioBytes * 8 / (f.kbps * 1000); info.durationSource = 'first-frame bitrate (exact only for CBR)'; info.nominalBitrate = f.kbps * 1000; }
  return true;
}

// ────────────────────────────────────────────────────── flac / ogg ──
function vorbisComments(b, o, tags, le = true) {
  const dv = view(b);
  try {
    const vl = dv.getUint32(o, le); if (vl > 4096) return; putTag(tags, 'encoder', utf8(b.subarray(o + 4, o + 4 + vl))); o += 4 + vl;
    const n = dv.getUint32(o, le); o += 4;
    for (let i = 0; i < n && i < 200 && o + 4 <= b.length; i++) {
      const l = dv.getUint32(o, le); o += 4; if (o + l > b.length) return;
      if (l < 2048) { const s = utf8(b.subarray(o, o + l)), eq = s.indexOf('='); if (eq > 0) { const k = s.slice(0, eq).toLowerCase(); if (k !== 'metadata_block_picture') putTag(tags, { tracknumber: 'track', albumartist: 'albumArtist' }[k] || k, s.slice(eq + 1)); } }
      o += l;
    }
  } catch { /* partial comments are fine */ }
}
function flacStreamInfo(b, o, info) {
  const sr = (b[o + 10] << 12) | (b[o + 11] << 4) | (b[o + 12] >> 4);
  info.sampleRate = sr; info.channels = ((b[o + 12] >> 1) & 7) + 1; info.bitDepth = (((b[o + 12] & 1) << 4) | (b[o + 13] >> 4)) + 1;
  const total = (b[o + 13] & 0x0f) * 4294967296 + view(b).getUint32(o + 14);
  if (total && sr) { info.duration = total / sr; info.durationSource = 'STREAMINFO'; }
}
function sniffFlac(b, start, info) {
  info.container = 'flac'; info.codec = 'flac'; let o = start + 4;
  while (o + 4 <= b.length) {
    const last = b[o] & 0x80, type = b[o] & 0x7f, len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    if (type === 0 && o + 4 + 18 <= b.length) flacStreamInfo(b, o + 4, info);
    else if (type === 4) vorbisComments(b, o + 4, info.tags);
    else if (type === 6) info.pictures = (info.pictures || 0) + 1;
    o += 4 + len; if (last) break;
  }
}
function indexOf(b, pat, from, to) {
  const p = [...pat].map((c) => c.charCodeAt(0)); const end = Math.min(b.length, to) - p.length;
  outer: for (let i = from; i <= end; i++) { for (let j = 0; j < p.length; j++) if (b[i + j] !== p[j]) continue outer; return i; }
  return -1;
}
function sniffOgg(b, info) {
  info.container = 'ogg';
  const nseg = b[26], p = 27 + nseg, dv = view(b); let rate = 0, preskip = 0;
  if (ascii(b, p + 1, 6) === 'vorbis' && b[p] === 1) { info.codec = 'vorbis'; info.channels = b[p + 11]; rate = info.sampleRate = dv.getUint32(p + 12, true); const nom = dv.getInt32(p + 20, true); if (nom > 0) info.nominalBitrate = nom; }
  else if (ascii(b, p, 8) === 'OpusHead') { info.codec = 'opus'; info.channels = b[p + 9]; preskip = dv.getUint16(p + 10, true); info.inputSampleRate = dv.getUint32(p + 12, true); rate = info.sampleRate = 48000; }
  else if (b[p] === 0x7f && ascii(b, p + 1, 4) === 'FLAC') { info.codec = 'flac'; flacStreamInfo(b, p + 13, info); rate = 0; }
  else if (ascii(b, p, 8) === 'Speex   ') { info.codec = 'speex'; rate = info.sampleRate = dv.getUint32(p + 36, true); info.channels = dv.getUint32(p + 48, true); }
  else if (ascii(b, p + 1, 6) === 'theora') { info.codec = 'theora (video)'; }
  const head = Math.min(b.length, 262144);
  const c = info.codec === 'vorbis' ? indexOf(b, '\x03vorbis', p, head) : info.codec === 'opus' ? indexOf(b, 'OpusTags', p, head) : -1;
  if (c >= 0) vorbisComments(b, c + (info.codec === 'vorbis' ? 7 : 8), info.tags);
  if (rate) { // last page granule position = total samples
    const from = Math.max(0, b.length - 131072); let last = -1;
    for (let i = b.length - 27; i >= from; i--) if (b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53) { last = i; break; }
    if (last >= 0) { const g = dv.getUint32(last + 6, true) + dv.getUint32(last + 10, true) * 4294967296; if (g > 0 && dv.getUint32(last + 10, true) < 0x100000) { info.duration = Math.max(0, g - preskip) / rate; info.durationSource = 'last Ogg page granule'; } }
  }
}

// ───────────────────────────────────────────────────────────── mp4 ──
function* boxes(b, start, end) {
  const dv = view(b); let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o), hdr = 8; const type = ascii(b, o + 4, 4);
    if (size === 1) { if (o + 16 > end) return; size = dv.getUint32(o + 8) * 4294967296 + dv.getUint32(o + 12); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end + 8) return;
    yield { type, start: o + hdr, end: Math.min(end, o + size) };
    o += size;
  }
}
const find = (b, box, type) => { for (const x of boxes(b, box.start, box.end)) if (x.type === type) return x; return null; };
const MP4_CODECS = { mp4a: 'aac', alac: 'alac', Opus: 'opus', fLaC: 'flac', 'ac-3': 'ac3', 'ec-3': 'eac3', samr: 'amr', sawb: 'amr-wb', sowt: 'pcm', twos: 'pcm', lpcm: 'pcm', '.mp3': 'mp3' };
function sniffMp4(b, info) {
  const dv = view(b); info.container = 'mp4'; info.brand = clean(ascii(b, 8, 4));
  if (/^M4A|^M4B/.test(info.brand)) info.container = 'm4a'; if (/^qt/.test(info.brand)) info.container = 'mov'; if (/^3g/.test(info.brand)) info.container = '3gp';
  const top = { start: 0, end: b.length }, moov = find(b, top, 'moov');
  if (!moov) { info.notes.push('no moov box found (fragmented or truncated MP4)'); return; }
  const durOf = (box) => { const v = b[box.start]; return v === 1 ? { ts: dv.getUint32(box.start + 20), d: dv.getUint32(box.start + 24) * 4294967296 + dv.getUint32(box.start + 28) } : { ts: dv.getUint32(box.start + 12), d: dv.getUint32(box.start + 16) }; };
  const mvhd = find(b, moov, 'mvhd');
  if (mvhd) { const { ts, d } = durOf(mvhd); if (ts && d) { info.duration = d / ts; info.durationSource = 'mvhd'; } }
  for (const trak of boxes(b, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = find(b, trak, 'mdia'); if (!mdia) continue;
    const hdlr = find(b, mdia, 'hdlr'), handler = hdlr ? ascii(b, hdlr.start + 8, 4) : '';
    if (handler === 'vide') { info.hasVideo = true; continue; }
    if (handler !== 'soun' || info.codec) continue;
    const mdhd = find(b, mdia, 'mdhd'); if (mdhd) { const { ts, d } = durOf(mdhd); if (ts && d) { info.duration = d / ts; info.durationSource = 'mdhd (audio track)'; } }
    const minf = find(b, mdia, 'minf'), stbl = minf && find(b, minf, 'stbl'), stsd = stbl && find(b, stbl, 'stsd');
    if (!stsd) continue;
    const e = stsd.start + 8, fourcc = ascii(b, e + 4, 4);
    info.codec = MP4_CODECS[fourcc] || clean(fourcc); info.channels = dv.getUint16(e + 24); info.bitDepth = undefined;
    info.sampleRate = dv.getUint16(e + 32) || dv.getUint32(e + 32) >>> 16;
    const es = indexOf(b, 'esds', e + 36, Math.min(stsd.end, e + 36 + 256));
    if (es >= 0) { // ES_Descriptor → DecoderConfigDescriptor: objectTypeIndication, avgBitrate
      let q = es + 8; const tagLen = () => { q++; let l = 0, c; do { c = b[q++]; l = (l << 7) | (c & 0x7f); } while (c & 0x80); return l; };
      if (b[q] === 3) { tagLen(); q += 3; if (b[q] === 4) { tagLen(); const oti = b[q]; if (oti === 0x6B || oti === 0x69) info.codec = 'mp3'; const avg = dv.getUint32(q + 9); if (avg) info.nominalBitrate = avg; } }
    }
  }
  const udta = find(b, moov, 'udta'), meta = udta && find(b, udta, 'meta');
  const ilst = meta && find(b, { start: meta.start + 4, end: meta.end }, 'ilst');
  if (ilst) {
    const map = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', '©day': 'date', '©gen': 'genre', '©too': 'encoder', '©cmt': 'comment', aART: 'albumArtist', '©wrt': 'composer' };
    for (const it of boxes(b, ilst.start, ilst.end)) {
      const data = find(b, it, 'data'); if (!data) continue;
      const key = ascii(b, it.start - 4, 4);
      if (it.type === 'trkn' || key === 'trkn') putTag(info.tags, 'track', String(dv.getUint16(data.start + 10)));
      else if (it.type === 'covr') info.pictures = (info.pictures || 0) + 1;
      else if (map[it.type] && dv.getUint32(data.start) === 1) putTag(info.tags, map[it.type], utf8(b.subarray(data.start + 8, data.end)));
    }
  }
}

// ──────────────────────────────────────────────────── webm / mkv ──
function sniffEbml(b, info) {
  const dv = view(b);
  const vint = (o, keepMarker) => { const first = b[o]; if (first === undefined || first === 0) return null; let len = 1; while (!(first & (0x80 >> (len - 1)))) len++; let v = keepMarker ? first : first & (0xff >> len); let ones = (first & (0xff >> len)) === (0xff >> len); for (let i = 1; i < len; i++) { v = v * 256 + b[o + i]; if (b[o + i] !== 0xff) ones = false; } return { v, len, unknown: !keepMarker && ones }; };
  const uint = (o, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; };
  const flt = (o, n) => (n === 4 ? dv.getFloat32(o) : n === 8 ? dv.getFloat64(o) : 0);
  let scale = 1e6, dur = 0; const limit = Math.min(b.length, 4 * 1048576);
  const walk = (start, end, depth) => {
    let o = start;
    while (o < end && o < limit) {
      const id = vint(o, true); if (!id) return; const sz = vint(o + id.len, false); if (!sz) return;
      const body = o + id.len + sz.len, size = sz.unknown ? end - body : sz.v, bend = Math.min(end, body + size);
      switch (id.v) {
        case 0x1A45DFA3: case 0x18538067: case 0x1549A966: case 0x1654AE6B: walk(body, bend, depth + 1); break;
        case 0x4282: info.container = { webm: 'webm', matroska: 'matroska' }[clean(ascii(b, body, size))] || 'matroska'; break;
        case 0x2AD7B1: scale = uint(body, size); break;
        case 0x4489: dur = flt(body, size); break;
        case 0xAE: { const t = {}; const tw = (s, e) => { let p = s; while (p < e) { const i2 = vint(p, true); if (!i2) return; const s2 = vint(p + i2.len, false); if (!s2) return; const bd = p + i2.len + s2.len;
          if (i2.v === 0x83) t.type = uint(bd, s2.v); else if (i2.v === 0x86) t.codec = clean(ascii(b, bd, s2.v)); else if (i2.v === 0xE1) tw(bd, bd + s2.v); else if (i2.v === 0xB5) t.sr = flt(bd, s2.v); else if (i2.v === 0x9F) t.ch = uint(bd, s2.v); else if (i2.v === 0x6264) t.bits = uint(bd, s2.v);
          p = bd + s2.v; } };
          tw(body, bend);
          if (t.type === 1) info.hasVideo = true;
          if (t.type === 2 && !info.codec) { info.codec = (t.codec || '').replace(/^A_/, '').toLowerCase().replace(/^aac.*/, 'aac').replace(/^pcm.*/, 'pcm').replace('mpeg/l3', 'mp3'); info.sampleRate = Math.round(t.sr || 8000); info.channels = t.ch || 1; if (t.bits) info.bitDepth = t.bits; }
          break; }
        case 0x1F43B675: return; // first Cluster: headers are over
        default: break;
      }
      o = body + size;
    }
  };
  info.container = 'matroska';
  walk(0, b.length, 0);
  if (dur) { info.duration = dur * scale / 1e9; info.durationSource = 'Segment Info'; }
}

// ─────────────────────────────────────────────────────────── sniff ──
/** Identify container/codec and read what the header gives for free. Never throws; unknown → container:'unknown'. */
export function sniff(b) {
  const info = { container: 'unknown', codec: null, tags: {}, notes: [] };
  try {
    const m4 = ascii(b, 0, 4);
    if ((m4 === 'RIFF' || m4 === 'RF64') && ascii(b, 8, 4) === 'WAVE') {
      const h = wavHeader(b); info.container = 'wav';
      if (h) {
        info.codec = WAV_CODECS[h.tag] || `wav-format-0x${h.tag.toString(16)}`; info.sampleRate = h.sampleRate; info.channels = h.channels; info.bitDepth = h.bits;
        if (h.dataSize !== undefined && h.blockAlign && (h.tag === 1 || h.tag === 3)) { info.duration = Math.floor(h.dataSize / h.blockAlign) / h.sampleRate; info.durationSource = 'data chunk'; }
        else if (h.dataSize !== undefined && h.byteRate) { info.duration = h.dataSize / h.byteRate; info.durationSource = 'byte rate'; }
        if (h.byteRate) info.nominalBitrate = h.byteRate * 8;
        if (h.truncated) info.notes.push('data chunk is shorter than its header claims (truncated file)');
        Object.assign(info.tags, h.tags);
      }
    } else if (m4 === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(b, 8, 4))) {
      const h = aiffHeader(b); info.container = 'aiff';
      if (h) { info.codec = ['NONE', 'twos', 'sowt'].includes(h.compression) ? 'pcm' : ['fl32', 'FL32'].includes(h.compression) ? 'pcm_float' : clean(h.compression); info.sampleRate = Math.round(h.sampleRate); info.channels = h.channels; info.bitDepth = h.bits; info.duration = h.frames / h.sampleRate; info.durationSource = 'COMM chunk'; Object.assign(info.tags, h.tags); }
    } else if (m4 === 'fLaC') sniffFlac(b, 0, info);
    else if (m4 === 'OggS') sniffOgg(b, info);
    else if (ascii(b, 4, 4) === 'ftyp') sniffMp4(b, info);
    else if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) sniffEbml(b, info);
    else if (m4 === 'MThd') { info.container = 'midi'; info.notes.push('MIDI is a score, not audio; it cannot be decoded here'); }
    else if (m4 === '#!AM') { info.container = 'amr'; info.codec = 'amr'; }
    else if (m4 === 'caff') { info.container = 'caf'; }
    else {
      let start = 0; const v2 = id3v2(b);
      if (v2) { start = v2.size; info.id3 = v2.version; Object.assign(info.tags, v2.tags); if (v2.pictures) info.pictures = v2.pictures; }
      if (ascii(b, start, 4) === 'fLaC') sniffFlac(b, start, info);
      else if (b[start] === 0xFF && (b[start + 1] & 0xF6) === 0xF0) { // ADTS AAC
        info.container = 'adts'; info.codec = 'aac';
        const sri = (b[start + 2] >> 2) & 15; info.sampleRate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][sri];
        info.channels = ((b[start + 2] & 1) << 2) | (b[start + 3] >> 6);
      } else if (!sniffMp3(b, start, info) && v2) { info.container = 'id3 (unknown payload)'; }
      const v1 = id3v1(b); if (v1 && info.container === 'mp3') { for (const [k, v] of Object.entries(v1)) putTag(info.tags, k, v); info.id3 = info.id3 ? `${info.id3}+1` : '1'; }
    }
  } catch (e) { info.notes.push(`header parse stopped early: ${e.message}`); }
  if (!info.notes.length) delete info.notes;
  return info;
}

// ────────────────────────────────────────────────── browser decode ──
/** Decode any browser-supported audio (mp3, aac/m4a, ogg vorbis/opus, flac, webm, and the audio track of mp4/webm video). */
export async function browserDecode(bytes, sampleRate) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('this browser has no OfflineAudioContext; only WAV/AIFF PCM can be decoded here');
  const sr = sampleRate >= 3000 && sampleRate <= 384000 ? sampleRate : 48000;
  let ctx;
  try { ctx = new Ctx(1, 1, sr); } catch { ctx = new Ctx(1, 1, 48000); }
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); // decodeAudioData detaches its argument
  const ab = await ctx.decodeAudioData(copy);
  const channels = []; for (let c = 0; c < ab.numberOfChannels; c++) channels.push(ab.getChannelData(c));
  return { sampleRate: ab.sampleRate, channels, bitDepth: null, float: true };
}
