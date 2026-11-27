// video.* — media containers: probe, convert, compress, trim, concat, speed, frames, contact sheets, GIF, audio transcoding.
// Two backends behind one set of tools:
//   webcodecs — Mediabunny (demux/mux) + the browser's WebCodecs encoders/decoders (GPU/hardware where the browser has them)
//   ffmpeg    — ffmpeg.wasm, single-thread CPU build (~31 MB, fetched only when a tool needs it): GIF palettes, odd codecs/containers
// Every result says which backend ran (`backend`) and, when knowable, whether hardware acceleration was used.
import { M, vfs, register } from '../js/core.js';
import { canvasOf, canvasBytes, decode, toCanvas } from '../js/img.js';
import { mb, openInput, ensureAudioEncoder, audioEncoderKind, hasWebCodecs } from '../js/media/mb.js';
import { ffJob, ffLoad, ffLoaded, FF_URLS, FF_MAX_INPUT } from '../js/media/ff.js';

// ─────────────────────────────────────────────────────────── tables ──
const WC_MAX_INPUT = 1900 * 1048576;
const LIMITS = `Limits: everything is held in browser memory — WebCodecs handles inputs up to ~${WC_MAX_INPUT / 1048576 | 0} MB (practically a few hundred MB), the ffmpeg backend up to ${FF_MAX_INPUT / 1048576} MB of input and a 2 GB WebAssembly heap, and is 5–50× slower (CPU, one thread).`;
const QUALITIES = ['very-low', 'low', 'medium', 'high', 'very-high'];
// user-facing codec name ↔ Mediabunny name
const V2MB = { h264: 'avc', hevc: 'hevc', vp8: 'vp8', vp9: 'vp9', av1: 'av1' };
const A2MB = { aac: 'aac', opus: 'opus', mp3: 'mp3', vorbis: 'vorbis', flac: 'flac', pcm: 'pcm-s16' };
const uname = (c) => (c === 'avc' ? 'h264' : c && c.startsWith('pcm-') ? c.replace('pcm-', 'pcm_') : c || 'unknown');
// containers: mbf = Mediabunny output format class (absent → ffmpeg only); v/a = preferred codecs (user names), first = default
const CONTAINERS = {
  mp4: { mbf: 'Mp4OutputFormat', v: ['h264', 'hevc', 'vp9', 'av1'], a: ['aac', 'opus', 'mp3', 'flac'], ff: 'mp4', mime: 'video/mp4' },
  mov: { mbf: 'MovOutputFormat', v: ['h264', 'hevc', 'vp9', 'av1', 'prores'], a: ['aac', 'opus', 'mp3', 'flac', 'pcm'], ff: 'mov', mime: 'video/quicktime' },
  webm: { mbf: 'WebMOutputFormat', v: ['vp9', 'av1', 'vp8'], a: ['opus', 'vorbis'], ff: 'webm', mime: 'video/webm' },
  mkv: { mbf: 'MkvOutputFormat', v: ['h264', 'vp9', 'hevc', 'av1', 'vp8', 'mpeg4', 'theora', 'prores'], a: ['aac', 'opus', 'mp3', 'flac', 'vorbis', 'pcm'], ff: 'matroska', mime: 'video/x-matroska' },
  avi: { v: ['mpeg4', 'h264'], a: ['mp3', 'pcm'], ff: 'avi', mime: 'video/x-msvideo' },
  flv: { v: ['h264'], a: ['aac', 'mp3'], ff: 'flv', mime: 'video/x-flv' },
  ogv: { v: ['theora', 'vp8'], a: ['vorbis', 'opus'], ff: 'ogg', mime: 'video/ogg' },
  ts: { v: ['h264', 'hevc'], a: ['aac', 'mp3'], ff: 'mpegts', mime: 'video/mp2t' },
};
const VIDEO_FORMATS = Object.keys(CONTAINERS);
const VIDEO_CODECS = ['auto', 'h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'theora', 'prores'];
const AUDIO_CODECS = ['auto', 'aac', 'opus', 'mp3', 'vorbis', 'flac', 'pcm'];
const FF_V = { h264: ['libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'], hevc: ['libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'], vp9: ['libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p'], vp8: ['libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p'], mpeg4: ['mpeg4'], theora: ['libtheora'], prores: ['prores_ks', '-profile:v', '2'] };
const FF_CRF = { h264: [36, 31, 26, 22, 18], hevc: [38, 33, 28, 24, 20], vp9: [48, 42, 35, 30, 24], vp8: [50, 40, 30, 20, 10] };
const FF_Q = { mpeg4: [20, 12, 7, 4, 2], theora: [2, 4, 6, 8, 10] };
const FF_A = { aac: ['aac'], opus: ['libopus'], mp3: ['libmp3lame'], vorbis: ['libvorbis'], flac: ['flac'], pcm: ['pcm_s16le'] };
// audio-only targets
const AUDIO_FORMATS = {
  wav: { mbf: 'WavOutputFormat', codecs: ['pcm'], ff: 'wav', mime: 'audio/wav' },
  mp3: { mbf: 'Mp3OutputFormat', codecs: ['mp3'], ff: 'mp3', mime: 'audio/mpeg' },
  m4a: { mbf: 'Mp4OutputFormat', codecs: ['aac'], ff: 'ipod', mime: 'audio/mp4' },
  aac: { mbf: 'AdtsOutputFormat', codecs: ['aac'], ff: 'adts', mime: 'audio/aac' },
  ogg: { mbf: 'OggOutputFormat', codecs: ['opus', 'vorbis'], ff: 'ogg', mime: 'audio/ogg' },
  opus: { mbf: 'OggOutputFormat', codecs: ['opus'], ff: 'ogg', mime: 'audio/ogg' },
  flac: { mbf: 'FlacOutputFormat', codecs: ['flac'], ff: 'flac', mime: 'audio/flac' },
  webm: { mbf: 'WebMOutputFormat', codecs: ['opus', 'vorbis'], ff: 'webm', mime: 'audio/webm' },
};
const RATES = { opus: [8000, 12000, 16000, 24000, 48000], mp3: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000], aac: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000] };
const MAXCH = { mp3: 2, opus: 2, vorbis: 8, aac: 6, flac: 8, pcm: 8 };

// ────────────────────────────────────────────────────────── helpers ──
const r3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const msgOf = (e) => (typeof e === 'string' ? e : e?.message || String(e));
const kbps = (v) => (v === undefined || v === null ? undefined : v > 4000 ? Math.round(v) : Math.round(v * 1000)); // accepts kbit/s (or bit/s when > 4000) → bit/s
const fmtTime = (t) => { const s = Math.max(0, t); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; const ss = (x < 10 ? '0' : '') + x.toFixed(1); return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`; };
const oom = (e) => (/allocation failed|out of memory|invalid array length|Array buffer allocation/i.test(msgOf(e)) || e instanceof RangeError ? new Error(`ran out of memory (${msgOf(e)}). The file is too large to process in this browser tab — trim it, lower the resolution/bitrate, or free VFS files first.`) : e);
function guard(path, what = 'the webcodecs backend', max = WC_MAX_INPUT) {
  const st = vfs.stat(path);
  if (st.bytes > max) throw new Error(`"${path}" is ${Math.round(st.bytes / 1048576)} MB — too large for ${what} (limit ${Math.round(max / 1048576)} MB, all processing is in memory)`);
  if (!st.bytes) throw new Error(`"${path}" is empty`);
  return st;
}
function parseCrop(c) {
  if (c === undefined || c === null || c === '') return null;
  let o = c;
  if (typeof c === 'string') { const n = c.split(/[,:x ]+/).map(Number); if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) throw new Error('crop must be {x, y, width, height} or the string "x,y,width,height"'); o = { x: n[0], y: n[1], width: n[2], height: n[3] }; }
  const r = { x: Math.round(o.x ?? o.left ?? 0), y: Math.round(o.y ?? o.top ?? 0), width: Math.round(o.width), height: Math.round(o.height) };
  if (!(r.width > 0 && r.height > 0) || r.x < 0 || r.y < 0) throw new Error('crop needs positive width/height and non-negative x/y');
  return r;
}
/** output frame size after rotate → crop → resize (the order both backends use) */
function planSize(src, p) {
  let w = src.width, h = src.height;
  if (p.rotate === 90 || p.rotate === 270) [w, h] = [h, w];
  if (p.crop) { w = Math.min(p.crop.width, w - p.crop.x); h = Math.min(p.crop.height, h - p.crop.y); if (w <= 0 || h <= 0) throw new Error(`crop rectangle lies outside the ${src.width}×${src.height} frame`); }
  if (p.width && p.height) return { width: even(p.width), height: even(p.height), boxed: true };
  if (p.width) return { width: even(p.width), height: even(h * p.width / w) };
  if (p.height) return { width: even(w * p.height / h), height: even(p.height) };
  return { width: even(w), height: even(h) };
}
const containerOf = (path, fallback) => { const e = vfs.extOf(path || ''); return e === 'm4v' ? 'mp4' : e === 'mpg' || e === 'mpeg' ? null : CONTAINERS[e] ? e : fallback; };

// passive tap on VideoEncoder.configure: tells us whether a conversion really re-encoded video (vs. copied packets)
const tap = { on: false, rec: 0, video: [] };
function tapEncoders() {
  if (tap.on || typeof VideoEncoder === 'undefined') return;
  tap.on = true;
  const orig = VideoEncoder.prototype.configure;
  VideoEncoder.prototype.configure = function (cfg) { if (tap.rec) tap.video.push({ codec: cfg.codec, width: cfg.width, height: cfg.height, hw: cfg.hardwareAcceleration || 'no-preference' }); return orig.call(this, cfg); };
}
const HW = { auto: 'no-preference', hardware: 'prefer-hardware', software: 'prefer-software' };
async function hwEncodable(lib, codec, width, height) { try { return await lib.canEncodeVideo(codec, { width, height, hardwareAcceleration: 'prefer-hardware' }); } catch { return false; } }
async function hwDecodable(track) { try { const cfg = await track.getDecoderConfig(); return !!cfg && !!(await VideoDecoder.isConfigSupported({ ...cfg, hardwareAcceleration: 'prefer-hardware' })).supported; } catch { return false; } }
/** → true (hardware requested and granted) | false (software) | null (browser's choice; a hardware codec exists but WebCodecs does not say which it picked) */
const hwVerdict = (mode, available) => (mode === 'prefer-hardware' ? true : mode === 'prefer-software' ? false : available ? null : false);

// ───────────────────────────────────────────────────────────── probe ──
const SHORT = [[/quicktime/i, 'mov'], [/mp4|isobmff/i, 'mp4'], [/webm/i, 'webm'], [/matroska/i, 'mkv'], [/wav/i, 'wav'], [/mp3/i, 'mp3'], [/ogg/i, 'ogg'], [/flac/i, 'flac'], [/adts/i, 'aac'], [/transport|mpeg-?ts/i, 'ts'], [/hls/i, 'hls']];
const shortFmt = (name) => (SHORT.find(([re]) => re.test(name)) || [0, String(name).toLowerCase()])[1];
async function describe(input, lib, { bytes, deep = false } = {}) {
  if (!(await input.canRead())) return null;
  const format = await input.getFormat();
  const tracks = await input.getTracks();
  const duration = await input.computeDuration();
  const out = { container: shortFmt(format.name), formatName: format.name, mime: await input.getMimeType().catch(() => format.mimeType), duration: r3(duration), bytes, bitrate: bytes && duration > 0 ? Math.round(bytes * 8 / duration) : null, video: null, audio: null, tracks: [] };
  const pv = await input.getPrimaryVideoTrack().catch(() => null), pa = await input.getPrimaryAudioTrack().catch(() => null);
  for (const t of tracks.slice(0, 16)) {
    const codec = await t.getCodec().catch(() => null);
    const stats = await t.computePacketStats(deep ? undefined : 120).catch(() => null);
    const d = { id: t.id, type: t.type, codec: uname(codec), codecString: await t.getCodecParameterString().catch(() => null), start: r3(await t.getFirstTimestamp().catch(() => 0)), duration: r3(await t.computeDuration().catch(() => null)), bitrate: stats ? Math.round(stats.averageBitrate) : null, language: await t.getLanguageCode().catch(() => 'und') };
    if (!codec) d.internalCodecId = String(await t.getInternalCodecId().catch(() => '') ?? '').slice(0, 40);
    if (t.isVideoTrack()) {
      const fr = await t.computeFrameRateMetrics().catch(() => null);
      Object.assign(d, { width: await t.getDisplayWidth(), height: await t.getDisplayHeight(), codedWidth: await t.getCodedWidth(), codedHeight: await t.getCodedHeight(), rotation: await t.getRotation(), fps: r3(fr?.bestGuessFrameRate ?? stats?.averagePacketRate), constantFrameRate: fr ? fr.frameRateIsConstant : null, frames: deep && stats ? stats.packetCount : undefined, hdr: (await t.hasHighDynamicRange().catch(() => false)) || undefined, canDecode: await t.canDecode().catch(() => false) });
      if (pv && t.id === pv.id) out.video = d;
    } else if (t.isAudioTrack()) {
      Object.assign(d, { sampleRate: await t.getSampleRate(), channels: await t.getNumberOfChannels(), canDecode: await t.canDecode().catch(() => false) });
      if (pa && t.id === pa.id) out.audio = d;
    }
    out.tracks.push(d);
  }
  if (tracks.length > 16) out.truncated = true;
  const tags = await input.getMetadataTags().catch(() => null);
  if (tags) { const t = {}; for (const k of ['title', 'artist', 'album', 'genre', 'comment', 'description']) if (typeof tags[k] === 'string' && tags[k]) t[k] = tags[k].slice(0, 200); if (tags.date instanceof Date && !Number.isNaN(+tags.date)) t.date = tags.date.toISOString().slice(0, 10); if (Object.keys(t).length) out.tags = t; }
  const av = out.tracks.filter((t) => t.type !== 'subtitle');
  out.browserCanDecode = av.length > 0 && av.every((t) => t.canDecode);
  return out;
}
async function probeMB(src, opts = {}) {
  const lib = await mb();
  const blob = typeof src === 'string' ? vfs.blob(src) : src instanceof Blob ? src : new Blob([src]);
  const input = new lib.Input({ source: new lib.BlobSource(blob), formats: lib.ALL_FORMATS });
  try { return await describe(input, lib, { bytes: blob.size, ...opts }); } finally { input.dispose(); }
}
const rate = (s) => { if (!s || s === '0/0') return null; const [a, b] = String(s).split('/').map(Number); return b ? a / b : a; };
const FF2U = { h264: 'h264', hevc: 'hevc', vp8: 'vp8', vp9: 'vp9', av1: 'av1', aac: 'aac', opus: 'opus', mp3: 'mp3', vorbis: 'vorbis', flac: 'flac' };
async function probeFF(path, ctx, forced = false) {
  const bytes = vfs.stat(path).bytes;
  const j = await ffJob(ctx, async (job) => {
    const inp = job.input(path), o = job.tmp('probe.json');
    const r = await job.probe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inp, '-o', o], { allowFail: true });
    let txt; try { txt = new TextDecoder().decode(await job.read(o)); } catch { txt = ''; }
    try { const p = JSON.parse(txt); if (!p.format) throw 0; return p; } catch { throw new Error(`not a media file ffmpeg can read: ${r.log.filter((l) => l.trim()).slice(-2).join(' | ').replace(/\/in\d+\/\d+\.\w+/g, path).slice(0, 300) || 'unknown format'}`); }
  });
  const lib = hasWebCodecs() ? await mb() : null;
  const duration = Number(j.format.duration) || null;
  const names = (j.format.format_name || '').split(','), ext = vfs.extOf(path);
  const out = { container: names.includes(ext) ? ext : names.includes('matroska') ? (ext === 'webm' ? 'webm' : 'mkv') : names[0], formatName: j.format.format_long_name || j.format.format_name, mime: vfs.mimeOf(path), duration: r3(duration), bytes, bitrate: Number(j.format.bit_rate) || (duration ? Math.round(bytes * 8 / duration) : null), video: null, audio: null, tracks: [] };
  for (const s of (j.streams || []).slice(0, 16)) {
    const type = s.codec_type === 'video' ? 'video' : s.codec_type === 'audio' ? 'audio' : s.codec_type;
    const codec = FF2U[s.codec_name] || s.codec_name || 'unknown';
    const d = { id: s.index + 1, type, codec, codecString: s.codec_tag_string || null, start: r3(Number(s.start_time) || 0), duration: r3(Number(s.duration) || duration), bitrate: Number(s.bit_rate) || null, language: s.tags?.language || 'und' };
    const mbCodec = type === 'video' ? V2MB[codec] : A2MB[codec];
    const canDecode = lib && mbCodec ? await lib.canDecode(mbCodec).catch(() => false) : false;
    if (type === 'video') {
      if (s.disposition?.attached_pic) d.attachedPicture = true;
      let rot = Number(s.tags?.rotate) || 0; for (const sd of s.side_data_list || []) if (sd.rotation !== undefined) rot = -Number(sd.rotation);
      rot = ((Math.round(rot / 90) * 90) % 360 + 360) % 360;
      const swap = rot === 90 || rot === 270;
      Object.assign(d, { width: swap ? s.height : s.width, height: swap ? s.width : s.height, codedWidth: s.coded_width || s.width, codedHeight: s.coded_height || s.height, rotation: rot, fps: r3(rate(s.avg_frame_rate) ?? rate(s.r_frame_rate)), frames: Number(s.nb_frames) || undefined, pixelFormat: s.pix_fmt, canDecode });
      if (!out.video && !d.attachedPicture) out.video = d;
    } else if (type === 'audio') {
      Object.assign(d, { sampleRate: Number(s.sample_rate) || null, channels: s.channels || null, canDecode });
      if (!out.audio) out.audio = d;
    }
    out.tracks.push(d);
  }
  const t = {}; for (const k of ['title', 'artist', 'album', 'genre', 'comment', 'date']) { const v = j.format.tags?.[k] ?? j.format.tags?.[k.toUpperCase()]; if (v) t[k] = String(v).slice(0, 200); } if (Object.keys(t).length) out.tags = t;
  const av = out.tracks.filter((x) => x.type === 'video' || x.type === 'audio');
  out.codecsDecodable = av.length > 0 && av.every((x) => x.canDecode);
  if (forced) out.browserCanDecode = out.codecsDecodable;
  else { out.browserCanDecode = false; out.note = 'the container is not readable by the WebCodecs demuxer — video.* tools use the ffmpeg backend for this file'; }
  return out;
}
/** unified description of a VFS media file. backend: auto | webcodecs | ffmpeg → {…, backend} */
async function probeAny(path, ctx, { backend = 'auto', deep = false } = {}) {
  vfs.stat(path);
  if (backend !== 'ffmpeg') {
    let info = null, err = null;
    try { info = await probeMB(path, { deep }); } catch (e) { err = e; }
    if (info) return { ...info, backend: 'webcodecs' };
    if (backend === 'webcodecs') throw new Error(`"${path}" is not in a container the WebCodecs demuxer reads (mp4, mov, webm, mkv, wav, mp3, ogg, flac, aac/adts, mpeg-ts)${err ? `: ${msgOf(err)}` : ''}. Try backend=ffmpeg.`);
  }
  return { ...(await probeFF(path, ctx, backend === 'ffmpeg')), backend: 'ffmpeg' };
}
const brief = (info) => (!info ? {} : {
  duration: info.duration,
  ...(info.video ? { video: { codec: info.video.codec, width: info.video.width, height: info.video.height, fps: info.video.fps, bitrate: info.video.bitrate } } : {}),
  ...(info.audio ? { audio: { codec: info.audio.codec, sampleRate: info.audio.sampleRate, channels: info.audio.channels, bitrate: info.audio.bitrate } } : {}),
});
/** write an output file with duration/size metadata taken from a quick probe of the bytes; → {stat, info} */
async function finish(path, bytes, mime) {
  let info = null;
  try { info = await probeMB(bytes); } catch { /* not a container Mediabunny reads (avi, flv, gif…) */ }
  const meta = info ? { ...(info.duration ? { duration: info.duration } : {}), ...(info.video ? { width: info.video.width, height: info.video.height } : {}) } : {};
  const stat = await vfs.write(path, bytes, { meta, ...(mime ? { mime } : {}) });
  return { stat, info };
}
/** run `wc` and/or `ff` according to the backend argument; auto falls back to ffmpeg when WebCodecs cannot do it */
async function pick(backend, ctx, wc, ff, { ffOnly = null } = {}) {
  if (backend === 'ffmpeg') return ff(null);
  if (ffOnly) { if (backend === 'webcodecs') throw new Error(`backend=webcodecs cannot do this: ${ffOnly}. Use backend=auto or ffmpeg.`); return ff(ffOnly); }
  if (!hasWebCodecs()) { if (backend === 'webcodecs') throw new Error('this browser has no WebCodecs (VideoEncoder/VideoDecoder/AudioEncoder); use backend=ffmpeg'); return ff('WebCodecs is not available in this browser'); }
  try { return await wc(); } catch (e) {
    const err = oom(e);
    if (backend === 'webcodecs' || err !== e) throw err;
    ctx.warn(`webcodecs path failed (${msgOf(e)}); falling back to ffmpeg.wasm`);
    try { return await ff(msgOf(e).slice(0, 240)); } catch (e2) { throw new Error(`webcodecs failed: ${msgOf(e)} — and the ffmpeg fallback failed too: ${msgOf(e2)}`); }
  }
}

// ────────────────────────────────────────── conversion: webcodecs ──
function mbFormat(lib, key, table = CONTAINERS) {
  const c = table[key];
  if (!c?.mbf) throw new Error(`the webcodecs backend cannot write .${key} (it writes: ${Object.keys(table).filter((k) => table[k].mbf).join(', ')})`);
  return new lib[c.mbf]();
}
const mbQuality = (lib, bitrate, quality) => (bitrate ? new lib.Quality({ bitrate }) : quality ? new lib.Quality(quality) : undefined);
/**
 * p: {input, format, vcodec?, acodec?, width?, height?, fit?, fps?, vbitrate?, quality?, abitrate?, start?, end?, rotate?, crop?, mute?, noVideo?,
 *     hardware, copy: 'auto'|'forced'|'never', sampleRate?, channels?, table?}
 */
async function convertWC(p, ctx, src) {
  const lib = await mb();
  tapEncoders();
  const table = p.table || CONTAINERS, cont = table[p.format];
  const fmtProbe = mbFormat(lib, p.format, table);
  const sv = p.noVideo ? null : src.video, sa = p.mute ? null : src.audio;
  if (sv && !sv.canDecode) throw new Error(`this browser cannot decode the ${sv.codec} video track`);
  if (sa && !sa.canDecode) throw new Error(`this browser cannot decode the ${sa.codec} audio track`);
  if (!sv && !sa) throw new Error('nothing to convert: no usable video or audio track');
  // video plan
  let vcodec = null, size = null, vTransform = false;
  if (sv) {
    if (p.vcodec && !V2MB[p.vcodec]) throw new Error(`video codec ${p.vcodec} is not available through WebCodecs`);
    const supported = fmtProbe.getSupportedVideoCodecs();
    if (!supported.length) throw new Error(`.${p.format} cannot hold video`);
    size = planSize(sv, p);
    vTransform = !!(p.width || p.height || p.fps || p.rotate || p.crop || p.vbitrate || p.quality) || p.copy === 'never';
    const want = p.vcodec ? [V2MB[p.vcodec]] : [...(!vTransform && V2MB[sv.codec] ? [V2MB[sv.codec]] : []), ...cont.v.map((c) => V2MB[c]).filter(Boolean)];
    for (const c of want) { if (!supported.includes(c)) continue; if ((!vTransform && V2MB[sv.codec] === c) || await lib.canEncodeVideo(c, { width: size.width, height: size.height }).catch(() => false)) { vcodec = c; break; } }
    if (!vcodec) throw new Error(p.vcodec ? `this browser cannot encode ${p.vcodec} at ${size.width}×${size.height} into .${p.format} via WebCodecs` : `no WebCodecs video encoder fits .${p.format} in this browser`);
  }
  // audio plan
  let acodec = null, sampleRate = p.sampleRate, channels = p.channels, audioCopy = false;
  if (sa) {
    const supported = fmtProbe.getSupportedAudioCodecs();
    const srcMb = A2MB[sa.codec] || (sa.codec.startsWith('pcm_') ? sa.codec.replace('pcm_', 'pcm-') : null);
    const aTransform = !!(p.abitrate || p.sampleRate || p.channels) || p.copy === 'never' || (p.format === 'wav' && srcMb !== 'pcm-s16');
    const want = p.acodec ? [A2MB[p.acodec]] : [...(!aTransform && srcMb ? [srcMb] : []), ...(cont.a || cont.codecs).map((c) => A2MB[c])];
    for (const c of want) {
      if (!c || !supported.includes(c)) continue;
      if (!aTransform && !p.acodec && srcMb === c) { acodec = c; break; }
      if (c.startsWith('pcm-') || await ensureAudioEncoder(c)) { acodec = c; break; }
    }
    if (!acodec) throw new Error(p.acodec ? `this browser cannot encode ${p.acodec} audio into .${p.format} via WebCodecs` : `no usable audio encoder for .${p.format} in this browser`);
    const u = uname(acodec).replace(/^pcm_.*/, 'pcm');
    const copying = audioCopy = !aTransform && srcMb === acodec;
    if (!copying) {
      if (RATES[u]) { const r = sampleRate || sa.sampleRate; if (!RATES[u].includes(r)) sampleRate = RATES[u].find((x) => x >= r) || RATES[u][RATES[u].length - 1]; }
      if ((channels || sa.channels) > (MAXCH[u] || 8)) channels = MAXCH[u];
    }
  }
  const trim = (p.start || p.end != null) ? { ...(p.start ? { start: p.start } : {}), ...(p.end != null ? { end: p.end } : {}) } : undefined;
  const hwEnc = sv && vcodec ? await hwEncodable(lib, vcodec, size.width, size.height) : false;
  const modes = !sv ? ['no-preference'] : p.hardware === 'hardware' ? ['prefer-hardware'] : p.hardware === 'software' ? ['prefer-software'] : (hwEnc && vTransform && await hwDecodableOf(p.input) ? ['prefer-hardware', 'no-preference'] : ['no-preference']);
  let lastErr = null;
  for (const mode of modes) {
    const input = await openInput(p.input);
    const output = new lib.Output({ format: mbFormat(lib, p.format, table), target: new lib.BufferTarget() });
    tap.video = []; tap.rec++;
    try {
      const video = !sv ? { discard: true } : {
        codec: vcodec, hardwareAcceleration: mode, ...(vTransform ? { forceTranscode: true } : {}),
        ...(p.width || p.height ? { width: size.width, height: size.height, fit: size.boxed ? (p.fit || 'contain') : 'fill' } : {}),
        ...(p.rotate ? { rotate: p.rotate, allowTransformationMetadata: false } : {}),
        ...(p.crop ? { crop: { left: p.crop.x, top: p.crop.y, width: p.crop.width, height: p.crop.height } } : {}),
        ...(p.fps ? { frameRate: p.fps } : {}),
        ...(p.vbitrate || p.quality ? { quality: mbQuality(lib, p.vbitrate, p.quality) } : {}),
      };
      const audio = !sa ? { discard: true } : { codec: acodec, ...(p.copy === 'never' ? { forceTranscode: true } : {}), ...(p.abitrate ? { quality: mbQuality(lib, p.abitrate) } : {}), ...(sampleRate ? { sampleRate } : {}), ...(channels ? { numberOfChannels: channels } : {}) };
      const copy = p.copy === 'never' ? false : p.copy === 'forced' ? { mode: 'forced', shiftTolerance: Infinity, boundaryPolicy: 'expand' } : {};
      const conv = await lib.Conversion.init({ input, output, video, audio, trim, copy, tracks: 'primary', showWarnings: false });
      const lost = conv.discardedTracks.filter((d) => d.reason !== 'discarded_by_user' && d.track.type !== 'subtitle');
      if (!conv.isValid || lost.length) throw new Error(`webcodecs cannot do this conversion (${lost.map((d) => `${d.track.type} track: ${d.reason}`).join('; ') || 'no usable tracks'})`);
      let last = 0;
      conv.onProgress = (f) => { const now = performance.now(); if (now - last > 200) { last = now; ctx.progress(f, 'webcodecs'); } };
      await conv.execute();
      const bytes = new Uint8Array(output.target.buffer);
      const encoded = tap.video.length > 0;
      return {
        bytes,
        info: {
          backend: 'webcodecs', hardwareAccelerated: sv ? (encoded ? hwVerdict(mode, hwEnc) : false) : false,
          ...(sv ? { videoCodec: uname(vcodec), videoReencoded: encoded } : {}),
          ...(sa ? { audioCodec: uname(acodec).replace(/^pcm_.*/, 'pcm'), audioReencoded: !audioCopy, ...(audioCopy || acodec.startsWith('pcm-') ? {} : { audioEncoder: audioEncoderKind(acodec) }) } : {}),
          ...(sv && encoded && hwVerdict(mode, hwEnc) === null ? { hardwareNote: 'a hardware encoder exists and the browser chose between it and software (WebCodecs does not report which); pass hardware=hardware or hardware=software to force one' } : {}),
        },
      };
    } catch (e) { lastErr = e; await output.cancel().catch(() => {}); if (oom(e) !== e) break; } finally { tap.rec--; input.dispose(); }
  }
  throw oom(lastErr);
}
async function hwDecodableOf(path) {
  const input = await openInput(path);
  try { const t = await input.getPrimaryVideoTrack(); return t ? await hwDecodable(t) : false; } catch { return false; } finally { input.dispose(); }
}

// ───────────────────────────────────────────── conversion: ffmpeg ──
function ffVideoFilters(p, sv, vcodec) {
  const vf = [];
  if (p.rotate === 90) vf.push('transpose=1'); else if (p.rotate === 180) vf.push('hflip', 'vflip'); else if (p.rotate === 270) vf.push('transpose=2');
  if (p.crop) vf.push(`crop=${p.crop.width}:${p.crop.height}:${p.crop.x}:${p.crop.y}`);
  if (p.width || p.height) {
    const s = planSize(sv, p);
    if (s.boxed) {
      const fit = p.fit || 'contain';
      if (fit === 'fill') vf.push(`scale=${s.width}:${s.height}`);
      else if (fit === 'cover') vf.push(`scale=${s.width}:${s.height}:force_original_aspect_ratio=increase`, `crop=${s.width}:${s.height}`);
      else vf.push(`scale=${s.width}:${s.height}:force_original_aspect_ratio=decrease`, `pad=${s.width}:${s.height}:(ow-iw)/2:(oh-ih)/2`);
    } else vf.push(`scale=${s.width}:${s.height}`);
    vf.push('setsar=1');
  } else if (['h264', 'hevc', 'vp9', 'vp8', 'theora'].includes(vcodec)) vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  if (p.fps) vf.push(`fps=${p.fps}`);
  return vf;
}
function ffCodecArgs(p, cont, sv, sa) {
  const args = []; let vcodec = null, acodec = null;
  if (sv) {
    vcodec = p.vcodec || cont.v[0];
    if (vcodec === 'av1') throw new Error('the ffmpeg.wasm build has no AV1 encoder — use backend=webcodecs for AV1, or pick h264/vp9/hevc');
    if (!FF_V[vcodec]) throw new Error(`unknown video codec ${vcodec}`);
    const vf = ffVideoFilters(p, sv, vcodec);
    if (vf.length) args.push('-vf', vf.join(','));
    args.push('-c:v', ...FF_V[vcodec]);
    const qi = QUALITIES.indexOf(p.quality || 'medium');
    if (p.vbitrate) args.push('-b:v', String(p.vbitrate));
    else if (FF_CRF[vcodec]) { args.push('-crf', String(FF_CRF[vcodec][qi])); if (vcodec === 'vp9') args.push('-b:v', '0'); if (vcodec === 'vp8') args.push('-b:v', '4M'); }
    else if (FF_Q[vcodec]) args.push('-q:v', String(FF_Q[vcodec][qi]));
  } else args.push('-vn');
  if (sa) {
    acodec = p.acodec || (cont.a || cont.codecs)[0];
    if (!FF_A[acodec]) throw new Error(`unknown audio codec ${acodec}`);
    args.push('-c:a', ...FF_A[acodec]);
    if (p.abitrate && !['flac', 'pcm'].includes(acodec)) args.push('-b:a', String(p.abitrate));
    let sr = p.sampleRate; const u = acodec;
    if (RATES[u] && !RATES[u].includes(sr || sa.sampleRate)) sr = RATES[u].find((x) => x >= (sr || sa.sampleRate)) || RATES[u][RATES[u].length - 1];
    if (sr) args.push('-ar', String(sr));
    const ch = (p.channels || sa.channels) > (MAXCH[u] || 8) ? MAXCH[u] : p.channels;
    if (ch) args.push('-ac', String(ch));
    args.push('-strict', '-2');
  } else args.push('-an');
  return { args, vcodec, acodec };
}
async function convertFF(p, ctx, src, reason) {
  const table = p.table || CONTAINERS, cont = table[p.format];
  const sv = p.noVideo ? null : src.video, sa = p.mute ? null : src.audio;
  if (!sv && !sa) throw new Error('nothing to convert: no usable video or audio track');
  const span = Math.max(0.01, (p.end ?? src.duration ?? 0) - (p.start || 0));
  return ffJob(ctx, async (job) => {
    const inp = job.input(p.input), out = job.tmp(`out.${p.format}`);
    const args = [];
    if (p.start) args.push('-ss', String(p.start));
    if (p.end != null) args.push('-to', String(p.end));
    args.push('-i', inp, '-sn', '-dn', '-map_chapters', '-1');
    let vcodec = null, acodec = null;
    if (p.copy === 'forced') { args.push('-c', 'copy'); if (!sv) args.push('-vn'); if (!sa) args.push('-an'); args.push('-avoid_negative_ts', 'make_zero'); } else {
      const c = ffCodecArgs(p, cont, sv, sa); args.push(...c.args); vcodec = c.vcodec; acodec = c.acodec;
    }
    if (p.format === 'mp4' || p.format === 'mov' || p.format === 'm4a') args.push('-movflags', '+faststart');
    args.push('-f', cont.ff, out);
    await job.exec(args, { duration: span });
    const bytes = await job.read(out);
    return { bytes, info: { backend: 'ffmpeg', hardwareAccelerated: false, ...(sv ? { videoCodec: vcodec || src.video.codec, videoReencoded: p.copy !== 'forced' } : {}), ...(sa ? { audioCodec: acodec || src.audio.codec, audioReencoded: p.copy !== 'forced' } : {}), ...(reason ? { fallbackReason: reason } : {}) } };
  });
}
/** shared by convert / compress / trim: validate, choose backend, run, write → result object */
async function runConvert(p, ctx, src, outPath) {
  const cont = (p.table || CONTAINERS)[p.format];
  const ffOnly = !cont.mbf ? `.${p.format} is written by ffmpeg only`
    : p.vcodec && !V2MB[p.vcodec] ? `${p.vcodec} video is encoded by ffmpeg only`
      : p.acodec === 'vorbis' ? 'Vorbis audio is encoded by ffmpeg only (WebCodecs has no Vorbis encoder)'
        : src.backend === 'ffmpeg' ? `the input container (${src.container}) is only readable by ffmpeg` : null;
  if (p.vcodec && !cont.v?.includes(p.vcodec)) throw new Error(`.${p.format} does not take ${p.vcodec} video — it takes: ${(cont.v || []).join(', ') || 'no video'}`);
  if (p.acodec && !(cont.a || cont.codecs).includes(p.acodec)) throw new Error(`.${p.format} does not take ${p.acodec} audio — it takes: ${(cont.a || cont.codecs).join(', ')}`);
  if (p.start != null && p.end != null && p.end <= p.start) throw new Error(`end (${p.end}) must be greater than start (${p.start})`);
  if (p.start && src.duration && p.start >= src.duration) throw new Error(`start (${p.start}s) is beyond the end of the file (${src.duration}s)`);
  if (p.end != null && src.duration && p.end > src.duration) p.end = undefined;
  const { bytes, info } = await pick(p.backend, ctx, () => { guard(p.input); return convertWC(p, ctx, src); }, (reason) => convertFF(p, ctx, src, reason), { ffOnly });
  const { stat, info: outInfo } = await finish(outPath, bytes, cont.mime);
  ctx.progress(1, 'done');
  return { output: stat, ...info, ...brief(outInfo) };
}
function convertParams(a, src) {
  const format = a.format && a.format !== 'auto' ? a.format : containerOf(a.output, null) || (src.video ? 'mp4' : null);
  if (!format || !CONTAINERS[format]) throw new Error(`cannot tell the target container — pass format (${VIDEO_FORMATS.join(' | ')}) or an output path with one of those extensions`);
  return {
    input: a.input, backend: a.backend, hardware: a.hardware || 'auto', format,
    vcodec: a.videoCodec && a.videoCodec !== 'auto' ? a.videoCodec : null, acodec: a.audioCodec && a.audioCodec !== 'auto' ? a.audioCodec : null,
    width: a.width, height: a.height, fit: a.fit, fps: a.fps, vbitrate: kbps(a.videoBitrate), quality: a.quality, abitrate: kbps(a.audioBitrate),
    start: a.start, end: a.end, rotate: a.rotate || 0, crop: parseCrop(a.crop), mute: !!a.mute, copy: 'auto', sampleRate: a.sampleRate, channels: a.channels,
  };
}

// ─────────────────────────────── manual pipeline (concat / speed) ──
async function chooseVideoCodec(lib, format, wanted, width, height) {
  const cont = CONTAINERS[format];
  for (const u of wanted ? [wanted] : cont.v) { const c = V2MB[u]; if (c && await lib.canEncodeVideo(c, { width, height }).catch(() => false)) return c; }
  throw new Error(wanted ? `this browser cannot encode ${wanted} at ${width}×${height} via WebCodecs` : `no WebCodecs video encoder for .${format} in this browser`);
}
async function chooseAudioCodec(lib, format, wanted) {
  const cont = CONTAINERS[format];
  for (const u of wanted ? [wanted] : cont.a) { const c = A2MB[u]; if (c && (c.startsWith('pcm-') || await ensureAudioEncoder(c))) return c; }
  throw new Error(`no usable audio encoder${wanted ? ` for ${wanted}` : ''} for .${format} in this browser`);
}
/**
 * Decode clips one after another and re-encode them into a single file.
 * clips: [{path, info, start?, end?, speed?}] · o: {format, vcodec?, acodec?, width, height, fps?, vbitrate?, quality?, abitrate?, hardware, audio: bool, sampleRate, channels, maxFps?}
 */
async function pipelineWC(clips, o, ctx) {
  const lib = await mb(); tapEncoders();
  const vcodec = await chooseVideoCodec(lib, o.format, o.vcodec, o.width, o.height);
  const acodec = o.audio ? await chooseAudioCodec(lib, o.format, o.acodec) : null;
  const ua = acodec ? uname(acodec).replace(/^pcm_.*/, 'pcm') : null;
  let sampleRate = o.sampleRate, channels = Math.min(o.channels || 2, MAXCH[ua] || 2);
  if (acodec && RATES[ua] && !RATES[ua].includes(sampleRate)) sampleRate = RATES[ua].find((x) => x >= sampleRate) || 48000;
  const hwEnc = await hwEncodable(lib, vcodec, o.width, o.height);
  const mode = o.hardware === 'hardware' ? 'prefer-hardware' : o.hardware === 'software' ? 'prefer-software' : hwEnc && !o.noHw ? 'prefer-hardware' : 'no-preference';
  const total = clips.reduce((s, c) => s + ((c.end ?? c.info.duration) - (c.start || 0)) / (c.speed || 1), 0);
  const output = new lib.Output({ format: mbFormat(lib, o.format), target: new lib.BufferTarget() });
  const vsrc = new lib.VideoSampleSource({ codec: vcodec, quality: mbQuality(lib, o.vbitrate, o.quality || 'medium'), hardwareAcceleration: mode, transform: { width: o.width, height: o.height, fit: 'contain', ...(o.fps ? { frameRate: o.fps } : {}) } });
  output.addVideoTrack(vsrc);
  let asrc = null;
  if (acodec) { asrc = new lib.AudioSampleSource({ codec: acodec, ...(acodec.startsWith('pcm-') ? {} : { quality: mbQuality(lib, o.abitrate, 'medium') }), transform: { numberOfChannels: channels, sampleRate } }); output.addAudioTrack(asrc); }
  const inputs = [];
  try {
    await output.start();
    let offset = 0, lastP = 0;
    for (const clip of clips) {
      const input = await openInput(clip.path); inputs.push(input);
      const vt = await input.getPrimaryVideoTrack(), at = asrc ? await input.getPrimaryAudioTrack() : null;
      if (!vt) throw new Error(`"${clip.path}" has no video track`);
      if (!(await vt.canDecode())) throw new Error(`this browser cannot decode the video of "${clip.path}"`);
      const speed = clip.speed || 1, t0 = clip.start ?? Math.max(0, await vt.getFirstTimestamp()), t1 = clip.end ?? clip.info.duration, len = (t1 - t0) / speed;
      const minGap = o.maxFps ? 1 / o.maxFps - 1e-4 : 0;
      const vTask = (async () => {
        let lastTs = -Infinity;
        for await (const s of new lib.VideoSampleSink(vt).samples(t0, t1)) {
          const ts = offset + Math.max(0, s.timestamp - t0) / speed;
          if (ts - lastTs < minGap || s.timestamp >= t1) { s.close(); continue; }
          lastTs = ts; s.setTimestamp(ts); s.setDuration(Math.max(1e-3, minGap ? Math.max(minGap, s.duration / speed) : s.duration / speed));
          await vsrc.add(s); s.close();
          const now = performance.now(); if (now - lastP > 200) { lastP = now; ctx.progress(Math.min(0.99, ts / total), 'webcodecs'); }
        }
      })();
      const aTask = (async () => {
        if (!asrc) return;
        let cursor = offset;
        if (at && await at.canDecode()) {
          for await (const s of new lib.AudioSampleSink(at).samples(t0, t1)) {
            let sample = s;
            const want = offset + (s.timestamp - t0) / speed; if (want > cursor + 0.02) cursor = want;        // keep real gaps (late-starting audio)
            if (s.timestamp < t0 - 1e-4) { const skip = Math.round((t0 - s.timestamp) * s.sampleRate); if (skip >= s.numberOfFrames) { s.close(); continue; } sample = s.trim(skip); s.close(); }
            if (speed !== 1) { // resample trick: relabel the sample rate, the encoder's resampler does the rest (tempo and pitch change together)
              const n = sample.numberOfFrames, ch = sample.numberOfChannels, data = new Float32Array(n * ch);
              for (let c = 0; c < ch; c++) sample.copyTo(data.subarray(c * n, (c + 1) * n), { planeIndex: c, format: 'f32-planar' });
              const re = new lib.AudioSample({ data, format: 'f32-planar', numberOfChannels: ch, sampleRate: Math.round(sample.sampleRate * speed), timestamp: cursor });
              sample.close(); sample = re;
            } else sample.setTimestamp(cursor);
            cursor += sample.duration;
            if (cursor > offset + len + 0.05) { sample.close(); break; }
            await asrc.add(sample); sample.close();
          }
        }
        // pad with silence so that every clip contributes exactly its length of audio
        while (offset + len - cursor > 0.002) {
          const n = Math.min(sampleRate, Math.round((offset + len - cursor) * sampleRate)); if (n <= 0) break;
          const sil = new lib.AudioSample({ data: new Float32Array(n * channels), format: 'f32-planar', numberOfChannels: channels, sampleRate, timestamp: cursor });
          cursor += n / sampleRate; await asrc.add(sil); sil.close();
        }
      })();
      await Promise.all([vTask, aTask]);
      offset += len; input.dispose(); inputs.pop();
    }
    await output.finalize();
    return { bytes: new Uint8Array(output.target.buffer), info: { backend: 'webcodecs', hardwareAccelerated: hwVerdict(mode, hwEnc), videoCodec: uname(vcodec), ...(acodec ? { audioCodec: ua, audioEncoder: audioEncoderKind(acodec) } : {}) } };
  } catch (e) {
    await output.cancel().catch(() => {}); for (const i of inputs.splice(0)) i.dispose();
    if (mode === 'prefer-hardware' && o.hardware !== 'hardware' && oom(e) === e) { ctx.warn(`hardware encoder failed (${msgOf(e)}); retrying with the browser's default encoder`); return pipelineWC(clips, { ...o, noHw: true }, ctx); }
    throw oom(e);
  } finally { for (const i of inputs) i.dispose(); }
}

// ─────────────────────────────────────────────────── frame grabbing ──
/**
 * Calls onFrame(source, time, index) for each timestamp (source: canvas | ImageBitmap, only valid during the call).
 * → {backend, hardwareAccelerated, grabbed}
 */
async function grabFrames(path, src, times, size, a, ctx, onFrame, span = [0, 1]) {
  const prog = (i) => ctx.progress(span[0] + (span[1] - span[0]) * (i / times.length), 'frames');
  const wc = async () => {
    guard(path);
    const lib = await mb(); const input = await openInput(path);
    try {
      const vt = await input.getPrimaryVideoTrack();
      if (!vt) throw new Error(`"${path}" has no video track`);
      if (!(await vt.canDecode())) throw new Error(`this browser cannot decode ${src.video?.codec || 'this'} video`);
      const hw = await hwDecodable(vt), mode = HW[a.hardware || 'auto'];
      const sink = new lib.CanvasSink(vt, { width: size.width, height: size.height, fit: 'fill', poolSize: 1, decoderOptions: { hardwareAcceleration: mode } });
      let i = 0, grabbed = 0;
      for await (const wcv of sink.canvasesAtTimestamps(times)) { if (wcv) { await onFrame(wcv.canvas, times[i], i, wcv.timestamp); grabbed++; } i++; prog(i); }
      return { backend: 'webcodecs', hardwareAccelerated: hwVerdict(mode, hw), grabbed };
    } finally { input.dispose(); }
  };
  const ff = (reason) => ffJob(ctx, async (job) => {
    const inp = job.input(path); let grabbed = 0;
    const back = src.video?.fps ? 1 / src.video.fps - 0.002 : 0;      // -ss lands on the first frame at/after the time; step back so we get the frame SHOWN at that time
    for (let i = 0; i < times.length; i++) {
      const o = job.tmp(`f${i}.png`);
      await job.exec(['-ss', String(Math.max(0, r3(times[i] - back))), '-i', inp, '-frames:v', '1', '-an', '-sn', '-vf', `scale=${size.width}:${size.height}`, '-f', 'image2', '-c:v', 'png', o], { allowFail: true });
      if (await job.exists(o)) { const bmp = await createImageBitmap(new Blob([await job.read(o)], { type: 'image/png' })); await onFrame(bmp, times[i], i, times[i]); bmp.close(); grabbed++; }
      prog(i + 1);
    }
    return { backend: 'ffmpeg', hardwareAccelerated: false, grabbed, ...(reason ? { fallbackReason: reason } : {}) };
  });
  return pick(a.backend, ctx, wc, ff, { ffOnly: src.backend === 'ffmpeg' ? `the input container (${src.container}) is only readable by ffmpeg` : null });
}
function frameSize(sv, a, dflt) {
  let w = sv.width, h = sv.height;
  if (a.width && a.height) return { width: Math.round(a.width), height: Math.round(a.height) };
  const tw = a.width || (!a.height && dflt && w > dflt ? dflt : null);
  if (tw) return { width: Math.round(tw), height: Math.max(1, Math.round(h * tw / w)) };
  if (a.height) return { width: Math.max(1, Math.round(w * a.height / h)), height: Math.round(a.height) };
  return { width: w, height: h };
}
/** evenly spaced sample times inside [start, end): the middle of each of n equal slices */
function spread(n, start, end) { const out = []; for (let i = 0; i < n; i++) out.push(r3(start + (end - start) * (i + 0.5) / n)); return out; }
function rangeOf(a, src) {
  const first = src.video?.start > 0 ? src.video.start : 0;
  const start = Math.max(first, a.start ?? first), end = Math.min(src.duration, a.end ?? src.duration);
  if (!(end > start)) throw new Error(`empty time range: start=${start} end=${end} (duration ${src.duration}s)`);
  return { start, end };
}
async function needVideo(a, ctx) {
  const src = await probeAny(a.input, ctx, { backend: a.backend === 'ffmpeg' ? 'auto' : a.backend });
  if (!src.video) throw new Error(`"${a.input}" has no video track (tracks: ${src.tracks.map((t) => `${t.type}/${t.codec}`).join(', ') || 'none'})`);
  if (!(src.duration > 0)) throw new Error(`"${a.input}" has no measurable duration`);
  return src;
}

// ──────────────────────────────────────────────────────── schemas ──
const P = {
  input: (what = 'video') => ({ type: 'string', description: `VFS path of the source ${what}` }),
  output: { type: 'string', description: 'VFS path to write (default: derived from the input name); its extension selects the container when format is not given' },
  backend: { type: 'string', enum: ['auto', 'webcodecs', 'ffmpeg'], default: 'auto', description: 'auto = WebCodecs (hardware-accelerated where the browser offers it), falling back to ffmpeg.wasm (CPU) when WebCodecs cannot do the job; webcodecs / ffmpeg force one and fail instead of falling back' },
  hardware: { type: 'string', enum: ['auto', 'hardware', 'software'], default: 'auto', description: 'WebCodecs only. auto = use a hardware codec when one exists; hardware = require it (fails if none); software = force CPU codecs (slower, sometimes better quality at low bitrates)' },
  start: { type: 'number', minimum: 0, description: 'Start time in seconds (default 0)' },
  end: { type: 'number', minimum: 0, description: 'End time in seconds (default: end of file)' },
  quality: { type: 'string', enum: QUALITIES, description: 'Subjective quality preset; sets the bitrate from resolution and codec (WebCodecs) or the CRF (ffmpeg). Ignored when videoBitrate is given' },
  videoCodec: { type: 'string', enum: VIDEO_CODECS, default: 'auto', description: 'auto = keep the source codec when it fits the container and nothing forces a re-encode, else the container default (mp4/mov/mkv: h264, webm: vp9). av1 needs WebCodecs; mpeg4, theora, prores need ffmpeg' },
  audioCodec: { type: 'string', enum: AUDIO_CODECS, default: 'auto', description: 'auto = keep the source codec when possible, else the container default (mp4/mov/mkv: aac, webm: opus). vorbis needs ffmpeg' },
};
const RESIZE = {
  width: { type: 'integer', minimum: 16, maximum: 8192, description: 'Output width in pixels (rounded to even). With only width or only height the aspect ratio is kept' },
  height: { type: 'integer', minimum: 16, maximum: 8192, description: 'Output height in pixels (rounded to even)' },
  fit: { type: 'string', enum: ['contain', 'cover', 'fill'], default: 'contain', description: 'When both width and height are given: contain = letterbox, cover = crop to fill, fill = stretch' },
};

// ────────────────────────────────────────────────────────── tools ──
register({
  name: 'video.probe', readOnly: true,
  description: 'Inspect a video or audio file: container, duration, overall bitrate, and per track the codec, resolution, rotation, frame rate, bitrate, audio sample rate/channels, plus whether THIS browser can decode each track (canDecode / browserCanDecode). Run it first on any media file. Reads mp4, mov, webm, mkv, wav, mp3, ogg, flac, aac, mpeg-ts natively; anything else (avi, flv, wmv, …) through the ffmpeg fallback. Returns {container, duration, bytes, bitrate, video, audio, tracks[], browserCanDecode, backend}.',
  schema: {
    properties: {
      input: P.input('media file'),
      deep: { type: 'boolean', default: false, description: 'Scan every packet for exact frame counts and average bitrates (slower on big files); default samples the first ~120 packets per track' },
      backend: { ...P.backend, description: 'auto = Mediabunny demuxer, falling back to ffprobe (ffmpeg.wasm) for containers it does not read; ffmpeg forces ffprobe' },
    },
    required: ['input'],
  },
  examples: ['video.probe input=clip.mp4'],
  run: (a, ctx) => probeAny(a.input, ctx, { backend: a.backend, deep: a.deep }),
});

register({
  name: 'video.capabilities', readOnly: true,
  description: 'What this browser can do with video/audio: per codec (h264, hevc, vp8, vp9, av1; aac, opus, mp3, vorbis, flac, pcm) whether WebCodecs can decode and encode it, separately for any/hardware/software implementations (VideoEncoder/VideoDecoder.isConfigSupported at the given resolution), which audio encoders come from bundled WASM instead, which containers each backend writes, and whether the ffmpeg.wasm fallback is reachable. Use it to choose codecs before converting.',
  schema: {
    properties: {
      width: { type: 'integer', default: 1280, minimum: 16, maximum: 8192, description: 'Resolution to test video codecs at (hardware encoders have size limits)' },
      height: { type: 'integer', default: 720, minimum: 16, maximum: 8192, description: 'Resolution to test video codecs at' },
      loadFfmpeg: { type: 'boolean', default: false, description: 'Actually download and start ffmpeg.wasm (~31 MB) to prove it loads and report its version; default only checks that the files are reachable' },
    },
  },
  async run({ width, height, loadFfmpeg }, ctx) {
    const out = { webcodecs: { available: hasWebCodecs(), videoDecoder: typeof VideoDecoder !== 'undefined', videoEncoder: typeof VideoEncoder !== 'undefined', audioDecoder: typeof AudioDecoder !== 'undefined', audioEncoder: typeof AudioEncoder !== 'undefined' }, testedAt: `${width}x${height}`, video: {}, audio: {} };
    const STR = { h264: 'avc1.640028', hevc: 'hvc1.1.6.L120.B0', vp8: 'vp8', vp9: 'vp09.00.40.08', av1: 'av01.0.08M.08' };
    const sup = async (cls, cfg) => { try { return !!(await globalThis[cls].isConfigSupported(cfg)).supported; } catch { return false; } };
    for (const [name, codec] of Object.entries(STR)) {
      const e = {}, d = {};
      for (const [k, hw] of [['any', 'no-preference'], ['hardware', 'prefer-hardware'], ['software', 'prefer-software']]) {
        d[k] = out.webcodecs.videoDecoder && await sup('VideoDecoder', { codec, codedWidth: width, codedHeight: height, hardwareAcceleration: hw });
        e[k] = out.webcodecs.videoEncoder && await sup('VideoEncoder', { codec: name === 'h264' ? 'avc1.42E028' : codec, width, height, bitrate: 2_000_000, framerate: 30, hardwareAcceleration: hw });
        if (name === 'h264' && !e[k] && out.webcodecs.videoEncoder) e[k] = await sup('VideoEncoder', { codec, width, height, bitrate: 2_000_000, framerate: 30, hardwareAcceleration: hw });
      }
      out.video[name] = { decode: d, encode: e };
    }
    const lib = await mb().catch(() => null);
    for (const [name, codec] of Object.entries(A2MB)) {
      const dec = name === 'pcm' ? true : !!lib && await lib.canDecodeAudio(codec).catch(() => false);
      const wasm = audioEncoderKind(codec) === 'wasm';
      const enc = name === 'pcm' ? true : !wasm && !!lib && await lib.canEncodeAudio(codec).catch(() => false);
      out.audio[name] = { decode: dec, encode: enc || ['mp3', 'flac', 'aac'].includes(name) || name === 'vorbis', encoder: name === 'pcm' ? 'none (uncompressed)' : enc ? 'webcodecs' : ['mp3', 'flac', 'aac'].includes(name) ? 'bundled wasm (loaded on first use)' : name === 'vorbis' ? 'ffmpeg only' : null };
    }
    out.containers = { webcodecs: Object.keys(CONTAINERS).filter((k) => CONTAINERS[k].mbf), ffmpegOnly: Object.keys(CONTAINERS).filter((k) => !CONTAINERS[k].mbf), audio: Object.keys(AUDIO_FORMATS) };
    const ff = { loaded: ffLoaded(), threads: false, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' && !!globalThis.crossOriginIsolated, videoEncoders: Object.keys(FF_V), audioEncoders: Object.keys(FF_A), note: 'single-thread CPU build; no AV1 encoder and no AV1 decoder' };
    try { const r = await fetch(FF_URLS.wasm, { method: 'HEAD' }); ff.reachable = r.ok; ff.wasmBytes = Number(r.headers.get('content-length')) || null; } catch (e) { ff.reachable = false; ff.error = msgOf(e); }
    if (loadFfmpeg) {
      try { await ffLoad(ctx); const r = await ffJob(ctx, (job) => job.exec(['-hide_banner', '-version'], { allowFail: true })); ff.loaded = true; ff.version = (r.log.find((l) => /^ffmpeg version/.test(l)) || '').replace(/ Copyright.*/, '').trim() || null; } catch (e) { ff.loaded = false; ff.error = msgOf(e); }
    }
    out.ffmpeg = ff;
    return out;
  },
});

register({
  name: 'video.convert',
  description: `Convert a video to another container and/or codec, optionally resizing, changing frame rate or bitrate, trimming, rotating, cropping or muting in the same pass. Containers: mp4, mov, webm, mkv (WebCodecs or ffmpeg); avi, flv, ogv, ts (ffmpeg only). Transform order: rotate → crop → resize. Without any transform and with a compatible codec the streams are copied, not re-encoded. Returns {output, backend, hardwareAccelerated, videoCodec, audioCodec, videoReencoded, duration, video:{codec,width,height,fps,bitrate}, audio:{…}} — the video/audio blocks are measured from the written file. ${LIMITS}`,
  schema: {
    properties: {
      input: P.input(), output: P.output,
      format: { type: 'string', enum: ['auto', ...VIDEO_FORMATS], default: 'auto', description: 'Target container; auto = from the output extension, else mp4' },
      videoCodec: P.videoCodec, audioCodec: P.audioCodec, ...RESIZE,
      fps: { type: 'number', minimum: 1, maximum: 240, description: 'Output frame rate (frames are dropped or duplicated)' },
      videoBitrate: { type: 'number', minimum: 10, description: 'Target video bitrate in kbit/s (values above 4000 are read as bit/s)' },
      quality: P.quality,
      audioBitrate: { type: 'number', minimum: 6, description: 'Target audio bitrate in kbit/s' },
      start: P.start, end: P.end,
      rotate: { type: 'integer', enum: [0, 90, 180, 270], default: 0, description: 'Rotate clockwise by this many degrees (baked into the pixels)' },
      crop: { type: ['object', 'string'], description: 'Crop rectangle {x, y, width, height} in pixels of the (rotated) source frame, or the string "x,y,width,height"', properties: { x: { type: 'integer', description: 'Left edge' }, y: { type: 'integer', description: 'Top edge' }, width: { type: 'integer', description: 'Width' }, height: { type: 'integer', description: 'Height' } } },
      mute: { type: 'boolean', default: false, description: 'Drop the audio track' },
      backend: P.backend, hardware: P.hardware,
    },
    required: ['input'],
  },
  examples: ['video.convert input=clip.mov output=clip.webm', 'video.convert input=clip.mp4 format=mp4 width=1280 fps=30 quality=medium start=5 end=20', 'video.convert input=phone.mp4 rotate=90 crop=0,0,720,720 mute=true'],
  async run(a, ctx) {
    const src = await probeAny(a.input, ctx);
    if (!src.video) throw new Error(`"${a.input}" has no video track — for audio files use video.transcodeAudio`);
    const p = convertParams(a, src);
    return runConvert(p, ctx, src, vfs.out(a.output, a.input, 'convert', p.format));
  },
});

register({
  name: 'video.compress',
  description: `Make a video file smaller. Either give targetMB (the bitrate is computed from the duration, the picture is scaled down automatically when the budget is too tight, and the encode is repeated once or twice if it overshoots) or a preset (low ≈ 480p, medium ≈ 720p, high ≈ 1080p, never upscaling). Output is mp4/h264+aac unless format says otherwise. Returns {output, before, after, ratio, savedPercent, targetMet?, attempts, backend, hardwareAccelerated, video, audio}. ${LIMITS}`,
  schema: {
    properties: {
      input: P.input(), output: P.output,
      targetMB: { type: 'number', minimum: 0.05, description: 'Maximum output size in megabytes (MiB). Takes precedence over preset' },
      preset: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium', description: 'Quality preset used when targetMB is not given' },
      format: { type: 'string', enum: ['auto', 'mp4', 'webm', 'mov', 'mkv'], default: 'auto', description: 'Target container; auto = from the output extension, else mp4' },
      videoCodec: { ...P.videoCodec, enum: ['auto', 'h264', 'hevc', 'vp9', 'av1'], description: 'auto = container default (h264 for mp4, vp9 for webm). hevc/av1 compress better where the browser can encode them (see video.capabilities)' },
      maxWidth: { type: 'integer', minimum: 64, maximum: 8192, description: 'Cap the output width (never upscales); overrides the automatic choice' },
      fps: { type: 'number', minimum: 1, maximum: 120, description: 'Reduce the frame rate as well' },
      audioBitrate: { type: 'number', minimum: 6, description: 'Audio bitrate in kbit/s (default 96, or 64 when the size target is tight)' },
      mute: { type: 'boolean', default: false, description: 'Drop the audio track' },
      backend: P.backend, hardware: P.hardware,
    },
    required: ['input'],
  },
  examples: ['video.compress input=big.mp4 targetMB=8', 'video.compress input=big.mov preset=low'],
  async run(a, ctx) {
    const src = await probeAny(a.input, ctx);
    if (!src.video) throw new Error(`"${a.input}" has no video track`);
    const before = src.bytes, sv = src.video;
    const format = a.format !== 'auto' ? a.format : containerOf(a.output, 'mp4');
    if (!['mp4', 'webm', 'mov', 'mkv'].includes(format)) throw new Error('video.compress writes mp4, webm, mov or mkv');
    const outPath = vfs.out(a.output, a.input, 'small', format);
    const base = { input: a.input, backend: a.backend, hardware: a.hardware, format, vcodec: a.videoCodec !== 'auto' ? a.videoCodec : null, acodec: null, fps: a.fps, mute: a.mute || !src.audio, copy: 'never', rotate: 0, crop: null };
    const capW = (w) => (w && w < sv.width ? even(w) : undefined);
    if (!a.targetMB) {
      const PRE = { low: [854, 'low', 64], medium: [1280, 'medium', 96], high: [1920, 'high', 128] }[a.preset];
      const width = capW(a.maxWidth || (sv.width >= sv.height ? PRE[0] : Math.round(sv.width * PRE[0] / sv.height)));   // PRE[0] caps the long side
      const r = await runConvert({ ...base, width, quality: PRE[1], abitrate: kbps(a.audioBitrate || PRE[2]) }, ctx, src, outPath);
      const after = r.output.bytes;
      return { ...r, before, after, ratio: r3(after / before), savedPercent: r3(100 * (1 - after / before)), preset: a.preset, attempts: 1, ...(after >= before ? { note: 'the result is not smaller than the source — it was already compressed harder than this preset; try targetMB or a lower preset' } : {}) };
    }
    const target = a.targetMB * 1048576, dur = src.duration;
    if (!(dur > 0)) throw new Error('cannot size-target a file without a known duration');
    const total = target * 8 / dur * 0.96;                       // 4 % for container overhead
    let abr = base.mute ? 0 : kbps(a.audioBitrate) || (total < 400000 ? 64000 : 96000);
    if (abr > total * 0.4) abr = Math.max(16000, Math.round(total * 0.25));
    let vbr = total - abr;
    if (vbr < 20000) throw new Error(`targetMB=${a.targetMB} is too small for ${dur}s of video (only ${Math.round(total / 1000)} kbit/s in total) — raise the target, trim the clip, or mute it`);
    const fps = a.fps || sv.fps || 30;
    let width = capW(a.maxWidth);
    if (!a.maxWidth) { // keep ≥ ~0.045 bits per pixel per frame, otherwise the picture turns to mush: shrink instead
      const bpp = vbr / (sv.width * sv.height * fps);
      if (bpp < 0.045) width = capW(Math.max(160, sv.width * Math.sqrt(bpp / 0.045)));
    }
    let r = null, attempts = 0;
    for (; attempts < 3;) {
      attempts++;
      r = await runConvert({ ...base, width, vbitrate: Math.round(vbr), abitrate: abr || undefined }, ctx, src, outPath);
      if (r.output.bytes <= target) break;
      vbr = Math.max(15000, vbr * (target / r.output.bytes) * 0.93);
      ctx.log(`attempt ${attempts}: ${r.output.bytes} bytes > target ${Math.round(target)}; retrying at ${Math.round(vbr / 1000)} kbit/s`);
    }
    const after = r.output.bytes;
    return { ...r, before, after, ratio: r3(after / before), savedPercent: r3(100 * (1 - after / before)), targetBytes: Math.round(target), targetMet: after <= target, attempts, requestedVideoBitrate: Math.round(vbr), ...(after > target ? { note: 'still above the target after 3 attempts (encoders overshoot at very low bitrates) — lower maxWidth or fps' } : {}) };
  },
});

register({
  name: 'video.trim',
  description: `Cut a time range out of a video or audio file, keeping container and codecs. mode=auto is frame-accurate: streams are copied when the cut allows it and re-encoded otherwise; mode=copy never re-encodes (fastest, lossless) but the cut snaps to the surrounding keyframes, so the result can start a little early; mode=reencode always re-encodes. Returns {output, backend, videoReencoded, duration, video, audio}. ${LIMITS}`,
  schema: {
    properties: {
      input: P.input('video or audio file'), output: P.output, start: P.start, end: P.end,
      duration: { type: 'number', minimum: 0.01, description: 'Length in seconds, as an alternative to end' },
      mode: { type: 'string', enum: ['auto', 'copy', 'reencode'], default: 'auto', description: 'auto = exact cut, copying when possible; copy = keyframe-aligned stream copy; reencode = always re-encode' },
      backend: P.backend, hardware: P.hardware,
    },
    required: ['input'],
  },
  examples: ['video.trim input=clip.mp4 start=12.5 end=20', 'video.trim input=talk.webm start=60 duration=30 mode=copy'],
  async run(a, ctx) {
    const src = await probeAny(a.input, ctx);
    const start = a.start || 0, end = a.end ?? (a.duration ? start + a.duration : undefined);
    if (a.start === undefined && end === undefined) throw new Error('give start and/or end (or duration)');
    let format = containerOf(a.output, null) || (src.container === 'matroska' ? 'mkv' : src.container), table = CONTAINERS;
    if (!src.video && AUDIO_FORMATS[format === 'mp4' ? 'm4a' : format]) { format = format === 'mp4' ? 'm4a' : format; table = AUDIO_FORMATS; }
    if (!table[format]) format = src.video ? 'mp4' : 'm4a', table = src.video ? CONTAINERS : AUDIO_FORMATS;
    const p = { input: a.input, backend: a.backend, hardware: a.hardware, format, table, vcodec: null, acodec: null, start, end, rotate: 0, crop: null, mute: false, noVideo: !src.video, copy: a.mode === 'copy' ? 'forced' : a.mode === 'reencode' ? 'never' : 'auto' };
    const ext = a.output ? vfs.extOf(a.output) : vfs.extOf(a.input) || format;
    const r = await runConvert(p, ctx, src, vfs.out(a.output, a.input, 'trim', ext));
    return { ...r, requested: { start, end: end ?? src.duration }, mode: a.mode };
  },
});

register({
  name: 'video.concat',
  description: `Join several videos end to end into one file. mode=reencode (default) decodes every clip and re-encodes onto one canvas (size of the first clip unless width/height are given; others are letterboxed), so clips may differ in codec, size and frame rate; clips without audio get silence. mode=copy joins without re-encoding (ffmpeg concat demuxer) and requires all clips to share codec, resolution and audio layout. Returns {output, backend, hardwareAccelerated, clips, duration, video, audio}. ${LIMITS}`,
  schema: {
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 2, description: 'VFS paths of the clips, in playback order' },
      output: P.output,
      mode: { type: 'string', enum: ['reencode', 'copy'], default: 'reencode', description: 'reencode = works for any mix of clips; copy = lossless and fast but only for same-format clips (ffmpeg backend)' },
      format: { type: 'string', enum: ['auto', 'mp4', 'webm', 'mov', 'mkv'], default: 'auto', description: 'Target container; auto = from the output extension, else that of the first clip, else mp4' },
      videoCodec: { ...P.videoCodec, enum: ['auto', 'h264', 'hevc', 'vp8', 'vp9', 'av1'], description: 'Video codec when re-encoding (auto = container default)' },
      width: RESIZE.width, height: RESIZE.height,
      fps: { type: 'number', minimum: 1, maximum: 120, description: 'Force a constant output frame rate (default: keep each clip\'s own timing)' },
      quality: { ...P.quality, default: 'medium' },
      backend: P.backend, hardware: P.hardware,
    },
    required: ['inputs'],
  },
  examples: ['video.concat inputs=a.mp4,b.mp4,c.mp4 output=joined.mp4', 'video.concat inputs=part1.mp4,part2.mp4 mode=copy'],
  async run(a, ctx) {
    if (a.inputs.length < 2) throw new Error('give at least two inputs');
    if (a.inputs.length > 64) throw new Error('at most 64 clips per call');
    const infos = [];
    for (const path of a.inputs) { const i = await probeAny(path, ctx); if (!i.video) throw new Error(`"${path}" has no video track`); infos.push(i); }
    const first = infos[0];
    const format = a.format !== 'auto' ? a.format : containerOf(a.output, null) || (['mp4', 'webm', 'mov', 'mkv'].includes(first.container) ? first.container : 'mp4');
    const outPath = vfs.out(a.output, a.inputs, 'concat', format);
    const size = planSize(first.video, { width: a.width, height: a.height });
    const anyAudio = infos.some((i) => i.audio), fa = infos.find((i) => i.audio)?.audio;
    const total = infos.reduce((s, i) => s + i.duration, 0);
    const vcodec = a.videoCodec !== 'auto' ? a.videoCodec : null;
    const ffCopy = () => ffJob(ctx, async (job) => {
      const list = a.inputs.map((p) => `file '${job.input(p)}'`).join('\n'), lf = job.tmp('list.txt'), out = job.tmp(`out.${format}`);
      await job.write(lf, list + '\n');
      await job.exec(['-f', 'concat', '-safe', '0', '-i', lf, '-c', 'copy', '-f', CONTAINERS[format].ff, ...(format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : []), out], { duration: total });
      return { bytes: await job.read(out), info: { backend: 'ffmpeg', hardwareAccelerated: false, videoReencoded: false } };
    });
    const ffEnc = (reason) => ffJob(ctx, async (job) => {
      const args = []; const fc = []; const fps = a.fps || first.video.fps || 30, sr = fa?.sampleRate || 48000;
      const cont = CONTAINERS[format], vc = vcodec || cont.v[0], ac = cont.a[0];
      if (!FF_V[vc] || vc === 'av1') throw new Error(`ffmpeg cannot encode ${vc}`);
      infos.forEach((info, i) => {
        args.push('-i', job.input(a.inputs[i]));
        fc.push(`[${i}:v:0]scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`);
        if (anyAudio) fc.push(info.audio ? `[${i}:a:0]aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]` : `anullsrc=r=${sr}:cl=stereo,atrim=duration=${info.duration}[a${i}]`);
      });
      fc.push(`${infos.map((_, i) => `[v${i}]${anyAudio ? `[a${i}]` : ''}`).join('')}concat=n=${infos.length}:v=1:a=${anyAudio ? 1 : 0}[v]${anyAudio ? '[a]' : ''}`);
      const out = job.tmp(`out.${format}`);
      args.push('-filter_complex', fc.join(';'), '-map', '[v]', ...(anyAudio ? ['-map', '[a]', '-c:a', ...FF_A[ac], '-strict', '-2'] : []), '-c:v', ...FF_V[vc]);
      if (FF_CRF[vc]) { args.push('-crf', String(FF_CRF[vc][QUALITIES.indexOf(a.quality)])); if (vc === 'vp9') args.push('-b:v', '0'); if (vc === 'vp8') args.push('-b:v', '4M'); }
      args.push('-f', cont.ff, ...(format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : []), out);
      await job.exec(args, { duration: total });
      return { bytes: await job.read(out), info: { backend: 'ffmpeg', hardwareAccelerated: false, videoReencoded: true, videoCodec: vc, ...(reason ? { fallbackReason: reason } : {}) } };
    });
    let res;
    if (a.mode === 'copy') {
      if (a.backend === 'webcodecs') throw new Error('mode=copy is done by the ffmpeg backend (concat demuxer); use backend=auto or ffmpeg, or mode=reencode for WebCodecs');
      res = await ffCopy();
    } else {
      res = await pick(a.backend, ctx, () => {
        a.inputs.forEach((p) => guard(p));
        return pipelineWC(infos.map((info, i) => ({ path: a.inputs[i], info })), { format, vcodec, width: size.width, height: size.height, fps: a.fps, quality: a.quality, hardware: a.hardware, audio: anyAudio, sampleRate: fa?.sampleRate || 48000, channels: Math.min(2, fa?.channels || 2) }, ctx);
      }, ffEnc, { ffOnly: infos.some((i) => i.backend === 'ffmpeg') ? 'at least one clip is in a container only ffmpeg reads' : null });
    }
    const { stat, info } = await finish(outPath, res.bytes, CONTAINERS[format].mime);
    ctx.progress(1, 'done');
    return { output: stat, ...res.info, mode: a.mode, clips: infos.length, expectedDuration: r3(total), ...brief(info) };
  },
});

register({
  name: 'video.speed',
  description: `Speed a video up or slow it down (factor 2 = twice as fast, 0.5 = half speed). WebCodecs backend: audio is resampled, so its pitch rises/falls with the tempo (or drop it with audio=drop). ffmpeg backend: audio keeps its pitch (atempo filter) — choose backend=ffmpeg when speech must stay natural. When speeding up, frames are dropped so the frame rate does not exceed the source's. Returns {output, factor, audioMethod, backend, duration, video, audio}. ${LIMITS}`,
  schema: {
    properties: {
      input: P.input(), output: P.output,
      factor: { type: 'number', minimum: 0.1, maximum: 20, description: 'Speed multiplier: >1 faster (timelapse), <1 slower (slow motion)' },
      audio: { type: 'string', enum: ['auto', 'drop'], default: 'auto', description: 'auto = keep audio at the new tempo (pitch shifts on webcodecs, pitch preserved on ffmpeg); drop = no audio' },
      quality: { ...P.quality, default: 'medium' },
      backend: P.backend, hardware: P.hardware,
    },
    required: ['input', 'factor'],
  },
  examples: ['video.speed input=clip.mp4 factor=4 audio=drop', 'video.speed input=talk.mp4 factor=1.5 backend=ffmpeg'],
  async run(a, ctx) {
    const src = await needVideo(a, ctx);
    if (a.factor === 1) throw new Error('factor=1 would change nothing');
    const format = containerOf(a.output, null) || (['mp4', 'webm', 'mov', 'mkv'].includes(src.container) ? src.container : 'mp4');
    if (!CONTAINERS[format].mbf && a.backend === 'webcodecs') throw new Error(`.${format} needs backend=ffmpeg`);
    const outPath = vfs.out(a.output, a.input, `x${a.factor}`, format);
    const keepAudio = a.audio !== 'drop' && !!src.audio, size = planSize(src.video, {}), fps = src.video.fps || 30;
    const res = await pick(a.backend, ctx, () => {
      guard(a.input);
      return pipelineWC([{ path: a.input, info: src, speed: a.factor }], { format, width: size.width, height: size.height, quality: a.quality, hardware: a.hardware, audio: keepAudio, sampleRate: src.audio?.sampleRate || 48000, channels: Math.min(2, src.audio?.channels || 2), maxFps: a.factor > 1 ? Math.max(fps, 24) : 0 }, ctx)
        .then((r) => ({ ...r, info: { ...r.info, audioMethod: keepAudio ? 'resampled (pitch shifts with tempo)' : 'none' } }));
    }, (reason) => ffJob(ctx, async (job) => {
      const cont = CONTAINERS[format], vc = cont.v[0], out = job.tmp(`out.${format}`);
      const tempo = []; let f = a.factor; while (f > 2) { tempo.push('atempo=2.0'); f /= 2; } while (f < 0.5) { tempo.push('atempo=0.5'); f /= 0.5; } tempo.push(`atempo=${f}`);
      const args = ['-i', job.input(a.input), '-sn', '-dn', '-vf', `setpts=PTS/${a.factor},fps=${r3(a.factor > 1 ? Math.max(fps, 24) : fps)},scale=trunc(iw/2)*2:trunc(ih/2)*2`, '-c:v', ...FF_V[vc]];
      if (FF_CRF[vc]) { args.push('-crf', String(FF_CRF[vc][QUALITIES.indexOf(a.quality)])); if (vc === 'vp9') args.push('-b:v', '0'); if (vc === 'vp8') args.push('-b:v', '4M'); }
      if (keepAudio) args.push('-af', tempo.join(','), '-c:a', ...FF_A[cont.a[0]], '-strict', '-2'); else args.push('-an');
      args.push('-f', cont.ff, ...(format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : []), out);
      await job.exec(args, { duration: src.duration });
      return { bytes: await job.read(out), info: { backend: 'ffmpeg', hardwareAccelerated: false, videoCodec: vc, audioMethod: keepAudio ? 'atempo (pitch preserved)' : 'none', ...(reason ? { fallbackReason: reason } : {}) } };
    }), { ffOnly: src.backend === 'ffmpeg' ? `the input container (${src.container}) is only readable by ffmpeg` : !CONTAINERS[format].mbf ? `.${format} is written by ffmpeg only` : null });
    const { stat, info } = await finish(outPath, res.bytes, CONTAINERS[format].mime);
    ctx.progress(1, 'done');
    return { output: stat, ...res.info, factor: a.factor, sourceDuration: src.duration, expectedDuration: r3(src.duration / a.factor), ...brief(info) };
  },
});

register({
  name: 'video.frames',
  description: 'Extract still frames from a video into image files: at explicit timestamps, every N seconds, or N frames evenly spaced over the clip (or over start..end). Each output stat carries its `time`. Use this to look at specific moments; for an overview in ONE image use video.contactSheet. At most 300 frames per call; the result lists the first 50 stats (truncated=true beyond that — the rest follow the same naming pattern). Returns {outputs[], count, times[], pattern, backend, hardwareAccelerated}.',
  schema: {
    properties: {
      input: P.input(),
      timestamps: { type: 'array', items: { type: 'number' }, description: 'Exact times in seconds; the frame shown at each time is taken' },
      every: { type: 'number', minimum: 0.01, description: 'Take one frame every this many seconds' },
      count: { type: 'integer', minimum: 1, maximum: 300, description: 'Take this many frames, evenly spaced (default 8 when neither timestamps nor every is given)' },
      start: P.start, end: P.end,
      width: { type: 'integer', minimum: 8, maximum: 8192, description: 'Frame width in pixels (default: native; aspect ratio kept unless height is also given)' },
      height: { type: 'integer', minimum: 8, maximum: 8192, description: 'Frame height in pixels' },
      format: { type: 'string', enum: ['png', 'jpg', 'webp'], default: 'jpg', description: 'Image format (png is lossless and several times larger)' },
      quality: { type: 'number', default: 0.9, minimum: 0.1, maximum: 1, description: 'JPEG/WebP quality' },
      prefix: { type: 'string', description: 'Output name prefix; files are <prefix>-0001.<ext>, … (default: <input stem>.frame)' },
      backend: P.backend, hardware: P.hardware,
    },
    required: ['input'],
  },
  examples: ['video.frames input=clip.mp4 count=6', 'video.frames input=clip.mp4 timestamps=1.5,3,10 format=png', 'video.frames input=clip.mp4 every=2 width=640'],
  async run(a, ctx) {
    const src = await needVideo(a, ctx);
    const { start, end } = rangeOf(a, src);
    let times;
    if (a.timestamps?.length) { times = a.timestamps.map(Number); const bad = times.find((t) => !(t >= 0) || t > src.duration + 0.001); if (bad !== undefined) throw new Error(`timestamp ${bad} is outside the video (0…${src.duration}s)`); times = times.map((t) => Math.min(t, Math.max(0, src.duration - 0.001))); }
    else if (a.every) { times = []; for (let t = start; t < end - 1e-6; t += a.every) times.push(r3(t)); }
    else times = spread(a.count || 8, start, end);
    if (times.length > 300) throw new Error(`${times.length} frames requested — the limit is 300 per call (raise "every", narrow start/end, or use count)`);
    const size = frameSize(src.video, a);
    const prefix = a.prefix || `${vfs.stemOf(a.input)}.frame`, ext = a.format, digits = Math.max(4, String(times.length).length);
    const outputs = []; const got = [];
    const c = canvasOf(size.width, size.height), g = c.getContext('2d');
    const r = await grabFrames(a.input, src, times, size, a, ctx, async (srcImg, time, i, actual) => {
      g.clearRect(0, 0, c.width, c.height); g.drawImage(srcImg, 0, 0, c.width, c.height);
      const { bytes, mime } = await canvasBytes(c, ext, a.quality);
      const stat = await vfs.write(`${prefix}-${String(i + 1).padStart(digits, '0')}.${ext}`, bytes, { mime, meta: { width: c.width, height: c.height, time: r3(time), frameTime: r3(actual) } });
      got.push(r3(time)); if (outputs.length < 50) outputs.push(stat);
    });
    if (!got.length) throw new Error('no frame could be decoded at the requested times');
    return { outputs, count: got.length, requested: times.length, truncated: got.length > outputs.length || undefined, times: got.slice(0, 300), pattern: `${prefix}-${'N'.repeat(digits)}.${ext}`, width: size.width, height: size.height, backend: r.backend, hardwareAccelerated: r.hardwareAccelerated, ...(r.fallbackReason ? { fallbackReason: r.fallbackReason } : {}) };
  },
});

register({
  name: 'video.thumbnail',
  description: 'One representative still image of a video. time=auto (default) looks at several moments and picks the frame with the most detail (skipping black/blank frames such as fade-ins); or give an exact time in seconds. Returns {output, time, width, height, backend, hardwareAccelerated}.',
  schema: {
    properties: {
      input: P.input(), output: { type: 'string', description: 'VFS path to write (default: <input stem>.thumb.jpg); the extension (jpg/png/webp) selects the format' },
      time: { type: ['string', 'number'], default: 'auto', description: 'Time in seconds, or "auto" to pick an informative frame' },
      width: { type: 'integer', minimum: 8, maximum: 8192, description: 'Thumbnail width (default: min(native, 640)); aspect ratio kept unless height is also given' },
      height: { type: 'integer', minimum: 8, maximum: 8192, description: 'Thumbnail height' },
      quality: { type: 'number', default: 0.9, minimum: 0.1, maximum: 1, description: 'JPEG/WebP quality' },
      backend: P.backend, hardware: P.hardware,
    },
    required: ['input'],
  },
  examples: ['video.thumbnail input=clip.mp4', 'video.thumbnail input=clip.mp4 time=12.5 width=1280 output=poster.png'],
  async run(a, ctx) {
    const src = await needVideo(a, ctx);
    const size = frameSize(src.video, a, 640);
    const out = vfs.out(a.output, a.input, 'thumb', 'jpg');
    const fmt = ['png', 'webp'].includes(vfs.extOf(out)) ? vfs.extOf(out) : 'jpeg';
    let time, candidates;
    if (a.time === 'auto' || a.time === undefined || a.time === '') {
      const first = src.video.start > 0 ? src.video.start : 0;
      const cand = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((f) => r3(first + (src.duration - first) * f));
      const small = { width: 96, height: Math.max(8, Math.round(96 * size.height / size.width)) };
      const sc = canvasOf(small.width, small.height), sg = sc.getContext('2d', { willReadFrequently: true });
      candidates = [];
      await grabFrames(a.input, src, cand, small, a, ctx, async (img, t) => {
        sg.drawImage(img, 0, 0, small.width, small.height);
        const d = sg.getImageData(0, 0, small.width, small.height).data, w = small.width, h = small.height, y = new Float32Array(w * h); let s = 0, e = 0;
        for (let i = 0, j = 0; i < d.length; i += 4, j++) { y[j] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; s += y[j]; }
        for (let r = 0; r < h - 1; r++) for (let q = 0; q < w - 1; q++) { const k = r * w + q; e += Math.min(40, Math.abs(y[k + 1] - y[k])) + Math.min(40, Math.abs(y[k + w] - y[k])); }   // clipped so letterbox bars and title text do not dominate
        const mean = s / (w * h), detail = e / ((w - 1) * (h - 1));
        candidates.push({ time: t, brightness: r3(mean), detail: r3(detail), score: r3(detail * (mean < 30 ? mean / 30 : mean > 235 ? (255 - mean) / 20 : 1)) });
      }, [0, 0.7]);
      if (!candidates.length) throw new Error('no frame could be decoded');
      time = candidates.reduce((b, c) => (c.score > b.score ? c : b)).time;
    } else { time = Number(a.time); if (!(time >= 0) || time > src.duration) throw new Error(`time must be "auto" or a number of seconds within 0…${src.duration}`); time = Math.min(time, Math.max(0, src.duration - 0.001)); }
    let stat = null;
    const r = await grabFrames(a.input, src, [time], size, a, ctx, async (img, t, i, actual) => {
      const c = canvasOf(size.width, size.height); c.getContext('2d').drawImage(img, 0, 0, size.width, size.height);
      const { bytes, mime } = await canvasBytes(c, fmt, a.quality);
      stat = await vfs.write(out, bytes, { mime, meta: { width: size.width, height: size.height, time: r3(actual) } });
    }, [0.7, 1]);
    if (!stat) throw new Error(`no frame could be decoded at ${time}s`);
    return { output: stat, time: r3(time), width: size.width, height: size.height, ...(candidates ? { picked: 'auto (most edge detail among the candidates, dark frames penalised)', candidates } : {}), backend: r.backend, hardwareAccelerated: r.hardwareAccelerated, ...(r.fallbackReason ? { fallbackReason: r.fallbackReason } : {}) };
  },
});

register({
  name: 'video.contactSheet',
  description: 'Watch a video in ONE image: N evenly spaced frames tiled in reading order (left→right, top→bottom), each stamped with its index and timestamp, under a header line with file name, resolution, fps, duration and codecs. This is the tool for letting a vision model see what happens in a video — look at the sheet, then pull exact moments with video.frames or cut with video.trim using the printed times. Defaults fit one ≈1568 px wide image (12 frames, 3–4 columns); use start/end to zoom into a section, or more frames for long videos. Returns {output, columns, rows, tile, frames:[{index, time, x, y}], interval, backend, hardwareAccelerated}.',
  schema: {
    properties: {
      input: P.input(), output: { type: 'string', description: 'VFS path to write (default: <input stem>.sheet.jpg); extension jpg/png/webp selects the format' },
      count: { type: 'integer', default: 12, minimum: 1, maximum: 120, description: 'Number of frames' },
      columns: { type: 'integer', minimum: 1, maximum: 20, description: 'Tiles per row (default: chosen so the sheet is roughly 3:2)' },
      width: { type: 'integer', default: 1568, minimum: 200, maximum: 8192, description: 'Total sheet width in pixels; tiles are scaled to fit (never above native size)' },
      start: P.start, end: P.end,
      timestamps: { type: 'array', items: { type: 'number' }, description: 'Use these exact times instead of evenly spaced ones' },
      labels: { type: 'boolean', default: true, description: 'Burn "index · m:ss.s" into the top-left corner of every tile' },
      header: { type: 'boolean', default: true, description: 'Add the header line describing the file' },
      quality: { type: 'number', default: 0.88, minimum: 0.1, maximum: 1, description: 'JPEG/WebP quality' },
      backend: P.backend, hardware: P.hardware,
    },
    required: ['input'],
  },
  examples: ['video.contactSheet input=clip.mp4', 'video.contactSheet input=lecture.mp4 count=30 columns=6', 'video.contactSheet input=clip.mp4 start=40 end=55 count=9'],
  async run(a, ctx) {
    const src = await needVideo(a, ctx);
    const sv = src.video;
    const { start, end } = rangeOf(a, src);
    const times = a.timestamps?.length ? a.timestamps.map((t) => Math.min(Math.max(0, Number(t)), Math.max(0, src.duration - 0.001))) : spread(a.count, start, end);
    if (times.length > 120) throw new Error('at most 120 frames per sheet');
    const n = times.length, aspect = sv.width / sv.height, gap = 6, pad = 10;
    let cols = a.columns;
    if (!cols) { let best = Infinity; for (let c = 1; c <= n; c++) { const rows = Math.ceil(n / c); const score = Math.abs(Math.log((c * aspect) / rows / 1.5)) + (c * rows - n) * 0.08; if (score < best - 1e-9) { best = score; cols = c; } } }
    cols = Math.min(cols, n);
    const rows = Math.ceil(n / cols);
    const tw = Math.max(16, Math.min(sv.width, Math.floor((a.width - 2 * pad - (cols - 1) * gap) / cols))), th = Math.max(16, Math.round(tw / aspect));
    const W = 2 * pad + cols * tw + (cols - 1) * gap;
    const fs = Math.max(11, Math.min(26, Math.round(tw / 17)));
    const hfs = Math.max(12, Math.min(22, Math.round(W / 70)));
    const headH = a.header ? hfs * 2 + 6 : 0;
    const H = headH + 2 * pad + rows * th + (rows - 1) * gap;
    if (W * H > 60e6) throw new Error('sheet would be too large — lower width or count');
    const c = canvasOf(W, H), g = c.getContext('2d');
    g.fillStyle = '#101214'; g.fillRect(0, 0, W, H);
    const font = (px, bold) => `${bold ? '600 ' : ''}${px}px ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;
    if (a.header) {
      g.textBaseline = 'middle'; g.font = font(hfs, true); g.fillStyle = '#f2f2f2';
      const name = a.input.split('/').pop();
      const info = [`${sv.width}×${sv.height}`, sv.fps ? `${Math.round(sv.fps * 100) / 100} fps` : null, fmtTime(src.duration), [sv.codec, src.audio?.codec].filter(Boolean).join('+'), `${n} frames${a.timestamps?.length ? '' : ` · every ${fmtTime((end - start) / n)}`}${start > 0.01 || end < src.duration - 0.01 ? ` · ${fmtTime(start)}–${fmtTime(end)}` : ''}`].filter(Boolean).join('  ·  ');
      let title = name; while (title.length > 8 && g.measureText(title).width > W * 0.32) title = title.slice(0, -2); if (title !== name) title += '…';
      g.fillText(title, pad, pad + hfs);
      const x0 = pad + g.measureText(title).width + hfs;
      g.font = font(Math.round(hfs * 0.86), false); g.fillStyle = '#a8b0b8';
      let line = info; while (line.length > 10 && g.measureText(line).width > W - x0 - pad) line = line.slice(0, -2);
      g.fillText(line, x0, pad + hfs);
    }
    const frames = []; const have = new Set();
    const place = (i) => ({ x: pad + (i % cols) * (tw + gap), y: headH + pad + Math.floor(i / cols) * (th + gap) });
    const label = (i, text, miss) => {
      const { x, y } = place(i);
      g.font = font(fs, true); g.textBaseline = 'middle';
      const w = g.measureText(text).width + fs * 0.9, h = Math.round(fs * 1.55);
      g.fillStyle = miss ? 'rgba(120,20,20,0.85)' : 'rgba(0,0,0,0.72)'; g.fillRect(x, y, w, h);
      g.fillStyle = '#ffffff'; g.fillText(text, x + fs * 0.45, y + h / 2 + 1);
    };
    const r = await grabFrames(a.input, src, times, { width: tw, height: th }, a, ctx, async (img, time, i) => {
      const { x, y } = place(i);
      g.drawImage(img, x, y, tw, th); have.add(i);
      frames.push({ index: i + 1, time: r3(time), x, y });
    });
    if (!have.size) throw new Error('no frame could be decoded');
    for (let i = 0; i < n; i++) {
      if (!have.has(i)) { const { x, y } = place(i); g.fillStyle = '#2a2d31'; g.fillRect(x, y, tw, th); }
      if (a.labels || !have.has(i)) label(i, `${i + 1} · ${fmtTime(times[i])}${have.has(i) ? '' : ' (no frame)'}`, !have.has(i));
    }
    const out = vfs.out(a.output, a.input, 'sheet', 'jpg');
    const fmt = ['png', 'webp'].includes(vfs.extOf(out)) ? vfs.extOf(out) : 'jpeg';
    const { bytes, mime } = await canvasBytes(c, fmt, a.quality);
    const stat = await vfs.write(out, bytes, { mime, meta: { width: W, height: H } });
    return { output: stat, columns: cols, rows, tile: { width: tw, height: th }, count: have.size, interval: a.timestamps?.length ? null : r3((end - start) / n), range: { start: r3(start), end: r3(end) }, duration: src.duration, frames: frames.slice(0, 120), backend: r.backend, hardwareAccelerated: r.hardwareAccelerated, ...(r.fallbackReason ? { fallbackReason: r.fallbackReason } : {}) };
  },
});

register({
  name: 'video.toGif',
  description: `Turn a video (or a section of it) into an animated GIF with a proper optimised colour palette (ffmpeg palettegen/paletteuse — far better than a fixed palette). GIF encoding always runs in ffmpeg.wasm (CPU, ~31 MB download on first use); backend only chooses who DECODES the video: ffmpeg (default) or webcodecs (hardware decode; needed for AV1, which ffmpeg.wasm cannot decode). GIFs are big: keep it short (default limit 15 s unless end is given), ≤ 15 fps and ≤ 640 px wide. Returns {output, frames, fps, width, height, colors, bytes, backend}.`,
  schema: {
    properties: {
      input: P.input(), output: P.output,
      fps: { type: 'number', default: 12, minimum: 1, maximum: 50, description: 'Frames per second of the GIF' },
      width: { type: 'integer', default: 480, minimum: 16, maximum: 1920, description: 'GIF width in pixels (height follows the aspect ratio; never upscaled)' },
      start: P.start, end: P.end,
      palette: { type: 'string', enum: ['global', 'perFrame', 'none'], default: 'global', description: 'global = one optimised 256-colour palette for the whole clip (best size/quality trade-off); perFrame = a new palette for every frame (best colours for varied scenes, larger file); none = ffmpeg\'s generic palette (fast, visibly worse)' },
      colors: { type: 'integer', default: 256, minimum: 2, maximum: 256, description: 'Palette size; fewer colours = smaller file' },
      dither: { type: 'string', enum: ['sierra2_4a', 'floyd_steinberg', 'bayer', 'none'], default: 'sierra2_4a', description: 'Dithering: sierra2_4a/floyd_steinberg = smooth gradients; bayer = ordered pattern (compresses better); none = flat colours (smallest)' },
      loop: { type: 'integer', default: 0, minimum: -1, maximum: 65535, description: '0 = loop forever, -1 = play once, n = repeat n times' },
      backend: { ...P.backend, description: 'Who decodes the source: auto = ffmpeg, or WebCodecs when ffmpeg cannot decode it (AV1) or cannot read it; the GIF itself is always written by ffmpeg' },
    },
    required: ['input'],
  },
  examples: ['video.toGif input=clip.mp4 start=2 end=6 width=360 fps=10', 'video.toGif input=clip.webm palette=perFrame dither=bayer colors=128'],
  async run(a, ctx) {
    const src = await needVideo(a, ctx);
    const sv = src.video;
    const start = a.start || 0, end = Math.min(src.duration, a.end ?? start + 15);
    if (!(end > start)) throw new Error(`empty time range: start=${start} end=${end}`);
    const dur = end - start, w = Math.min(a.width, sv.width), h = Math.max(2, Math.round(sv.height * w / sv.width));
    const nFrames = Math.ceil(dur * a.fps);
    if (nFrames > 1500) throw new Error(`${nFrames} frames is too much for a GIF — shorten the range or lower fps`);
    if (a.palette === 'global' && nFrames * w * h * 4 > 900e6) throw new Error(`a global palette needs all ${nFrames} frames in memory (${Math.round(nFrames * w * h * 4 / 1e6)} MB) — lower width/fps, shorten the range, or use palette=perFrame`);
    const out = vfs.out(a.output, a.input, 'anim', 'gif');
    const use = `paletteuse=dither=${a.dither}${a.dither === 'bayer' ? ':bayer_scale=3' : ''}`;
    const graph = (pre) => (a.palette === 'none' ? (pre || 'null')
      : a.palette === 'perFrame' ? `${pre ? pre + ',' : ''}split[a][b];[a]palettegen=max_colors=${a.colors}:stats_mode=single[p];[b][p]${use}:new=1`
        : `${pre ? pre + ',' : ''}split[a][b];[a]palettegen=max_colors=${a.colors}:stats_mode=diff[p];[b][p]${use}:diff_mode=rectangle`);
    const viaFF = (reason) => ffJob(ctx, async (job) => {
      const o = job.tmp('out.gif');
      await job.exec(['-ss', String(start), '-t', String(dur), '-i', job.input(a.input), '-an', '-sn', '-filter_complex', `[0:v:0]${graph(`fps=${a.fps},scale=${w}:${h}:flags=lanczos`)}`, '-loop', String(a.loop), '-f', 'gif', o], { duration: dur });
      return { bytes: await job.read(o), backend: 'ffmpeg', hardwareAccelerated: false, ...(reason ? { fallbackReason: reason } : {}) };
    });
    const viaWC = async () => {
      if (nFrames * w * h * 4 > 1200e6) throw new Error('too many pixels for the webcodecs decode path — lower width/fps or shorten the range');
      let raw; try { raw = new Uint8Array(nFrames * w * h * 4); } catch (e) { throw oom(e); }
      const times = []; for (let i = 0; i < nFrames; i++) times.push(start + i / a.fps);
      const c = canvasOf(w, h), g = c.getContext('2d', { willReadFrequently: true }); let last = -1;
      const r = await grabFrames(a.input, src, times, { width: w, height: h }, { ...a, backend: 'webcodecs' }, ctx, async (img, t, i) => {
        g.drawImage(img, 0, 0, w, h); const d = g.getImageData(0, 0, w, h).data;
        for (let k = last + 1; k <= i; k++) raw.set(d, k * w * h * 4); last = i;       // repeat into any gap left by missing frames
      }, [0, 0.6]);
      if (last < 0) throw new Error('no frame could be decoded');
      const count = last + 1;
      const bytes = await ffJob(ctx, async (job, f) => {
        const rf = job.tmp('frames.rgba'), o = job.tmp('out.gif');
        await f.writeFile(rf, count === nFrames ? raw : raw.slice(0, count * w * h * 4)); raw = null;
        await job.exec(['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${w}x${h}`, '-framerate', String(a.fps), '-i', rf, '-filter_complex', `[0:v:0]${graph('')}`, '-loop', String(a.loop), '-f', 'gif', o], { duration: dur, span: [0.6, 1] });
        return job.read(o);
      });
      return { bytes, backend: 'webcodecs+ffmpeg', hardwareAccelerated: r.hardwareAccelerated, decode: 'webcodecs', encode: 'ffmpeg' };
    };
    let res;
    if (a.backend === 'webcodecs') res = await viaWC();
    else if (a.backend === 'ffmpeg') res = await viaFF();
    else if (sv.codec === 'av1' && src.backend === 'webcodecs' && sv.canDecode) res = await viaWC();
    else { try { res = await viaFF(); } catch (e) { if (src.backend !== 'webcodecs' || !sv.canDecode || /could not be loaded|crashed/.test(msgOf(e))) throw e; ctx.warn(`ffmpeg could not decode the source (${msgOf(e).slice(0, 120)}); decoding with WebCodecs instead`); res = await viaWC(); } }
    const { bytes, ...info } = res;
    const stat = await vfs.write(out, bytes, { mime: 'image/gif', meta: { width: w, height: h, duration: r3(dur), frames: nFrames } });
    ctx.progress(1, 'done');
    return { output: stat, frames: nFrames, fps: a.fps, width: w, height: h, duration: r3(dur), palette: a.palette, colors: a.palette === 'none' ? 256 : a.colors, dither: a.dither, bytesPerFrame: Math.round(bytes.length / nFrames), ...info };
  },
});

register({
  name: 'video.fromImages',
  description: `Build a video from images: an image sequence (each image = one frame at fps; leave duration unset) or a slideshow (duration = seconds per image, or durations = one value per image). Images may differ in size; each is fitted onto the output canvas (default: size of the first image, rounded to even). Optionally add a soundtrack (audio = VFS path; cut to the video length). Returns {output, images, frames, duration, backend, hardwareAccelerated, video}. Up to 3000 images / 20000 frames per call.`,
  schema: {
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'VFS image paths in order (png, jpg, webp, gif first frame, bmp, avif, svg)' },
      output: P.output,
      fps: { type: 'number', default: 30, minimum: 1, maximum: 120, description: 'Frame rate of the video' },
      duration: { type: 'number', minimum: 0.01, maximum: 3600, description: 'Seconds each image stays on screen (default 1/fps = image sequence)' },
      durations: { type: 'array', items: { type: 'number' }, description: 'Per-image durations in seconds (same length as inputs); overrides duration' },
      ...RESIZE,
      background: { type: 'string', default: '#000000', description: 'CSS colour behind letterboxed or transparent images' },
      format: { type: 'string', enum: ['auto', 'mp4', 'webm', 'mov', 'mkv'], default: 'auto', description: 'Target container; auto = from the output extension, else mp4' },
      videoCodec: { ...P.videoCodec, enum: ['auto', 'h264', 'hevc', 'vp8', 'vp9', 'av1'], description: 'auto = container default' },
      quality: { ...P.quality, default: 'high' },
      audio: { type: 'string', description: 'Optional VFS path of an audio (or video) file to use as soundtrack' },
      backend: P.backend, hardware: P.hardware,
    },
    required: ['inputs'],
  },
  examples: ['video.fromImages inputs=f1.png,f2.png,f3.png fps=12', 'video.fromImages inputs=a.jpg,b.jpg,c.jpg duration=2.5 width=1280 height=720 output=slides.mp4 audio=music.mp3'],
  async run(a, ctx) {
    const n = a.inputs.length;
    if (n > 3000) throw new Error('at most 3000 images per call');
    a.inputs.forEach((p) => vfs.stat(p));
    if (a.durations && a.durations.length !== n) throw new Error(`durations has ${a.durations.length} entries but there are ${n} inputs`);
    const durs = a.inputs.map((_, i) => Number(a.durations?.[i] ?? a.duration ?? 1 / a.fps));
    if (durs.some((d) => !(d > 0))) throw new Error('every duration must be a positive number of seconds');
    const counts = durs.map((d) => Math.max(1, Math.round(d * a.fps)));
    const totalFrames = counts.reduce((s, c) => s + c, 0);
    if (totalFrames > 20000) throw new Error(`${totalFrames} frames requested — the limit is 20000 (lower fps or the durations)`);
    const format = a.format !== 'auto' ? a.format : containerOf(a.output, 'mp4');
    if (!['mp4', 'webm', 'mov', 'mkv'].includes(format)) throw new Error('video.fromImages writes mp4, webm, mov or mkv');
    const first = await decode(a.inputs[0]);
    const size = planSize({ width: first.width, height: first.height }, { width: a.width, height: a.height });
    const W = size.width, H = size.height, fit = a.width && a.height ? a.fit : (first.width === W && first.height === H ? 'fill' : 'contain');
    const c = canvasOf(W, H), g = c.getContext('2d');
    const paint = async (i) => {
      const img = i === 0 ? first : await decode(a.inputs[i]); const s = toCanvas(img);
      g.fillStyle = a.background; g.fillRect(0, 0, W, H);
      if (fit === 'fill') g.drawImage(s, 0, 0, W, H);
      else { const k = fit === 'cover' ? Math.max(W / img.width, H / img.height) : Math.min(W / img.width, H / img.height); const dw = img.width * k, dh = img.height * k; g.drawImage(s, (W - dw) / 2, (H - dh) / 2, dw, dh); }
    };
    const vcodecU = a.videoCodec !== 'auto' ? a.videoCodec : null;
    const outPath = vfs.out(a.output, a.inputs, 'video', format);
    const res = await pick(a.backend, ctx, async () => {
      const lib = await mb();
      const vcodec = await chooseVideoCodec(lib, format, vcodecU, W, H);
      const hwEnc = await hwEncodable(lib, vcodec, W, H);
      const mode = a.hardware === 'hardware' ? 'prefer-hardware' : a.hardware === 'software' ? 'prefer-software' : hwEnc ? 'prefer-hardware' : 'no-preference';
      const output = new lib.Output({ format: mbFormat(lib, format), target: new lib.BufferTarget() });
      const vsrc = new lib.CanvasSource(c, { codec: vcodec, quality: mbQuality(lib, 0, a.quality), hardwareAcceleration: mode, keyFrameInterval: 2 });
      output.addVideoTrack(vsrc, { frameRate: a.fps });
      try {
        await output.start();
        let f = 0;
        for (let i = 0; i < n; i++) { await paint(i); for (let k = 0; k < counts[i]; k++, f++) await vsrc.add(f / a.fps, 1 / a.fps); ctx.progress(0.95 * (i + 1) / n, 'webcodecs'); }
        await output.finalize();
      } catch (e) { await output.cancel().catch(() => {}); throw oom(e); }
      return { bytes: new Uint8Array(output.target.buffer), info: { backend: 'webcodecs', hardwareAccelerated: hwVerdict(mode, hwEnc), videoCodec: uname(vcodec) } };
    }, (reason) => ffJob(ctx, async (job) => {
      const cont = CONTAINERS[format], vc = vcodecU || cont.v[0];
      if (!FF_V[vc] || vc === 'av1') throw new Error(`ffmpeg cannot encode ${vc}`);
      let list = '', lastName = '';
      for (let i = 0; i < n; i++) { await paint(i); const name = job.tmp(`i${String(i).padStart(5, '0')}.png`); await job.write(name, (await canvasBytes(c, 'png')).bytes); list += `file '${name}'\nduration ${counts[i] / a.fps}\n`; lastName = name; ctx.progress(0.3 * (i + 1) / n, 'images'); }
      list += `file '${lastName}'\n`;
      const lf = job.tmp('list.txt'), out = job.tmp(`out.${format}`); await job.write(lf, list);
      const args = ['-f', 'concat', '-safe', '0', '-i', lf, '-vf', `fps=${a.fps},format=yuv420p`, '-c:v', ...FF_V[vc]];
      if (FF_CRF[vc]) { args.push('-crf', String(FF_CRF[vc][QUALITIES.indexOf(a.quality)])); if (vc === 'vp9') args.push('-b:v', '0'); if (vc === 'vp8') args.push('-b:v', '4M'); }
      args.push('-t', String(totalFrames / a.fps), '-f', cont.ff, ...(format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : []), out);
      await job.exec(args, { duration: totalFrames / a.fps, span: [0.3, 1] });
      return { bytes: await job.read(out), info: { backend: 'ffmpeg', hardwareAccelerated: false, videoCodec: vc, ...(reason ? { fallbackReason: reason } : {}) } };
    }));
    let { stat, info } = await finish(outPath, res.bytes, CONTAINERS[format].mime);
    let soundtrack;
    if (a.audio) {
      const m = await M.run('video.mux', { video: outPath, audio: a.audio, output: outPath, shortest: true, backend: a.backend }, ctx);
      stat = m.output; soundtrack = { backend: m.backend, codec: m.audio?.codec }; info = { ...info, audio: m.audio, duration: m.duration };
    }
    ctx.progress(1, 'done');
    return { output: stat, ...res.info, images: n, frames: totalFrames, fps: a.fps, ...(soundtrack ? { soundtrack } : {}), ...brief(info) };
  },
});

register({
  name: 'video.mux',
  description: 'Combine the picture of one file with the sound of another (add or replace a soundtrack). The video stream is copied when its codec fits the target container; the audio is copied or converted to the container default (mp4/mov: aac, webm: opus). shortest=true cuts the audio to the video length. Returns {output, backend, duration, video, audio}.',
  schema: {
    properties: {
      video: { type: 'string', description: 'VFS path of the file providing the video track (its own audio is dropped)' },
      audio: { type: 'string', description: 'VFS path of the file providing the audio track (audio file or another video)' },
      output: P.output,
      shortest: { type: 'boolean', default: true, description: 'Stop at the end of the video even if the audio is longer' },
      backend: P.backend,
    },
    required: ['video', 'audio'],
  },
  examples: ['video.mux video=silent.mp4 audio=voice.mp3 output=final.mp4'],
  async run(a, ctx) {
    const vs = await probeAny(a.video, ctx), as = await probeAny(a.audio, ctx);
    if (!vs.video) throw new Error(`"${a.video}" has no video track`);
    if (!as.audio) throw new Error(`"${a.audio}" has no audio track`);
    const format = containerOf(a.output, null) || (['mp4', 'webm', 'mov', 'mkv'].includes(vs.container) ? vs.container : 'mp4');
    const cont = CONTAINERS[format];
    const outPath = vfs.out(a.output, a.video, 'mux', format);
    const end = a.shortest ? vs.duration : undefined;
    const res = await pick(a.backend, ctx, async () => {
      guard(a.video); guard(a.audio);
      const lib = await mb();
      const fmt = mbFormat(lib, format);
      if (!V2MB[vs.video.codec] || !fmt.getSupportedVideoCodecs().includes(V2MB[vs.video.codec])) throw new Error(`.${format} cannot hold ${vs.video.codec} video without re-encoding — convert the video first`);
      const srcA = A2MB[as.audio.codec] || (as.audio.codec.startsWith('pcm_') ? as.audio.codec.replace('pcm_', 'pcm-') : null);
      let acodec = srcA && cont.a.includes(as.audio.codec.replace(/^pcm_.*/, 'pcm')) && fmt.getSupportedAudioCodecs().includes(srcA) && !(as.audio.codec.startsWith('pcm') && format !== 'mov' && format !== 'mkv') ? srcA : null;
      const copyAudio = !!acodec;
      if (!acodec) { if (!as.audio.canDecode) throw new Error(`this browser cannot decode the ${as.audio.codec} audio`); acodec = await chooseAudioCodec(lib, format, null); }
      const u = uname(acodec);
      const sr = !copyAudio && RATES[u] && !RATES[u].includes(as.audio.sampleRate) ? RATES[u].find((x) => x >= as.audio.sampleRate) || 48000 : undefined;
      const ch = !copyAudio && as.audio.channels > (MAXCH[u] || 8) ? MAXCH[u] : undefined;
      const iv = await openInput(a.video), ia = await openInput(a.audio);
      const output = new lib.Output({ format: fmt, target: new lib.BufferTarget() });
      try {
        const c1 = await lib.Conversion.init({ input: iv, output, composable: true, tracks: 'primary', showWarnings: false, video: { codec: V2MB[vs.video.codec] }, audio: { discard: true } });
        const c2 = await lib.Conversion.init({ input: ia, output, composable: true, tracks: 'primary', showWarnings: false, video: { discard: true }, audio: { codec: acodec, ...(sr ? { sampleRate: sr } : {}), ...(ch ? { numberOfChannels: ch } : {}) }, ...(end ? { trim: { end: Math.min(end, as.duration) } } : {}) });
        if (!c1.utilizedTracks.length || !c2.utilizedTracks.length) throw new Error(`webcodecs cannot mux these tracks (${[...c1.discardedTracks, ...c2.discardedTracks].filter((d) => d.reason !== 'discarded_by_user').map((d) => `${d.track.type}: ${d.reason}`).join('; ')})`);
        c1.onProgress = (f) => ctx.progress(f * 0.95, 'webcodecs');
        await output.start();
        await Promise.all([c1.execute(), c2.execute()]);
        await output.finalize();
        return { bytes: new Uint8Array(output.target.buffer), info: { backend: 'webcodecs', hardwareAccelerated: false, videoReencoded: false, audioCopied: copyAudio } };
      } catch (e) { await output.cancel().catch(() => {}); throw oom(e); } finally { iv.dispose(); ia.dispose(); }
    }, (reason) => ffJob(ctx, async (job) => {
      const out = job.tmp(`out.${format}`);
      const copyV = cont.v.includes(vs.video.codec) && FF2U[vs.video.codec], copyA = cont.a.includes(as.audio.codec);
      const args = ['-i', job.input(a.video), '-i', job.input(a.audio), '-map', '0:v:0', '-map', '1:a:0', '-sn', '-dn'];
      args.push('-c:v', ...(copyV ? ['copy'] : FF_V[cont.v[0]]), '-c:a', ...(copyA ? ['copy'] : FF_A[cont.a[0]]), '-strict', '-2');
      if (end) args.push('-t', String(end));
      args.push('-f', cont.ff, ...(format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : []), out);
      await job.exec(args, { duration: end || Math.max(vs.duration, as.duration) });
      return { bytes: await job.read(out), info: { backend: 'ffmpeg', hardwareAccelerated: false, videoReencoded: !copyV, audioCopied: copyA, ...(reason ? { fallbackReason: reason } : {}) } };
    }), { ffOnly: vs.backend === 'ffmpeg' || as.backend === 'ffmpeg' ? 'an input container is only readable by ffmpeg' : null });
    const { stat, info } = await finish(outPath, res.bytes, cont.mime);
    ctx.progress(1, 'done');
    return { output: stat, ...res.info, ...brief(info) };
  },
});

// ─────────────────────────────────────────────────────────── audio ──
async function audioTranscode(a, ctx, tag, dflt = null) {
  const src = await probeAny(a.input, ctx);
  if (!src.audio) throw new Error(`"${a.input}" has no audio track (tracks: ${src.tracks.map((t) => `${t.type}/${t.codec}`).join(', ') || 'none'})`);
  const outExt = a.output ? vfs.extOf(a.output) : '';
  const format = a.format || (AUDIO_FORMATS[outExt] ? outExt : outExt === 'mp4' ? 'm4a' : outExt === 'oga' ? 'ogg' : outExt === 'weba' ? 'webm' : dflt);
  if (!format) throw new Error(`pass format (${Object.keys(AUDIO_FORMATS).join(' | ')}) or an output path with one of those extensions`);
  const def = AUDIO_FORMATS[format];
  if (!def) throw new Error(`cannot encode audio format "${format}" — supported: ${Object.keys(AUDIO_FORMATS).join(', ')}`);
  let codec = a.codec && a.codec !== 'auto' ? a.codec : null;
  if (codec && !def.codecs.includes(codec)) throw new Error(`.${format} does not take ${codec} — it takes: ${def.codecs.join(', ')}`);
  if (a.channels && a.channels > (MAXCH[codec || def.codecs[0]] || 8)) throw new Error(`${codec || def.codecs[0]} supports at most ${MAXCH[codec || def.codecs[0]]} channels`);
  const p = { input: a.input, backend: a.backend || 'auto', hardware: 'auto', format, table: AUDIO_FORMATS, vcodec: null, acodec: codec, abitrate: ['wav', 'flac'].includes(format) ? undefined : kbps(a.bitrate), sampleRate: a.sampleRate, channels: a.channels, start: a.start, end: a.end, rotate: 0, crop: null, mute: false, noVideo: true, copy: 'auto' };
  const r = await runConvert(p, ctx, src, vfs.out(a.output, a.input, tag, format === 'aac' ? 'aac' : format));
  const { videoCodec, videoReencoded, hardwareAccelerated, video, ...rest } = r;
  return { ...rest, format, codec: r.audio?.codec || r.audioCodec, sampleRate: r.audio?.sampleRate, channels: r.audio?.channels, bitrate: r.audio?.bitrate ?? null, source: { codec: src.audio.codec, sampleRate: src.audio.sampleRate, channels: src.audio.channels, duration: src.duration } };
}
const AUDIO_PROPS = {
  format: { type: 'string', enum: Object.keys(AUDIO_FORMATS), description: 'wav (PCM 16-bit) | mp3 | m4a (AAC in MP4) | aac (raw ADTS) | ogg (Opus by default; codec=vorbis for Vorbis) | opus (Ogg Opus, .opus) | flac | webm (Opus). Default: from the output extension' },
  bitrate: { type: 'number', minimum: 6, description: 'Bitrate in kbit/s for lossy formats, e.g. 128 (values above 4000 are read as bit/s). Default: a medium-quality rate chosen for the codec and channel count. Ignored for wav/flac' },
  sampleRate: { type: 'integer', minimum: 8000, maximum: 192000, description: 'Output sample rate in Hz (default: keep; snapped to the nearest rate the codec supports — Opus: 8/12/16/24/48 kHz, MP3: ≤ 48 kHz)' },
  channels: { type: 'integer', minimum: 1, maximum: 8, description: 'Output channel count, 1 = mono, 2 = stereo (default: keep; mp3/opus max 2)' },
  codec: { type: 'string', enum: ['auto', 'aac', 'opus', 'mp3', 'vorbis', 'flac', 'pcm'], default: 'auto', description: 'Only needed where a container has a choice: ogg/webm take opus (default) or vorbis (ffmpeg backend)' },
  start: P.start, end: P.end,
  backend: { ...P.backend, description: 'auto = Mediabunny with the browser\'s AudioEncoder (AAC, Opus) or the bundled WASM encoders (MP3 = LAME, FLAC = libFLAC, AAC where the browser lacks it), falling back to ffmpeg.wasm (needed for Vorbis and for inputs in avi/flv/wma…)' },
};
const AUDIO_RET = 'Returns {output, format, codec, sampleRate, channels, bitrate, duration, backend, audioEncoder (webcodecs | wasm), source:{codec, sampleRate, channels, duration}}.';

register({
  name: 'video.extractAudio',
  description: `Pull the audio track out of a video into an audio file: wav, mp3, m4a, aac, ogg, opus, flac or webm. When the track already has the target codec and no bitrate/sample-rate/channel change is asked, it is copied without re-encoding (e.g. AAC from mp4 → m4a). ${AUDIO_RET}`,
  schema: { properties: { input: P.input(), output: P.output, ...AUDIO_PROPS, format: { ...AUDIO_PROPS.format, description: AUDIO_PROPS.format.description.replace('Default: from the output extension', 'Default: from the output extension, else m4a') } }, required: ['input'] },
  examples: ['video.extractAudio input=clip.mp4 format=mp3 bitrate=160', 'video.extractAudio input=talk.webm output=talk.wav sampleRate=16000 channels=1'],
  run: (a, ctx) => audioTranscode(a, ctx, 'audio', 'm4a'),
});

register({
  name: 'video.transcodeAudio',
  description: `Convert an audio file (or the audio of a video) to another audio format with a chosen bitrate, sample rate and channel count. Formats: wav | mp3 | m4a | aac | ogg | opus | flac | webm. This is the encoder behind every compressed-audio export. Reads wav, mp3, m4a/mp4, ogg, opus, flac, webm, aac natively and anything else through ffmpeg. ${AUDIO_RET}`,
  schema: { properties: { input: P.input('audio (or video) file'), output: P.output, ...AUDIO_PROPS }, required: ['input'] },
  examples: ['video.transcodeAudio input=voice.wav format=mp3 bitrate=128', 'video.transcodeAudio input=song.flac format=opus bitrate=96', 'video.transcodeAudio input=a.mp3 format=wav sampleRate=16000 channels=1'],
  run: (a, ctx) => audioTranscode(a, ctx, 'audio'),
});

// ──────────────────────────────────────────────────── test pattern ──
register({
  name: 'video.testPattern',
  description: 'Generate a synthetic test clip: moving colour bars, a bouncing box, and a large burned-in timecode + frame counter, with an optional sine tone that beeps once per second. Use it to try the video tools or to check what a pipeline does to timing, colour and audio without needing a real file. Returns {output, duration, frames, backend, hardwareAccelerated, video, audio}.',
  schema: {
    properties: {
      output: { type: 'string', default: 'testpattern.mp4', description: 'VFS path to write; extension mp4, webm, mov or mkv' },
      duration: { type: 'number', default: 5, minimum: 0.2, maximum: 120, description: 'Length in seconds' },
      width: { type: 'integer', default: 640, minimum: 64, maximum: 3840, description: 'Width in pixels (even)' },
      height: { type: 'integer', default: 360, minimum: 64, maximum: 2160, description: 'Height in pixels (even)' },
      fps: { type: 'number', default: 30, minimum: 1, maximum: 120, description: 'Frame rate' },
      videoCodec: { ...P.videoCodec, enum: ['auto', 'h264', 'hevc', 'vp8', 'vp9', 'av1'], description: 'auto = container default' },
      audio: { type: 'boolean', default: true, description: 'Add a stereo tone (440 Hz left / 660 Hz right) with a 1 kHz beep at every full second' },
      hardware: P.hardware,
    },
  },
  examples: ['video.testPattern duration=4 output=t.mp4', 'video.testPattern output=t.webm width=320 height=240 fps=24 audio=false'],
  async run(a, ctx) {
    if (!hasWebCodecs()) throw new Error('video.testPattern needs WebCodecs (VideoEncoder), which this browser lacks');
    const lib = await mb();
    const format = containerOf(a.output, null); if (!format || !CONTAINERS[format].mbf) throw new Error('output extension must be mp4, webm, mov or mkv');
    const W = even(a.width), H = even(a.height), n = Math.max(1, Math.round(a.duration * a.fps));
    const vcodec = await chooseVideoCodec(lib, format, a.videoCodec !== 'auto' ? a.videoCodec : null, W, H);
    const hwEnc = await hwEncodable(lib, vcodec, W, H);
    const mode = a.hardware === 'hardware' ? 'prefer-hardware' : a.hardware === 'software' ? 'prefer-software' : hwEnc ? 'prefer-hardware' : 'no-preference';
    const c = canvasOf(W, H), g = c.getContext('2d');
    const output = new lib.Output({ format: mbFormat(lib, format), target: new lib.BufferTarget() });
    const vsrc = new lib.CanvasSource(c, { codec: vcodec, quality: mbQuality(lib, 0, 'high'), hardwareAcceleration: mode, keyFrameInterval: 1 });
    output.addVideoTrack(vsrc, { frameRate: a.fps });
    let asrc = null, acodec = null;
    if (a.audio) { acodec = await chooseAudioCodec(lib, format, null); asrc = new lib.AudioBufferSource({ codec: acodec, quality: mbQuality(lib, 0, 'medium') }); output.addAudioTrack(asrc); }
    const BARS = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    try {
      await output.start();
      const audioTask = (async () => {
        if (!asrc) return;
        const sr = 48000, total = Math.round(a.duration * sr);
        for (let off = 0; off < total; off += sr) {
          const len = Math.min(sr, total - off), buf = new AudioBuffer({ length: len, sampleRate: sr, numberOfChannels: 2 });
          for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch), f = ch ? 660 : 440; for (let i = 0; i < len; i++) { const t = (off + i) / sr, beep = (t % 1) < 0.08 ? 0.35 * Math.sin(2 * Math.PI * 1000 * t) : 0; d[i] = 0.18 * Math.sin(2 * Math.PI * f * t) + beep; } }
          await asrc.add(buf);
        }
      })();
      for (let i = 0; i < n; i++) {
        const t = i / a.fps, bw = W / BARS.length, shift = (t * W * 0.1) % W;
        const off = Math.floor(shift / bw); for (let k = -1; k <= BARS.length; k++) { g.fillStyle = BARS[(((k - off) % 7) + 7) % 7]; g.fillRect(Math.round(k * bw + (shift % bw)), 0, Math.ceil(bw) + 1, Math.round(H * 0.62)); }
        const gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, '#000'); gr.addColorStop(1, '#fff'); g.fillStyle = gr; g.fillRect(0, Math.round(H * 0.62), W, Math.round(H * 0.1));
        g.fillStyle = '#16181c'; g.fillRect(0, Math.round(H * 0.72), W, H - Math.round(H * 0.72));
        const bs = Math.round(H * 0.12), px = Math.abs(((t * 0.35) % 2) - 1) * (W - bs), py = H * 0.14 + Math.abs(((t * 0.8) % 2) - 1) * (H * 0.44 - bs);
        g.fillStyle = '#ffffff'; g.fillRect(px, py, bs, bs); g.fillStyle = '#e02020'; g.fillRect(px + bs * 0.25, py + bs * 0.25, bs * 0.5, bs * 0.5);
        g.fillStyle = '#ffffff'; g.textBaseline = 'middle'; g.font = `600 ${Math.round(H * 0.15)}px ui-monospace, Consolas, Menlo, monospace`;
        g.fillText(`${fmtTime(t)}  f${String(i).padStart(4, '0')}`, Math.round(W * 0.04), Math.round(H * 0.865));
        await vsrc.add(t, 1 / a.fps);
        if (i % 10 === 0) ctx.progress(0.95 * i / n, 'webcodecs');
      }
      await audioTask;
      await output.finalize();
    } catch (e) { await output.cancel().catch(() => {}); throw oom(e); }
    const { stat, info } = await finish(a.output, new Uint8Array(output.target.buffer), CONTAINERS[format].mime);
    ctx.progress(1, 'done');
    return { output: stat, frames: n, backend: 'webcodecs', hardwareAccelerated: hwVerdict(mode, hwEnc), ...brief(info) };
  },
});

// ───────────────────────────────────────────────────── raw ffmpeg ──
register({
  name: 'video.ffmpeg',
  description: `Escape hatch: run an arbitrary ffmpeg command line in ffmpeg.wasm (FFmpeg 5.1, CPU, single thread; libx264, libx265, libvpx, libmp3lame, libopus, libvorbis, libtheora, libwebp, libass, zimg; no AV1, no network, no hardware). Write args exactly as on a shell, without the leading "ffmpeg", using VFS paths: every path listed in inputs is mounted read-only and every name listed in outputs is copied back into the VFS afterwards. Use the dedicated video.* tools when they fit — this one is for filters and formats they do not cover. Returns {outputs, exitCode, log (last lines), backend:'ffmpeg'}. Inputs up to ${FF_MAX_INPUT / 1048576} MB in total.`,
  schema: {
    properties: {
      args: { type: 'array', items: { type: 'string' }, description: 'ffmpeg arguments, one per element, e.g. ["-i","in.mp4","-vf","hue=s=0","out.mp4"]' },
      inputs: { type: 'array', items: { type: 'string' }, default: [], description: 'VFS paths that appear in args as inputs' },
      outputs: { type: 'array', items: { type: 'string' }, default: [], description: 'File names that appear in args as outputs; each is written to the VFS under that name' },
      logLines: { type: 'integer', default: 20, minimum: 0, maximum: 200, description: 'How many trailing log lines to return' },
      timeoutSec: { type: 'integer', default: 900, minimum: 1, maximum: 7200, description: 'Abort the run after this many seconds' },
    },
    required: ['args'],
  },
  examples: ['video.ffmpeg args=["-i","in.mp4","-vf","hue=s=0","-c:a","copy","gray.mp4"] inputs=in.mp4 outputs=gray.mp4'],
  async run(a, ctx) {
    if (typeof a.args[0] === 'string' && a.args.length === 1 && a.args[0].trim().startsWith('[')) { try { a.args = JSON.parse(a.args[0]); } catch { /* keep */ } }
    const args = a.args.map(String); if (args[0] === 'ffmpeg') args.shift();
    return ffJob(ctx, async (job) => {
      const map = new Map();
      for (const p of a.inputs) map.set(p, job.input(p));
      for (const p of a.outputs) map.set(p, job.tmp(`o_${p.replace(/[^A-Za-z0-9._-]/g, '_')}`));
      const real = args.map((x) => map.get(x) ?? x);
      const r = await job.exec(real, { allowFail: true, timeout: a.timeoutSec * 1000, duration: 0 });
      const outputs = [];
      for (const p of a.outputs) if (await job.exists(map.get(p))) outputs.push((await finish(p, await job.read(map.get(p)))).stat);
      const log = r.log.filter((l) => l.trim() && !/^Aborted\(\)$/.test(l)).slice(-a.logLines).map((l) => l.slice(0, 300));
      if (r.code !== 0 && !outputs.length) throw new Error(`ffmpeg exited with code ${r.code}: ${log.slice(-6).join(' | ').slice(0, 800)}`);
      return { outputs, exitCode: r.code, missing: a.outputs.filter((p) => !outputs.some((o) => o.path === p)), log, backend: 'ffmpeg', hardwareAccelerated: false };
    });
  },
});
