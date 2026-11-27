// audio.* — decode, edit, measure, draw and synthesise audio. Decoding is Web Audio (decodeAudioData) or a native
// WAV/AIFF PCM reader; all DSP is plain typed-array JS (web/js/audio/dsp.js); WAV is written natively.
// Compressed output (mp3, m4a, aac, ogg, opus, flac, webm) is delegated to video.transcodeAudio.
import { M, vfs, register } from '../js/core.js';
import { canvasOf, saveCanvas, canvasBytes } from '../js/img.js';
import {
  nextPow2, adb, pdb, STFT, WINDOWS, FILTER_TYPES, biquad, applyBiquad, biquadGain, resample, truePeak, loudness,
  wsola, yin, noteOf, noteToHz, goertzel, onsetEnvelope, prng, windowFn,
} from '../js/audio/dsp.js';
import { sniff, wavHeader, decodeWav, decodeAiff, encodeWav, browserDecode } from '../js/audio/io.js';
import { COLORMAPS, lut, theme, linTicks, fmtHz, freqTicks, SCALES, FONT, drawTimeAxis, frame } from '../js/audio/plot.js';

// Decoded PCM lives in memory as Float32 (4 bytes per sample per channel) and most edits hold a second copy.
const MAX_SAMPLES = 120e6; // samples × channels  (≈ 41 min mono / 20 min stereo at 48 kHz, ≈ 480 MB)
const LIMIT_TEXT = 'in-memory limit of 120 million samples (frames × channels): about 41 min mono or 20 min stereo at 48 kHz';
const COMPRESSED = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm'];

const r = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const dB = (lin, d = 2) => r(adb(lin), d);         // null = −∞ (digital silence)
const lin = (db) => 10 ** (db / 20);
const chName = (i, n) => (n === 1 ? 'mono' : n === 2 ? ['L', 'R'][i] : `ch${i + 1}`);

// ──────────────────────────────────────────────────────────── load ──
let cache = { bytes: null, audio: null }; // the most recently decoded file, so a chain of analyses decodes once
M.on('vfs', (d) => { if (cache.audio && d?.path === cache.audio.path) cache = { bytes: null, audio: null }; });
function checkSize(frames, nch, what) {
  if (frames * nch > MAX_SAMPLES) throw new Error(`${what} is too long to hold in memory: ${Math.round(frames)} frames × ${nch} ch exceeds the ${LIMIT_TEXT}. Trim, downmix or downsample it first.`);
}
/** load(path) → {sr, ch: Float32Array[] (treat as read-only), n, bitDepth, info, path} */
async function load(path) {
  const bytes = vfs.read(path);
  if (cache.bytes === bytes && cache.audio) return cache.audio;
  if (!bytes.length) throw new Error(`"${path}" is empty`);
  const info = sniff(bytes);
  if (info.duration && info.sampleRate && info.channels) checkSize(info.duration * info.sampleRate, info.channels, `"${path}"`);
  let d = null, decoder = 'native';
  if (info.container === 'wav') d = decodeWav(bytes);
  else if (info.container === 'aiff') d = decodeAiff(bytes);
  if (!d) {
    decoder = 'browser';
    try { d = await browserDecode(bytes, info.sampleRate || 48000); } catch (e) {
      throw new Error(`cannot decode "${path}" as audio (sniffed container: ${info.container}${info.codec ? `, codec: ${info.codec}` : ''}) — ${e?.message || e}. Decodable: WAV/AIFF PCM natively; mp3, aac/m4a, ogg vorbis/opus, flac, webm and the audio track of mp4/webm video through the browser decoder.`);
    }
  }
  if (!d.channels.length || !d.channels[0].length) throw new Error(`"${path}" decoded to zero samples`);
  checkSize(d.channels[0].length, d.channels.length, `"${path}"`);
  const audio = { sr: d.sampleRate, ch: d.channels, n: d.channels[0].length, bitDepth: [16, 24, 32].includes(d.bitDepth) ? d.bitDepth : d.bitDepth === 8 ? 16 : null, info, path: vfs.stat(path).path, decoder };
  if (decoder === 'browser' && info.sampleRate && info.sampleRate !== d.sampleRate) audio.resampledByDecoder = true;
  if (decoder === 'browser' && !info.sampleRate) audio.rateAssumed = true; // header gave no rate: decoded at 48 kHz
  cache = { bytes, audio };
  return audio;
}
/** [s0, s1) sample range from start/end/duration args (seconds) */
function range(a, args) {
  const start = args.start ?? 0; let end = args.end;
  if (args.duration !== undefined && args.duration !== null) { if (end !== undefined && end !== null) throw new Error('give "end" or "duration", not both'); end = start + args.duration; }
  const total = a.n / a.sr;
  if (end === undefined || end === null) end = total;
  if (start < 0 || start >= total) throw new Error(`start=${start}s is outside the audio (0 … ${r(total, 3)} s)`);
  if (end <= start) throw new Error(`end (${end}s) must be greater than start (${start}s)`);
  const s0 = Math.round(start * a.sr), s1 = Math.min(a.n, Math.round(end * a.sr));
  if (s1 <= s0) throw new Error('selected range is empty');
  return [s0, s1];
}
const sub = (a, s0, s1) => a.ch.map((c) => c.subarray(s0, s1));
function monoOf(chs, s0 = 0, s1 = chs[0].length) {
  if (chs.length === 1) return chs[0].subarray(s0, s1);
  const out = new Float32Array(s1 - s0), g = 1 / chs.length;
  for (const c of chs) for (let i = s0; i < s1; i++) out[i - s0] += c[i] * g;
  return out;
}
/** analysis channel: 'mix' (average) or a 0-based index */
function pick(a, channel, s0, s1) {
  if (channel === undefined || channel === 'mix' || channel === 'mono') return monoOf(a.ch, s0, s1);
  const i = Number(channel);
  if (!Number.isInteger(i) || i < 0 || i >= a.ch.length) throw new Error(`channel must be "mix" or an index 0…${a.ch.length - 1} (got "${channel}")`);
  return a.ch[i].subarray(s0, s1);
}
function toChannels(chs, target) {
  const n = chs.length;
  if (n === target) return chs;
  if (target === 1) return [Float32Array.from(monoOf(chs))];
  if (n === 1) return Array.from({ length: target }, () => chs[0]);
  if (n === 6 && target === 2) { // ITU-R BS.775 downmix, LFE dropped
    const len = chs[0].length, L = new Float32Array(len), R = new Float32Array(len), k = Math.SQRT1_2;
    for (let i = 0; i < len; i++) { L[i] = chs[0][i] + k * chs[2][i] + k * chs[4][i]; R[i] = chs[1][i] + k * chs[2][i] + k * chs[5][i]; }
    return [L, R];
  }
  throw new Error(`no built-in mapping from ${n} to ${target} channels — supported: any→1 (average), 1→N (duplicate), 6→2 (ITU downmix). Use audio.channels op=pick/merge to build another layout.`);
}
function peakOf(chs) { let p = 0; for (const c of chs) for (let i = 0; i < c.length; i++) { const v = c[i] < 0 ? -c[i] : c[i]; if (v > p) p = v; } return p; }
function rmsOf(chs) { let s = 0, n = 0; for (const c of chs) { for (let i = 0; i < c.length; i++) s += c[i] * c[i]; n += c.length; } return n ? Math.sqrt(s / n) : 0; }

// ─────────────────────────────────────────────────────────── write ──
const OUT = {
  output: { type: 'string', description: 'VFS path to write (default: derived from the input name). Its extension selects the format when "format" is not given.' },
  format: { type: 'string', enum: ['wav', ...COMPRESSED], description: 'Output format (default: from the output extension, else wav). wav is written natively; mp3/m4a/aac/ogg/opus/flac/webm are delegated to video.transcodeAudio and fail with a clear error if that tool is unavailable.' },
  bitDepth: { type: 'integer', enum: [16, 24, 32], description: 'WAV sample format: 16 or 24 = integer PCM (clips above 0 dBFS), 32 = float (lossless for intermediates, keeps peaks above 0 dBFS). Default: same as a WAV input, else 16.' },
  bitrate: { type: 'number', minimum: 6, description: 'Bitrate in kbit/s for lossy compressed formats, e.g. 128 (passed to video.transcodeAudio; ignored for wav and flac)' },
};
const RANGE = {
  start: { type: 'number', minimum: 0, description: 'Start of the range to use, seconds (default 0)' },
  end: { type: 'number', minimum: 0, description: 'End of the range, seconds (default: end of file)' },
};
let tmpSeq = 0;
/** write PCM → VFS. Returns an object to spread into the tool result: {output, clippedSamples?, warning?}. */
async function writeOut(chs, sr, args, input, tag, srcDepth) {
  const oext = args.output ? vfs.extOf(args.output) : '';
  const format = args.format || (COMPRESSED.includes(oext) ? oext : oext === 'oga' ? 'ogg' : oext === 'weba' ? 'webm' : 'wav');
  const depth = args.bitDepth || srcDepth || 16;
  if (!chs[0].length) throw new Error('nothing to write: the result has zero samples');
  checkSize(chs[0].length, chs.length, 'the result');
  const { bytes, clipped } = encodeWav(chs, sr, depth);
  const meta = { duration: r(chs[0].length / sr, 6), sampleRate: sr, channels: chs.length };
  const extra = clipped ? { clippedSamples: clipped, warning: `${clipped} samples exceeded 0 dBFS and were clipped by ${depth}-bit PCM; lower the gain, normalise, or use bitDepth=32` } : {};
  if (format === 'wav') {
    const path = vfs.out(args.output, input, tag, 'wav');
    return { output: await vfs.write(path, bytes, { mime: 'audio/wav', meta: { ...meta, bitDepth: depth } }), ...extra };
  }
  const unavailable = (why) => new Error(`compressed output (${format}) is unavailable: ${why}. WAV output is available — pass format=wav (or a .wav output path).`);
  if (!M.tools.has('video.transcodeAudio')) throw unavailable('the video.transcodeAudio tool is not loaded in this page');
  const path = vfs.out(args.output, input, tag, format);
  const tmp = vfs.unique(`.audio-tmp-${Date.now()}-${++tmpSeq}`, 'wav');
  await vfs.write(tmp, bytes, { mime: 'audio/wav' });
  let res;
  try {
    res = await M.run('video.transcodeAudio', { input: tmp, output: path, format, ...(format === 'm4a' ? { codec: 'aac' } : {}), ...(args.bitrate ? { bitrate: args.bitrate } : {}) }, true);
  } catch (e) { throw unavailable(`video.transcodeAudio failed — ${e?.message || e}`); } finally { vfs.rm(tmp); }
  const produced = res?.output?.path || (Array.isArray(res?.outputs) && res.outputs[0]?.path) || path;
  if (!vfs.exists(produced)) throw unavailable('video.transcodeAudio returned without writing a file');
  const st = vfs.stat(produced), fill = {};
  for (const k of ['duration', 'sampleRate', 'channels']) if (st[k] === undefined) fill[k] = res?.[k] ?? meta[k]; // the encoder may have snapped the rate (e.g. Opus → 48 kHz)
  if (Object.keys(fill).length) vfs.setMeta(produced, fill);
  return { output: vfs.stat(produced), encodedBy: 'video.transcodeAudio', encoder: { codec: res?.codec, bitrate: res?.bitrate, backend: res?.backend, sampleRate: res?.sampleRate, channels: res?.channels }, ...extra };
}

// ════════════════════════════════════════════════════════════ info ══
register({
  name: 'audio.info', readOnly: true,
  description: 'Identify an audio file: container and codec sniffed from the header bytes (wav, aiff, mp3, flac, ogg vorbis/opus, m4a/mp4, webm/mkv, adts), duration, sample rate, channels, bit depth, average bitrate (file bits ÷ duration) and tags (ID3v2/v1, Vorbis comments, MP4 ilst, RIFF INFO). Reads headers only unless they lack duration/rate/channels, in which case the file is decoded to measure them. Use first on any unknown audio file.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the audio (or video-with-audio) file' },
      probe: { type: 'string', enum: ['auto', 'header', 'decode'], default: 'auto', description: 'header = never decode; decode = always decode and report the exact decoded length; auto = decode only when the header is not enough' },
    },
    required: ['input'],
  },
  examples: ['audio.info input=song.mp3'],
  async run({ input, probe }) {
    const bytes = vfs.read(input), info = sniff(bytes);
    const out = { path: vfs.stat(input).path, bytes: bytes.length, container: info.container, codec: info.codec };
    let duration = info.duration, sampleRate = info.sampleRate, channels = info.channels;
    const need = probe === 'decode' || (probe === 'auto' && !(duration > 0 && sampleRate && channels));
    if (need) {
      try {
        const a = await load(input);
        out.decoded = { duration: r(a.n / a.sr, 6), sampleRate: a.sr, channels: a.ch.length, frames: a.n, decoder: a.decoder };
        if (a.rateAssumed) out.decoded.note = 'the header gave no sample rate, so the browser decoder resampled to 48000 Hz';
        duration = a.n / a.sr; channels = a.ch.length; sampleRate = sampleRate || a.sr;
      } catch (e) { if (probe === 'decode') throw e; out.decodeError = e.message; }
    }
    Object.assign(out, {
      duration: r(duration, 6), durationSource: need && out.decoded ? 'decoded' : info.durationSource, sampleRate: sampleRate ?? null, channels: channels ?? null,
      bitDepth: info.bitDepth ?? null, bitrate: duration > 0 ? Math.round(bytes.length * 8 / duration) : null, nominalBitrate: info.nominalBitrate ?? undefined,
    });
    for (const k of ['codecDetail', 'vbr', 'brand', 'hasVideo', 'inputSampleRate', 'id3', 'pictures']) if (info[k] !== undefined) out[k] = info[k];
    out.tags = info.tags;
    if (info.notes) out.notes = info.notes;
    return out;
  },
});

// ═════════════════════════════════════════════════════════ editing ══
register({
  name: 'audio.convert',
  description: 'Convert audio to WAV (choose bit depth, sample rate, channel count) or, by delegation to video.transcodeAudio, to mp3/m4a/aac/ogg/opus/flac/webm. Also the way to extract the audio track of a video file as WAV. Returns the written file with duration, sampleRate and channels.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source audio (any decodable format, or a video with an audio track)' },
      sampleRate: { type: 'integer', minimum: 1000, maximum: 384000, description: 'Resample to this rate in Hz (default: keep)' },
      channels: { type: 'integer', minimum: 1, maximum: 8, description: 'Channel count: 1 = average to mono, 2 from mono = duplicate, 2 from 5.1 = ITU downmix (default: keep)' },
      ...OUT,
    },
    required: ['input'],
  },
  examples: ['audio.convert input=song.mp3 sampleRate=16000 channels=1', 'audio.convert input=take.wav format=mp3 bitrate=192'],
  async run(args, ctx) {
    const a = await load(args.input);
    let chs = a.ch, sr = a.sr;
    if (args.channels) chs = toChannels(chs, args.channels);
    if (args.sampleRate && args.sampleRate !== sr) { ctx.progress(0.3, 'resampling'); chs = chs.map((c) => resample(c, args.sampleRate / sr, 16)); sr = args.sampleRate; }
    return { ...(await writeOut(chs, sr, args, args.input, null, a.bitDepth)), from: { container: a.info.container, codec: a.info.codec, sampleRate: a.sr, channels: a.ch.length } };
  },
});

register({
  name: 'audio.trim',
  description: 'Cut a time range out of an audio file (start/end or start/duration, in seconds) and write it as a new file. Sample-accurate. Returns the new file and its duration.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source audio' },
      ...RANGE,
      duration: { type: 'number', minimum: 0, description: 'Length to keep in seconds (alternative to end)' },
      ...OUT,
    },
    required: ['input'],
  },
  examples: ['audio.trim input=talk.wav start=12.5 duration=30'],
  async run(args) {
    const a = await load(args.input); const [s0, s1] = range(a, args);
    return { ...(await writeOut(sub(a, s0, s1), a.sr, args, args.input, 'trim', a.bitDepth)), start: r(s0 / a.sr, 6), end: r(s1 / a.sr, 6), duration: r((s1 - s0) / a.sr, 6), sourceDuration: r(a.n / a.sr, 6) };
  },
});

register({
  name: 'audio.concat',
  description: 'Join audio files end to end, with an optional silent gap or linear crossfade between them. Files are resampled to the first file\'s sample rate (or sampleRate) and mono files are duplicated to match a multi-channel one. Returns the joined file and each part\'s start time.',
  schema: {
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, description: 'VFS paths in playback order (2 or more; the same path may repeat)' },
      gap: { type: 'number', default: 0, minimum: 0, maximum: 600, description: 'Seconds of silence inserted between files' },
      crossfade: { type: 'number', default: 0, minimum: 0, maximum: 60, description: 'Seconds of overlap with a linear crossfade between consecutive files (shortens the total; cannot be combined with gap)' },
      sampleRate: { type: 'integer', minimum: 1000, maximum: 384000, description: 'Output sample rate (default: that of the first input)' },
      ...OUT,
    },
    required: ['inputs'],
  },
  examples: ['audio.concat inputs=intro.wav,body.wav,outro.wav crossfade=0.5'],
  async run(args, ctx) {
    if (args.inputs.length < 2) throw new Error('inputs needs at least 2 files');
    if (args.gap && args.crossfade) throw new Error('use gap or crossfade, not both');
    const parts = []; let sr = args.sampleRate, nch = 1, depth = null;
    for (const [i, p] of args.inputs.entries()) {
      const a = await load(p); sr ||= a.sr; depth ??= a.bitDepth;
      parts.push({ chs: a.sr === sr ? a.ch : a.ch.map((c) => resample(c, sr / a.sr, 16)), from: a.sr });
      nch = Math.max(nch, a.ch.length); ctx.progress((i + 1) / (args.inputs.length + 1));
    }
    const gapN = Math.round(args.gap * sr), xf = Math.round(args.crossfade * sr);
    for (const p of parts) { p.chs = toChannels(p.chs, nch); p.n = p.chs[0].length; if (xf && p.n < xf) throw new Error(`crossfade (${args.crossfade}s) is longer than one of the inputs (${r(p.n / sr, 3)}s)`); }
    const total = parts.reduce((s, p) => s + p.n, 0) + (parts.length - 1) * (gapN - xf);
    checkSize(total, nch, 'the concatenation');
    const out = Array.from({ length: nch }, () => new Float32Array(total)); const starts = []; let pos = 0;
    parts.forEach((p, k) => {
      starts.push(r(pos / sr, 6));
      for (let c = 0; c < nch; c++) {
        const src = p.chs[c], dst = out[c];
        for (let i = 0; i < p.n; i++) {
          let g = 1;
          if (xf) { if (k > 0 && i < xf) g = (i + 0.5) / xf; if (k < parts.length - 1 && i >= p.n - xf) g *= (p.n - i - 0.5) / xf; }
          dst[pos + i] += src[i] * g;
        }
      }
      pos += p.n + gapN - xf;
    });
    return { ...(await writeOut(out, sr, args, args.inputs[0], 'concat', depth)), duration: r(total / sr, 6), parts: parts.slice(0, 50).map((p, i) => ({ input: args.inputs[i], start: starts[i], duration: r(p.n / sr, 6), resampledFrom: p.from !== sr ? p.from : undefined })), truncated: parts.length > 50 || undefined };
  },
});

register({
  name: 'audio.mix',
  description: 'Sum several audio files into one (overdub / layering), each with its own gain in dB and start offset in seconds. Output length = the latest ending input. Reports the resulting peak; set normalize=true to scale the mix down when it would clip.',
  schema: {
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, description: 'VFS paths to mix (2 or more)' },
      gains: { type: 'array', items: { type: 'number' }, description: 'Gain per input in dB, same order as inputs (default 0 for each)' },
      offsets: { type: 'array', items: { type: 'number' }, description: 'Start time per input in seconds within the mix (default 0 for each; must be ≥ 0)' },
      normalize: { type: 'boolean', default: false, description: 'If the summed peak exceeds −1 dBFS, scale the whole mix down to −1 dBFS' },
      sampleRate: { type: 'integer', minimum: 1000, maximum: 384000, description: 'Output sample rate (default: that of the first input)' },
      ...OUT,
    },
    required: ['inputs'],
  },
  examples: ['audio.mix inputs=voice.wav,music.wav gains=0,-12 offsets=0,1.5'],
  async run(args) {
    const k = args.inputs.length;
    if (k < 2) throw new Error('inputs needs at least 2 files');
    for (const key of ['gains', 'offsets']) if (args[key] && args[key].length !== k) throw new Error(`${key} must list one value per input (${k}), got ${args[key].length}`);
    const parts = []; let sr = args.sampleRate, nch = 1, depth = null;
    for (const [i, p] of args.inputs.entries()) {
      const a = await load(p); sr ||= a.sr; depth ??= a.bitDepth;
      const off = args.offsets?.[i] ?? 0; if (off < 0) throw new Error('offsets must be ≥ 0');
      parts.push({ chs: a.sr === sr ? a.ch : a.ch.map((c) => resample(c, sr / a.sr, 16)), off: Math.round(off * sr), g: lin(args.gains?.[i] ?? 0) });
      nch = Math.max(nch, a.ch.length);
    }
    const total = Math.max(...parts.map((p) => p.off + p.chs[0].length));
    checkSize(total, nch, 'the mix');
    const out = Array.from({ length: nch }, () => new Float32Array(total));
    for (const p of parts) { const chs = toChannels(p.chs, nch); for (let c = 0; c < nch; c++) { const s = chs[c], d = out[c], o = p.off, g = p.g; for (let i = 0; i < s.length; i++) d[o + i] += s[i] * g; } }
    let peak = peakOf(out), scaled;
    if (args.normalize && peak > lin(-1)) { const g = lin(-1) / peak; for (const c of out) for (let i = 0; i < c.length; i++) c[i] *= g; scaled = dB(g); peak = lin(-1); }
    return { ...(await writeOut(out, sr, args, args.inputs[0], 'mix', depth)), duration: r(total / sr, 6), peakDb: dB(peak), normalizedByDb: scaled };
  },
});

register({
  name: 'audio.gain',
  description: 'Change level by a fixed amount: gain in dB (or a linear factor), optional polarity inversion. Reports peak before and after so you can see whether the result clips. For level targets use audio.normalize.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source audio' },
      db: { type: 'number', minimum: -120, maximum: 120, description: 'Gain in decibels (+6.02 doubles the amplitude)' },
      factor: { type: 'number', description: 'Linear amplitude multiplier (alternative to db; negative inverts polarity)' },
      invert: { type: 'boolean', default: false, description: 'Invert polarity (multiply by −1)' },
      ...OUT,
    },
    required: ['input'],
  },
  examples: ['audio.gain input=quiet.wav db=6'],
  async run(args) {
    if ((args.db === undefined) === (args.factor === undefined) && !args.invert) throw new Error('give exactly one of: db, factor (or invert=true)');
    if (args.db !== undefined && args.factor !== undefined) throw new Error('give db or factor, not both');
    const a = await load(args.input);
    let g = args.db !== undefined ? lin(args.db) : args.factor ?? 1; if (args.invert) g = -g;
    const before = peakOf(a.ch);
    const out = a.ch.map((c) => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = c[i] * g; return o; });
    return { ...(await writeOut(out, a.sr, args, args.input, 'gain', a.bitDepth)), gainDb: dB(Math.abs(g)), factor: r(g, 6), peakBeforeDb: dB(before), peakAfterDb: dB(before * Math.abs(g)) };
  },
});

register({
  name: 'audio.normalize',
  description: 'Scale a file to a level target with one constant gain (no compression or limiting). mode=peak: sample peak to target dBFS (default −1). mode=loudness: ITU-R BS.1770 integrated loudness to target LUFS (default −16), with the gain reduced if the true peak would pass peakCeiling. mode=rms: plain RMS to target dBFS (default −20). Returns the gain applied and the before/after measurement.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source audio' },
      mode: { type: 'string', enum: ['peak', 'loudness', 'rms'], default: 'peak', description: 'What to measure: peak (dBFS), loudness (LUFS, BS.1770), rms (dBFS)' },
      target: { type: 'number', minimum: -70, maximum: 0, description: 'Target level: dBFS for peak/rms, LUFS for loudness (defaults: peak −1, loudness −16, rms −20)' },
      peakCeiling: { type: 'number', default: -1, minimum: -30, maximum: 0, description: 'For loudness/rms modes: highest allowed true peak in dBTP; the gain is lowered to respect it' },
      ...OUT,
    },
    required: ['input'],
  },
  examples: ['audio.normalize input=podcast.wav mode=loudness target=-16'],
  async run(args) {
    const a = await load(args.input); const peak = peakOf(a.ch);
    if (!(peak > 0)) throw new Error('the file is digital silence; there is nothing to normalise');
    const target = args.target ?? { peak: -1, loudness: -16, rms: -20 }[args.mode];
    let gainDb, before, limited = false, unit = 'dBFS';
    if (args.mode === 'peak') { before = adb(peak); gainDb = target - before; }
    else {
      if (args.mode === 'loudness') { const l = loudness(a.ch, a.sr); if (l.integrated === null) throw new Error('integrated loudness is undefined for this file (shorter than 0.4 s, or entirely below the −70 LUFS gate); use mode=peak or mode=rms'); before = l.integrated; unit = 'LUFS'; }
      else before = adb(rmsOf(a.ch));
      gainDb = target - before;
      const tp = adb(Math.max(...a.ch.map((c) => truePeak(c, peak))));
      if (tp + gainDb > args.peakCeiling) { gainDb = args.peakCeiling - tp; limited = true; }
    }
    const g = lin(gainDb);
    const out = a.ch.map((c) => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = c[i] * g; return o; });
    return { ...(await writeOut(out, a.sr, args, args.input, 'norm', a.bitDepth)), mode: args.mode, unit, target, before: r(before, 2), after: r(before + gainDb, 2), gainDb: r(gainDb, 2), peakAfterDb: dB(peak * g), limitedByPeakCeiling: limited || undefined };
  },
});

const CURVES = { linear: (t) => t, equalPower: (t) => Math.sin(t * Math.PI / 2), scurve: (t) => 0.5 - 0.5 * Math.cos(t * Math.PI), exp: (t) => t * t * t, log: (t) => 1 - (1 - t) ** 3 };
register({
  name: 'audio.fade',
  description: 'Apply a fade-in at the start and/or a fade-out at the end of a file. Curves: linear, equalPower (sine), scurve (raised cosine), exp (slow start), log (fast start).',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source audio' },
      fadeIn: { type: 'number', default: 0, minimum: 0, description: 'Fade-in length in seconds from the start' },
      fadeOut: { type: 'number', default: 0, minimum: 0, description: 'Fade-out length in seconds ending at the end of the file' },
      curve: { type: 'string', enum: Object.keys(CURVES), default: 'scurve', description: 'Gain curve shape' },
      ...OUT,
    },
    required: ['input'],
  },
  examples: ['audio.fade input=song.wav fadeIn=0.5 fadeOut=3'],
  async run(args) {
    if (!args.fadeIn && !args.fadeOut) throw new Error('give fadeIn and/or fadeOut (seconds)');
    const a = await load(args.input), n = a.n, f = CURVES[args.curve];
    const ni = Math.min(n, Math.round(args.fadeIn * a.sr)), no = Math.min(n, Math.round(args.fadeOut * a.sr));
    const out = a.ch.map((c) => { const o = Float32Array.from(c); for (let i = 0; i < ni; i++) o[i] *= f(i / ni); for (let i = 0; i < no; i++) o[n - 1 - i] *= f(i / no); return o; });
    return { ...(await writeOut(out, a.sr, args, args.input, 'fade', a.bitDepth)), fadeIn: r(ni / a.sr, 6), fadeOut: r(no / a.sr, 6), curve: args.curve, duration: r(n / a.sr, 6) };
  },
});

const QUALITY = { fast: 8, good: 16, best: 32 };
register({
  name: 'audio.resample',
  description: 'Change the sample rate with band-limited (Kaiser-windowed sinc) interpolation; pitch and duration are preserved, content above the new Nyquist frequency is removed. Use before tools or models that need a fixed rate (e.g. 16000 Hz for speech).',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source audio' },
      sampleRate: { type: 'integer', minimum: 1000, maximum: 384000, description: 'Target sample rate in Hz' },
      quality: { type: 'string', enum: Object.keys(QUALITY), default: 'good', description: 'Sinc length: fast (8 zero crossings), good (16), best (32)' },
      ...OUT,
    },
    required: ['input', 'sampleRate'],
  },
  examples: ['audio.resample input=voice.wav sampleRate=16000'],
  async run(args) {
    const a = await load(args.input);
    checkSize(a.n * args.sampleRate / a.sr, a.ch.length, 'the resampled result');
    const out = a.ch.map((c) => resample(c, args.sampleRate / a.sr, QUALITY[args.quality]));
    return { ...(await writeOut(out, args.sampleRate, args, args.input, `${args.sampleRate}hz`, a.bitDepth)), from: a.sr, to: args.sampleRate, duration: r(out[0].length / args.sampleRate, 6) };
  },
});

register({
  name: 'audio.channels',
  description: 'Rearrange channels. op=mono: average all channels into one. split: write each channel as its own mono file. swap: exchange left and right. pick: keep one channel (index). dup: duplicate a mono file to stereo. merge: combine several mono files (inputs) into one multi-channel file. Returns the written file(s).',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source audio (all ops except merge)' },
      inputs: { type: 'array', items: { type: 'string' }, description: 'For op=merge: mono files in channel order (same sample rate; shorter ones are zero-padded)' },
      op: { type: 'string', enum: ['mono', 'split', 'swap', 'pick', 'dup', 'merge'], default: 'mono', description: 'Operation' },
      index: { type: 'integer', default: 0, minimum: 0, description: 'For op=pick: 0-based channel to keep' },
      ...OUT,
    },
  },
  examples: ['audio.channels input=stereo.wav op=mono', 'audio.channels input=stereo.wav op=split'],
  async run(args) {
    if (args.op === 'merge') {
      if (!args.inputs || args.inputs.length < 2) throw new Error('op=merge needs inputs (2 or more mono files)');
      const chs = []; let sr = 0, depth = null;
      for (const p of args.inputs) { const a = await load(p); sr ||= a.sr; depth ??= a.bitDepth; if (a.sr !== sr) throw new Error(`"${p}" is ${a.sr} Hz but the first input is ${sr} Hz — resample first`); if (a.ch.length !== 1) throw new Error(`"${p}" has ${a.ch.length} channels; merge takes mono files`); chs.push(a.ch[0]); }
      const n = Math.max(...chs.map((c) => c.length));
      const out = chs.map((c) => { if (c.length === n) return c; const o = new Float32Array(n); o.set(c); return o; });
      return { ...(await writeOut(out, sr, args, args.inputs[0], 'merged', depth)), channels: out.length };
    }
    if (!args.input) throw new Error('missing required arg "input"');
    const a = await load(args.input), n = a.ch.length;
    if (args.op === 'split') {
      if (args.format && args.format !== 'wav') throw new Error('op=split writes WAV files only; convert them afterwards');
      const outputs = [];
      for (let c = 0; c < n; c++) { const w = await writeOut([a.ch[c]], a.sr, { bitDepth: args.bitDepth, output: args.output ? args.output.replace(/(\.[A-Za-z0-9]+)?$/, `.${chName(c, n)}.wav`) : undefined }, args.input, chName(c, n), a.bitDepth); outputs.push(w.output); }
      return { outputs, channels: n };
    }
    let out;
    if (args.op === 'mono') out = toChannels(a.ch, 1);
    else if (args.op === 'swap') { if (n !== 2) throw new Error(`op=swap needs a stereo file (this one has ${n} channel${n === 1 ? '' : 's'})`); out = [a.ch[1], a.ch[0]]; }
    else if (args.op === 'pick') { if (args.index >= n) throw new Error(`index ${args.index} is out of range: the file has ${n} channel(s), indices 0…${n - 1}`); out = [a.ch[args.index]]; }
    else { if (n !== 1) throw new Error(`op=dup needs a mono file (this one has ${n} channels)`); out = [a.ch[0], a.ch[0]]; }
    return { ...(await writeOut(out, a.sr, args, args.input, args.op === 'pick' ? chName(args.index, n) : args.op, a.bitDepth)), from: n, to: out.length };
  },
});

register({
  name: 'audio.reverse',
  description: 'Reverse audio in time (play it backwards). Returns the new file.',
  schema: { properties: { input: { type: 'string', description: 'VFS path of the source audio' }, ...OUT }, required: ['input'] },
  examples: ['audio.reverse input=word.wav'],
  async run(args) {
    const a = await load(args.input);
    const out = a.ch.map((c) => Float32Array.from(c).reverse());
    return { ...(await writeOut(out, a.sr, args, args.input, 'rev', a.bitDepth)), duration: r(a.n / a.sr, 6) };
  },
});

register({
  name: 'audio.speed',
  description: 'Change playback speed. mode=resample (default): tape-style — speed 2 halves the duration and raises pitch one octave. mode=stretch: pitch-preserving time-stretch (WSOLA, 40 ms frames) — speed 1.5 is 1.5× faster at the same pitch; good on speech and music between about 0.5× and 2×, increasingly artefact-prone beyond. Returns the new file and durations.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source audio' },
      factor: { type: 'number', minimum: 0.1, maximum: 10, description: 'Speed multiplier: >1 faster/shorter, <1 slower/longer' },
      mode: { type: 'string', enum: ['resample', 'stretch'], default: 'resample', description: 'resample = pitch follows speed; stretch = keep pitch (WSOLA)' },
      ...OUT,
    },
    required: ['input', 'factor'],
  },
  examples: ['audio.speed input=talk.wav factor=1.5 mode=stretch'],
  async run(args, ctx) {
    const a = await load(args.input), f = args.factor;
    checkSize(a.n / f, a.ch.length, 'the result');
    if (args.mode === 'stretch' && (f < 0.25 || f > 4)) throw new Error('mode=stretch accepts factor 0.25 … 4');
    const out = args.mode === 'stretch' ? wsola(a.ch, a.sr, f, (p) => ctx.progress(p, 'stretching')) : a.ch.map((c) => resample(c, 1 / f, 16));
    return { ...(await writeOut(out, a.sr, args, args.input, args.mode === 'stretch' ? 'stretch' : 'speed', a.bitDepth)), factor: f, mode: args.mode, method: args.mode === 'stretch' ? 'WSOLA' : 'sinc resampling', pitchShiftSemitones: args.mode === 'stretch' ? 0 : r(12 * Math.log2(f), 3), sourceDuration: r(a.n / a.sr, 6), duration: r(out[0].length / a.sr, 6) };
  },
});

register({
  name: 'audio.pitchShift',
  description: 'Transpose audio by a number of semitones while keeping its duration (WSOLA time-stretch followed by sinc resampling). +12 = one octave up. Formants move with the pitch, so large shifts of voices sound unnatural.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source audio' },
      semitones: { type: 'number', minimum: -24, maximum: 24, description: 'Shift in semitones (fractions allowed; 1 semitone = 100 cents)' },
      ...OUT,
    },
    required: ['input', 'semitones'],
  },
  examples: ['audio.pitchShift input=voice.wav semitones=-3'],
  async run(args, ctx) {
    const a = await load(args.input), ratio = 2 ** (args.semitones / 12);
    checkSize(a.n * Math.max(1, ratio), a.ch.length, 'the intermediate result');
    const stretched = ratio === 1 ? a.ch : wsola(a.ch, a.sr, 1 / ratio, (p) => ctx.progress(p * 0.8, 'stretching'));
    const out = stretched.map((c) => resample(c, 1 / ratio, 16, a.n));
    return { ...(await writeOut(out, a.sr, args, args.input, 'pitch', a.bitDepth)), semitones: args.semitones, frequencyRatio: r(ratio, 5), duration: r(a.n / a.sr, 6) };
  },
});

register({
  name: 'audio.filter',
  description: 'Biquad (RBJ cookbook) filter: lowpass, highpass, bandpass, notch, peaking EQ, lowshelf, highshelf, allpass. sections cascades identical stages for a steeper slope (12 dB/octave each for low/high-pass); zeroPhase runs it forward and backward (no phase shift, attenuation doubled). Returns the file plus the filter\'s gain in dB at a few probe frequencies.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source audio' },
      type: { type: 'string', enum: FILTER_TYPES, description: 'Filter response' },
      frequency: { type: 'number', minimum: 1, description: 'Cutoff / centre / shelf-midpoint frequency in Hz (must be below half the sample rate)' },
      q: { type: 'number', default: 0.7071, minimum: 0.05, maximum: 100, description: 'Quality factor: 0.707 = Butterworth for low/high-pass; higher = narrower band/notch/peak' },
      gainDb: { type: 'number', default: 0, minimum: -48, maximum: 48, description: 'Boost or cut in dB for peaking, lowshelf and highshelf' },
      sections: { type: 'integer', default: 1, minimum: 1, maximum: 8, description: 'Number of identical cascaded biquad stages' },
      zeroPhase: { type: 'boolean', default: false, description: 'Filter forward then backward for zero phase distortion (squares the magnitude response)' },
      ...OUT,
    },
    required: ['input', 'type', 'frequency'],
  },
  examples: ['audio.filter input=hum.wav type=notch frequency=50 q=30', 'audio.filter input=voice.wav type=highpass frequency=80 sections=2'],
  async run(args) {
    const a = await load(args.input);
    if (args.frequency >= a.sr / 2) throw new Error(`frequency ${args.frequency} Hz must be below the Nyquist frequency (${a.sr / 2} Hz at ${a.sr} Hz sample rate)`);
    const c = biquad(args.type, args.frequency, a.sr, args.q, args.gainDb);
    const out = a.ch.map((x) => {
      let y = x;
      for (let s = 0; s < args.sections; s++) y = applyBiquad(y, c);
      if (args.zeroPhase) { y = Float32Array.from(y).reverse(); for (let s = 0; s < args.sections; s++) y = applyBiquad(y, c); y.reverse(); }
      return y;
    });
    const passes = args.sections * (args.zeroPhase ? 2 : 1), f0 = args.frequency;
    const probes = [...new Set([f0 / 4, f0 / 2, f0, f0 * 2, f0 * 4].filter((f) => f < a.sr / 2).map((f) => Math.round(f * 10) / 10))];
    return { ...(await writeOut(out, a.sr, args, args.input, args.type, a.bitDepth)), type: args.type, frequency: f0, q: args.q, sections: args.sections, zeroPhase: args.zeroPhase,
      response: probes.map((f) => ({ hz: f, db: r(Math.max(-200, passes * adb(biquadGain(c, f, a.sr))), 2) })), peakAfterDb: dB(peakOf(out)) };
  },
});

// ────────────────────────────────────────────────────────── silence ──
/** → {silent: [[s0,s1]…], sound: [[s0,s1]…]} in samples */
function findSilence(a, thresholdDb, minDuration) {
  const win = Math.max(1, Math.round(a.sr * 0.01)), nw = Math.ceil(a.n / win), thr = lin(thresholdDb);
  const loud = new Uint8Array(nw);
  for (const c of a.ch) for (let w = 0; w < nw; w++) { if (loud[w]) continue; const e = Math.min(a.n, (w + 1) * win); for (let i = w * win; i < e; i++) { const v = c[i]; if (v > thr || v < -thr) { loud[w] = 1; break; } } }
  const minW = Math.max(1, Math.round(minDuration * a.sr / win)); const silent = [];
  for (let w = 0; w < nw;) { if (loud[w]) { w++; continue; } let e = w; while (e < nw && !loud[e]) e++; if (e - w >= minW) silent.push([w * win, Math.min(a.n, e * win)]); w = e; }
  const sound = []; let pos = 0;
  for (const [s0, s1] of silent) { if (s0 > pos) sound.push([pos, s0]); pos = s1; }
  if (pos < a.n) sound.push([pos, a.n]);
  return { silent, sound };
}
register({
  name: 'audio.silence',
  description: 'Find silent stretches (every channel below thresholdDb for at least minDuration). mode=detect (default) only reports the silent and non-silent ranges in seconds. mode=strip writes one file with the silences removed. mode=split writes one file per non-silent segment (e.g. to separate words, takes or tracks). Range lists are capped at 100 entries.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source audio' },
      thresholdDb: { type: 'number', default: -50, minimum: -120, maximum: 0, description: 'Sample-peak level in dBFS below which audio counts as silence' },
      minDuration: { type: 'number', default: 0.3, minimum: 0.01, description: 'Shortest silence to report/remove, seconds' },
      mode: { type: 'string', enum: ['detect', 'strip', 'split'], default: 'detect', description: 'detect = report only; strip = remove silences into one file; split = one file per sound segment' },
      padding: { type: 'number', default: 0.05, minimum: 0, maximum: 10, description: 'For strip/split: seconds of the surrounding silence kept on each side of a sound segment' },
      maxParts: { type: 'integer', default: 50, minimum: 1, maximum: 200, description: 'For split: most files to write (extra segments are reported but not written)' },
      output: { type: 'string', description: 'strip: VFS path to write. split: path stem — parts are named <stem>.part-01.wav … (default: derived from input)' },
      bitDepth: OUT.bitDepth,
    },
    required: ['input'],
  },
  examples: ['audio.silence input=dictation.wav', 'audio.silence input=takes.wav mode=split thresholdDb=-40 minDuration=0.8'],
  async run(args) {
    const a = await load(args.input), { silent, sound } = findSilence(a, args.thresholdDb, args.minDuration);
    const sec = (list) => list.slice(0, 100).map(([s0, s1]) => ({ start: r(s0 / a.sr, 3), end: r(s1 / a.sr, 3), duration: r((s1 - s0) / a.sr, 3) }));
    const silentTotal = silent.reduce((s, [x, y]) => s + y - x, 0);
    const res = { duration: r(a.n / a.sr, 6), thresholdDb: args.thresholdDb, minDuration: args.minDuration, silentCount: silent.length, silentSeconds: r(silentTotal / a.sr, 3), silentFraction: r(silentTotal / a.n, 4),
      leadingSilence: silent.length && silent[0][0] === 0 ? r(silent[0][1] / a.sr, 3) : 0, trailingSilence: silent.length && silent.at(-1)[1] === a.n ? r((a.n - silent.at(-1)[0]) / a.sr, 3) : 0,
      silences: sec(silent), segmentCount: sound.length, segments: sec(sound), truncated: silent.length > 100 || sound.length > 100 || undefined };
    if (args.mode === 'detect') return res;
    if (!sound.length) throw new Error(`the whole file is below ${args.thresholdDb} dBFS — nothing would remain. Lower thresholdDb.`);
    const pad = Math.round(args.padding * a.sr), padded = [];
    for (const [s0, s1] of sound) { const x = Math.max(0, s0 - pad), y = Math.min(a.n, s1 + pad); if (padded.length && x <= padded.at(-1)[1]) padded.at(-1)[1] = y; else padded.push([x, y]); }
    if (args.mode === 'strip') {
      const total = padded.reduce((s, [x, y]) => s + y - x, 0);
      const out = a.ch.map((c) => { const o = new Float32Array(total); let p = 0; for (const [x, y] of padded) { o.set(c.subarray(x, y), p); p += y - x; } return o; });
      return { ...(await writeOut(out, a.sr, { output: args.output, bitDepth: args.bitDepth }, args.input, 'nosilence', a.bitDepth)), removedSeconds: r((a.n - total) / a.sr, 3), newDuration: r(total / a.sr, 6), ...res };
    }
    const stem = args.output ? args.output.replace(/\.[A-Za-z0-9]+$/, '') : vfs.stemOf(args.input), outputs = [];
    const digits = Math.max(2, String(Math.min(padded.length, args.maxParts)).length);
    for (const [k, [x, y]] of padded.slice(0, args.maxParts).entries()) {
      const w = await writeOut(sub(a, x, y), a.sr, { output: `${stem}.part-${String(k + 1).padStart(digits, '0')}.wav`, bitDepth: args.bitDepth }, args.input, 'part', a.bitDepth);
      vfs.setMeta(w.output.path, { start: r(x / a.sr, 3) }); outputs.push({ ...w.output, start: r(x / a.sr, 3) });
    }
    return { outputs, written: outputs.length, notWritten: Math.max(0, padded.length - args.maxParts) || undefined, ...res };
  },
});

// ═══════════════════════════════════════════════════════ measuring ══
function percentile(arr, f) { if (!arr.length) return NaN; const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))]; }
function channelStats(x, sr) {
  const n = x.length; let peak = 0, sum = 0, sq = 0, clip = 0, runs = 0, run = 0, zc = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i], av = v < 0 ? -v : v;
    if (av > peak) peak = av; sum += v; sq += v * v;
    if (av >= 0.999) { clip++; run++; if (run === 3) runs++; } else run = 0;
    if (v !== 0) { const s = v > 0 ? 1 : -1; if (prev && s !== prev) zc++; prev = s; }
  }
  const rms = Math.sqrt(sq / n), tp = truePeak(x, peak);
  const win = Math.max(1, Math.round(sr * 0.05)), levels = [];
  for (let s = 0; s + win <= n; s += win) { let e = 0; for (let i = s; i < s + win; i++) e += x[i] * x[i]; if (e > 0) levels.push(10 * Math.log10(e / win)); }
  const floor = levels.length >= 4 ? percentile(levels, 0.05) : NaN;
  return { peak, tp, rms, dc: sum / n, clip, runs, zc, floor, n };
}
const statsOut = (s, sr) => ({
  peak: r(s.peak, 5), peakDb: dB(s.peak), truePeakDb: dB(s.tp), rms: r(s.rms, 5), rmsDb: dB(s.rms), crestFactorDb: s.rms > 0 ? r(adb(s.peak / s.rms), 2) : null,
  dcOffset: r(s.dc, 6), clippedSamples: s.clip, clippedRuns: s.runs, zeroCrossingsPerSecond: r(s.zc / (s.n / sr), 1),
  noiseFloorDb: r(s.floor, 2), dynamicRangeDb: Number.isFinite(s.floor) && s.peak > 0 ? r(adb(s.peak) - s.floor, 2) : null,
});
register({
  name: 'audio.stats', readOnly: true,
  description: 'Level statistics of a file or a time range: sample peak and true-peak estimate (4× oversampled), RMS, crest factor, DC offset, clipping (samples ≥ 0.999 full scale and flat-topped runs of ≥3), zero-crossing rate, noise floor (5th percentile of 50 ms RMS windows) and dynamic range (peak − noise floor), per channel and overall; plus integrated loudness in LUFS (ITU-R BS.1770-4: K-weighting, 400 ms blocks, −70 LUFS absolute and −10 LU relative gates), max momentary/short-term loudness and loudness range (EBU Tech 3342). dB values are dBFS with rmsDb = 20·log10(rms), so a full-scale sine reads peak 0, rms −3.01. null means −∞ (digital silence) or undefined for this length.',
  schema: {
    properties: { input: { type: 'string', description: 'VFS path of the audio file' }, ...RANGE },
    required: ['input'],
  },
  examples: ['audio.stats input=master.wav'],
  async run(args) {
    const a = await load(args.input), [s0, s1] = range(a, args), chs = sub(a, s0, s1);
    const per = chs.map((c) => channelStats(c, a.sr)), n = s1 - s0;
    const all = { peak: Math.max(...per.map((p) => p.peak)), tp: Math.max(...per.map((p) => p.tp)), rms: Math.sqrt(per.reduce((s, p) => s + p.rms * p.rms, 0) / per.length), dc: per.reduce((s, p) => s + p.dc, 0) / per.length,
      clip: per.reduce((s, p) => s + p.clip, 0), runs: per.reduce((s, p) => s + p.runs, 0), zc: per.reduce((s, p) => s + p.zc, 0) / per.length, floor: Math.min(...per.map((p) => p.floor)), n };
    if (per.some((p) => Number.isNaN(p.floor))) all.floor = NaN;
    const l = loudness(chs, a.sr);
    return {
      duration: r(n / a.sr, 6), sampleRate: a.sr, channels: chs.length, frames: n,
      overall: statsOut(all, a.sr),
      loudness: { integratedLufs: r(l.integrated, 2), momentaryMaxLufs: r(l.momentaryMax, 2), shortTermMaxLufs: r(l.shortTermMax, 2), loudnessRangeLu: r(l.range, 2), blocks: l.blocks, gatedBlocks: l.gatedBlocks,
        method: 'ITU-R BS.1770-4 K-weighting + gating' + (a.sr === 48000 ? '' : ` (filter coefficients re-derived for ${a.sr} Hz)`) + (l.integrated === null ? '; null = shorter than one 400 ms block or entirely below the −70 LUFS gate' : '') },
      perChannel: chs.length > 1 ? per.slice(0, 8).map((p, i) => ({ channel: chName(i, chs.length), ...statsOut(p, a.sr) })) : undefined,
      truncated: chs.length > 8 || undefined,
    };
  },
});

/** Welch-averaged power spectrum of x. Returns {p: Float64Array(bins), st, frames, binHz}. p is scaled so a full-scale sine peaks at 1. */
function averageSpectrum(x, sr, fftSize, window) {
  const st = new STFT(fftSize, window), p = new Float64Array(st.bins), tmp = new Float32Array(st.bins);
  let hop = fftSize >> 1, centers = [];
  if (x.length <= fftSize) centers = [x.length / 2];
  else { const count = Math.floor((x.length - fftSize) / hop) + 1; if (count > 4000) hop = Math.floor((x.length - fftSize) / 3999); for (let s = 0; s + fftSize <= x.length; s += hop) centers.push(s + fftSize / 2); }
  for (const c of centers) { st.power(x, c, tmp); for (let k = 0; k < st.bins; k++) p[k] += tmp[k]; }
  for (let k = 0; k < st.bins; k++) p[k] /= centers.length;
  return { p, st, frames: centers.length, binHz: sr / fftSize };
}
function spectralPeaks(p, binHz, count, rangeDb, lo = 1, hann = false) {
  const cand = [];
  for (let k = Math.max(1, lo); k < p.length - 1; k++) {
    if (!(p[k] > p[k - 1] && p[k] >= p[k + 1])) continue;
    let ok = true; for (let j = Math.max(1, k - 3); j <= Math.min(p.length - 1, k + 3); j++) if (p[j] > p[k]) { ok = false; break; }
    if (!ok || p[k] <= 0) continue;
    if (hann) { // Grandke interpolation: exact for a stationary sine under a Hann window
      const up = p[k + 1] >= p[k - 1], al = Math.sqrt((up ? p[k + 1] : p[k - 1]) / p[k]), dl = (2 * al - 1) / (al + 1), d = up ? dl : -dl;
      const corr = Math.abs(dl) > 1e-6 ? (Math.PI * dl / Math.sin(Math.PI * dl)) * (1 - dl * dl) : 1;
      cand.push({ hz: (k + d) * binHz, db: pdb(p[k]) + adb(corr) });
      continue;
    }
    const a = pdb(p[k - 1] || 1e-30), b = pdb(p[k]), c = pdb(p[k + 1] || 1e-30), den = a - 2 * b + c, d = den < 0 ? 0.5 * (a - c) / den : 0;
    cand.push({ hz: (k + d) * binHz, db: b - 0.25 * (a - c) * d });
  }
  cand.sort((x, y) => y.db - x.db);
  const top = cand.length ? cand[0].db : 0;
  return cand.filter((c) => c.db >= top - rangeDb).slice(0, count);
}
register({
  name: 'audio.spectrum', readOnly: true,
  description: 'Averaged FFT magnitude spectrum of a file or time range: the strongest spectral peaks (interpolated Hz, dB, nearest note), spectral centroid, spread, rolloff, flatness (0 = pure tone, 1 = white noise) and energy per octave or third-octave band. Use to find what frequencies are present (tones, hum, harmonics) or to compare tonal balance. Levels are dB re a full-scale sine (a 0 dBFS sine reads 0 dB).',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the audio file' },
      ...RANGE,
      channel: { type: 'string', default: 'mix', description: '"mix" (average of all channels) or a 0-based channel index' },
      fftSize: { type: 'integer', default: 8192, enum: [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536], description: 'FFT length (power of two). Bin spacing = sampleRate ÷ fftSize; larger separates close tones better' },
      window: { type: 'string', enum: WINDOWS, default: 'hann', description: 'Analysis window' },
      peaks: { type: 'integer', default: 10, minimum: 0, maximum: 50, description: 'How many of the strongest peaks to return (max 50)' },
      peakRangeDb: { type: 'number', default: 80, minimum: 1, maximum: 200, description: 'Ignore peaks more than this many dB below the strongest' },
      bands: { type: 'string', enum: ['octave', 'third', 'none'], default: 'octave', description: 'Band-energy table: octave (≈10 bands), third-octave (≈30 bands) or none' },
      rolloffPercent: { type: 'number', default: 85, minimum: 1, maximum: 99.9, description: 'Rolloff = frequency below which this percentage of the energy lies' },
    },
    required: ['input'],
  },
  examples: ['audio.spectrum input=tone.wav peaks=5', 'audio.spectrum input=mix.wav bands=third start=10 end=20'],
  async run(args) {
    const a = await load(args.input), [s0, s1] = range(a, args), x = pick(a, args.channel, s0, s1);
    const { p, st, frames, binHz } = averageSpectrum(x, a.sr, args.fftSize, args.window);
    let tot = 0, cen = 0; for (let k = 1; k < p.length; k++) { tot += p[k]; cen += p[k] * k * binHz; }
    const res = { duration: r((s1 - s0) / a.sr, 6), sampleRate: a.sr, fftSize: args.fftSize, window: args.window, binHz: r(binHz, 4), framesAveraged: frames };
    if (!(tot > 0)) return { ...res, silent: true, peaks: [], note: 'the selection is digital silence' };
    const centroid = cen / tot; let spread = 0, acc = 0, roll = 0, logSum = 0;
    for (let k = 1; k < p.length; k++) { spread += p[k] * (k * binHz - centroid) ** 2; logSum += Math.log(p[k] + 1e-30); }
    for (let k = 1; k < p.length; k++) { acc += p[k]; if (acc >= tot * args.rolloffPercent / 100) { roll = k * binHz; break; } }
    const peaks = spectralPeaks(p, binHz, args.peaks, args.peakRangeDb, 1, args.window === 'hann').map((pk) => { const nt = noteOf(pk.hz); return { hz: r(pk.hz, 2), db: r(pk.db, 2), note: nt && pk.hz >= 16 ? nt.note : undefined, cents: nt && pk.hz >= 16 ? nt.cents : undefined }; });
    Object.assign(res, {
      peaks, dominantHz: peaks[0]?.hz ?? null,
      centroidHz: r(centroid, 1), spreadHz: r(Math.sqrt(spread / tot), 1), rolloffHz: r(roll, 1), rolloffPercent: args.rolloffPercent,
      flatness: r(Math.exp(logSum / (p.length - 1)) / (tot / (p.length - 1)), 5), totalDb: r(pdb(tot / st.enbw), 2),
    });
    if (args.bands !== 'none') {
      const frac = args.bands === 'third' ? 3 : 1, bands = [], half = 2 ** (1 / (2 * frac));
      for (let i = -6 * frac; i <= 5 * frac; i++) {
        const fc = 1000 * 2 ** (i / frac), lo = fc / half, hi = fc * half; if (lo >= a.sr / 2 || hi < binHz) continue;
        let e = 0; for (let k = Math.max(1, Math.ceil(lo / binHz)); k < p.length && k * binHz < hi; k++) e += p[k];
        bands.push({ hz: r(fc, fc < 100 ? 1 : 0), db: r(pdb(e / st.enbw), 2) });
      }
      res.bands = bands; res.bandsNote = `${args.bands === 'third' ? 'third-octave' : 'octave'} bands by centre frequency; db = energy in the band re a full-scale sine; null = no energy or narrower than one FFT bin`;
    }
    return res;
  },
});

// ═════════════════════════════════════════════════════════ drawing ══
const IMG_ARGS = {
  width: { type: 'integer', default: 1280, minimum: 320, maximum: 8192, description: 'Image width in pixels, axes included' },
  height: { type: 'integer', default: 560, minimum: 160, maximum: 4096, description: 'Image height in pixels, axes included' },
};
function panelsOf(a, channel, s0, s1) {
  if (channel === 'all') { const n = Math.min(4, a.ch.length); return Array.from({ length: n }, (_, i) => ({ label: chName(i, a.ch.length), x: a.ch[i].subarray(s0, s1) })); }
  return [{ label: channel === 'mix' || channel === undefined ? (a.ch.length > 1 ? 'mix' : 'mono') : chName(Number(channel), a.ch.length), x: pick(a, channel, s0, s1) }];
}
function title(g, th, W, left, text, right) {
  g.font = FONT(13, true); g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = th.fg; g.fillText(text, left, 13, W - left - 20 - (right ? g.measureText(right).width : 0));
  if (right) { g.font = FONT(12); g.textAlign = 'right'; g.fillStyle = th.dim; g.fillText(right, W - 10, 13); }
}

register({
  name: 'audio.spectrogram',
  description: 'Render a spectrogram PNG: time on the x axis (seconds), frequency on the y axis (linear, log or mel-spaced, labelled in Hz), colour = level in dB with a labelled colour bar. This is the main way for a vision model to "hear" a file: speech formants, notes, chirps, hum, clicks and dropouts are all visible. Returns the image plus the exact plot rectangle and axis ranges so pixels can be mapped back to seconds and Hz. Wider image or smaller hop = finer time detail; larger fftSize = finer frequency detail.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the audio file' },
      ...RANGE,
      channel: { type: 'string', default: 'mix', description: '"mix" (average), a 0-based channel index, or "all" for one stacked panel per channel (max 4)' },
      scale: { type: 'string', enum: ['linear', 'log', 'mel'], default: 'linear', description: 'Frequency axis: linear (equal Hz), log (equal octaves; best for music), mel (perceptual; best for speech)' },
      fftSize: { type: 'integer', enum: [128, 256, 512, 1024, 2048, 4096, 8192, 16384], description: 'Window length in samples (default ≈ 40 ms: 2048 at 44.1/48 kHz). Smaller = sharper in time, blurrier in frequency' },
      hop: { type: 'integer', minimum: 1, description: 'Samples between columns. Default: chosen so the range fills the image width. If given, the plot becomes exactly one column per hop and width is recomputed (max 8192 columns)' },
      window: { type: 'string', enum: WINDOWS, default: 'hann', description: 'Analysis window' },
      minHz: { type: 'number', minimum: 0, description: 'Lowest frequency shown (default 0 for linear/mel, 20 for log)' },
      maxHz: { type: 'number', minimum: 1, description: 'Highest frequency shown (default: Nyquist = sampleRate ÷ 2)' },
      dbRange: { type: 'number', default: 90, minimum: 10, maximum: 200, description: 'Dynamic range of the colour scale in dB below the top' },
      dbMax: { type: 'number', description: 'Level mapped to the brightest colour, dB re full-scale sine (default: the loudest value in the image)' },
      colormap: { type: 'string', enum: COLORMAPS, default: 'magma', description: 'magma / inferno / viridis (perceptually uniform), phosphor (green CRT), amber, gray (white = loud), ink (black on white, prints well)' },
      grid: { type: 'boolean', default: false, description: 'Draw faint grid lines at the axis ticks' },
      ...IMG_ARGS,
      output: { type: 'string', description: 'VFS path of the PNG (default: <input>.spectrogram.png)' },
    },
    required: ['input'],
  },
  examples: ['audio.spectrogram input=speech.wav scale=mel maxHz=8000', 'audio.spectrogram input=song.wav scale=log colormap=phosphor width=1600'],
  async run(args, ctx) {
    const a = await load(args.input), [s0, s1] = range(a, args), nsel = s1 - s0;
    const panels = panelsOf(a, args.channel, s0, s1), th = theme(args.colormap), table = lut(args.colormap);
    const N = args.fftSize || Math.min(16384, Math.max(128, nextPow2(a.sr * 0.04)));
    const ML = 66, MR = 86, MT = 28, MB = 44, GAP = 12;
    let W = args.width, plotW = W - ML - MR;
    if (args.hop) { plotW = Math.ceil(nsel / args.hop); if (plotW > 8192) throw new Error(`hop=${args.hop} gives ${plotW} columns for this range; the maximum is 8192 — raise hop to ≥ ${Math.ceil(nsel / 8192)} or shorten the range`); plotW = Math.max(16, plotW); W = plotW + ML + MR; }
    const H = args.height, plotH = Math.floor((H - MT - MB - GAP * (panels.length - 1)) / panels.length);
    if (plotH < 40) throw new Error('height is too small for this many channel panels; raise height or pick one channel');
    const nyq = a.sr / 2, fmax = Math.min(args.maxHz ?? nyq, nyq), fmin = args.minHz ?? (args.scale === 'log' ? Math.min(20, fmax / 4) : 0);
    if (args.scale === 'log' && fmin <= 0) throw new Error('minHz must be > 0 for scale=log');
    if (fmin >= fmax) throw new Error(`minHz (${fmin}) must be below maxHz (${fmax})`);
    const S = SCALES[args.scale], u0 = S.f(fmin), u1 = S.f(fmax), binHz = a.sr / N;
    // per-row bin lookup: rows spanning ≥1 bin take the max of those bins, narrower rows interpolate
    const rowLo = new Float32Array(plotH), rowHi = new Float32Array(plotH);
    for (let y = 0; y < plotH; y++) { rowHi[y] = S.inv(u1 - (y / plotH) * (u1 - u0)) / binHz; rowLo[y] = S.inv(u1 - ((y + 1) / plotH) * (u1 - u0)) / binHz; }
    const st = new STFT(N, args.window), col = new Float32Array(st.bins), tmp = new Float32Array(st.bins);
    const hopEff = nsel / plotW, sub2 = Math.min(8, Math.max(1, Math.ceil(hopEff / N)));
    const data = panels.map(() => new Float32Array(plotW * plotH)); let top = -Infinity;
    panels.forEach((pn, pi) => {
      const d = data[pi];
      for (let x = 0; x < plotW; x++) {
        if (sub2 === 1) st.power(pn.x, (x + 0.5) * hopEff, col);
        else { col.fill(0); for (let q = 0; q < sub2; q++) { st.power(pn.x, (x + (q + 0.5) / sub2) * hopEff, tmp); for (let k = 0; k < st.bins; k++) if (tmp[k] > col[k]) col[k] = tmp[k]; } }
        for (let y = 0; y < plotH; y++) {
          const lo = rowLo[y], hi = rowHi[y]; let v;
          const k0 = Math.ceil(lo), k1 = Math.floor(hi);
          if (k1 >= k0) { v = 0; for (let k = Math.max(0, k0); k <= k1 && k < st.bins; k++) if (col[k] > v) v = col[k]; }
          else { const c = (lo + hi) / 2, k = Math.min(st.bins - 2, Math.max(0, Math.floor(c))), f = c - k; v = col[k] + (col[k + 1] - col[k]) * f; }
          const dbv = v > 1e-20 ? 10 * Math.log10(v) : -200;
          d[y * plotW + x] = dbv; if (dbv > top) top = dbv;
        }
        if ((x & 127) === 0) ctx.progress((pi + x / plotW) / panels.length, 'fft');
      }
    });
    const dbTop = args.dbMax ?? (top > -190 ? Math.ceil(top) : 0), dbFloor = dbTop - args.dbRange;
    const cv = canvasOf(W, H), g = cv.getContext('2d');
    g.fillStyle = th.bg; g.fillRect(0, 0, W, H);
    const t0 = s0 / a.sr, t1 = s1 / a.sr, rects = [];
    panels.forEach((pn, pi) => {
      const rect = { x: ML, y: MT + pi * (plotH + GAP), w: plotW, h: plotH }; rects.push(rect);
      const im = g.createImageData(plotW, plotH), px = im.data, d = data[pi];
      for (let i = 0, j = 0; i < d.length; i++, j += 4) { let v = (d[i] - dbFloor) / args.dbRange; v = v < 0 ? 0 : v > 1 ? 1 : v; const k = Math.round(v * 255) * 3; px[j] = table[k]; px[j + 1] = table[k + 1]; px[j + 2] = table[k + 2]; px[j + 3] = 255; }
      g.putImageData(im, rect.x, rect.y);
      // frequency axis
      g.font = FONT(12); g.textAlign = 'right'; g.textBaseline = 'middle'; g.lineWidth = 1;
      for (const f of freqTicks(args.scale, fmin, fmax, plotH)) {
        const y = Math.round(rect.y + (1 - (S.f(Math.max(f, args.scale === 'log' ? fmin : 0)) - u0) / (u1 - u0)) * plotH) + 0.5;
        if (y < rect.y - 1 || y > rect.y + plotH + 1) continue;
        if (args.grid) { g.strokeStyle = th.grid; g.beginPath(); g.moveTo(rect.x, y); g.lineTo(rect.x + plotW, y); g.stroke(); }
        g.strokeStyle = th.fg; g.beginPath(); g.moveTo(rect.x - 5, y); g.lineTo(rect.x, y); g.stroke();
        g.fillStyle = th.fg; g.fillText(fmtHz(f), rect.x - 8, Math.min(rect.y + plotH - 5, Math.max(rect.y + 5, y)));
      }
      drawTimeAxis(g, th, rect, t0, t1, { labels: pi === panels.length - 1, grid: args.grid });
      frame(g, th, rect);
      if (panels.length > 1 || a.ch.length > 1) { g.font = FONT(12, true); const tw = g.measureText(pn.label).width + 10; g.fillStyle = th.bg; g.globalAlpha = 0.75; g.fillRect(rect.x + 4, rect.y + 4, tw, 18); g.globalAlpha = 1; g.fillStyle = th.fg; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(pn.label, rect.x + 9, rect.y + 13); }
    });
    // axis captions
    g.font = FONT(12); g.fillStyle = th.dim; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.fillText(t1 >= 600 ? 'time (m:ss)' : 'time (s)', ML + plotW / 2, H - 5);
    g.save(); g.translate(13, MT + (H - MT - MB) / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle'; g.fillText(`frequency (Hz, ${args.scale})`, 0, 0); g.restore();
    // colour bar
    const barX = ML + plotW + 16, barY = MT, barH = H - MT - MB, bar = g.createImageData(14, barH);
    for (let y = 0; y < barH; y++) { const k = Math.round((1 - y / (barH - 1)) * 255) * 3; for (let x = 0; x < 14; x++) { const j = (y * 14 + x) * 4; bar.data[j] = table[k]; bar.data[j + 1] = table[k + 1]; bar.data[j + 2] = table[k + 2]; bar.data[j + 3] = 255; } }
    g.putImageData(bar, barX, barY); frame(g, th, { x: barX, y: barY, w: 14, h: barH });
    g.font = FONT(12); g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = th.fg;
    for (const v of linTicks(dbFloor, dbTop, Math.max(2, Math.floor(barH / 50))).ticks) { const y = Math.round(barY + (1 - (v - dbFloor) / args.dbRange) * barH) + 0.5; g.strokeStyle = th.fg; g.beginPath(); g.moveTo(barX + 14, y); g.lineTo(barX + 18, y); g.stroke(); g.fillText(`${v}`, barX + 21, Math.min(barY + barH - 6, Math.max(barY + 6, y))); }
    g.fillStyle = th.dim; g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText('dB', W - 8, H - 5);
    title(g, th, W, ML, vfs.stat(args.input).path, `${a.sr} Hz · fft ${N} ${args.window} · hop ${r(hopEff, 1)}`);
    const out = await saveCanvas(cv, vfs.out(args.output, args.input, 'spectrogram', 'png'), { meta: { kind: 'spectrogram' } });
    return {
      output: out, plot: { x: ML, y: rects[0].y, width: plotW, height: plotH }, panels: panels.map((pn, i) => ({ channel: pn.label, y: rects[i].y, height: plotH })),
      time: { start: r(t0, 6), end: r(t1, 6), secondsPerPixel: r((t1 - t0) / plotW, 6) }, frequency: { scale: args.scale, minHz: r(fmin, 2), maxHz: r(fmax, 2) },
      db: { top: dbTop, floor: dbFloor, reference: 'full-scale sine = 0 dB' }, fftSize: N, hopSamples: r(hopEff, 2), window: args.window, colormap: args.colormap,
      framesPerColumn: sub2 > 1 ? sub2 : undefined, channelsNotShown: args.channel === 'all' && a.ch.length > 4 ? a.ch.length - 4 : undefined,
      howToRead: 'x pixel → time = start + (px − plot.x) ÷ plot.width × (end − start); top of a panel = maxHz, bottom = minHz on the stated scale; brighter (or darker for ink) = louder',
    };
  },
});

/** Draw waveform panels onto a canvas. Returns {canvas, rects, plotW, plotH, yMax}. */
function renderWaveform(a, s0, s1, o) {
  const panels = panelsOf(a, o.channel, s0, s1), th = theme(o.theme), W = o.width, H = o.height;
  const ML = o.bare ? 0 : 58, MR = o.bare ? 0 : 16, MT = o.bare ? 0 : 28, MB = o.bare ? 0 : 44, GAP = o.bare ? 2 : 12;
  const plotW = W - ML - MR, plotH = Math.floor((H - MT - MB - GAP * (panels.length - 1)) / panels.length), nsel = s1 - s0;
  if (plotH < 24) throw new Error('height is too small for this many channel panels; raise height or pick one channel');
  let peak = 0; for (const p of panels) for (let i = 0; i < p.x.length; i++) { const v = p.x[i] < 0 ? -p.x[i] : p.x[i]; if (v > peak) peak = v; }
  const yMax = o.scale === 'fit' ? (peak > 0 ? peak * 1.05 : 1) : peak > 1 ? peak * 1.02 : 1;
  const cv = canvasOf(W, H), g = cv.getContext('2d'); g.fillStyle = th.bg; g.fillRect(0, 0, W, H);
  const t0 = s0 / a.sr, t1 = s1 / a.sr, rects = [];
  panels.forEach((pn, pi) => {
    const rect = { x: ML, y: MT + pi * (plotH + GAP), w: plotW, h: plotH }; rects.push(rect);
    const mid = rect.y + plotH / 2, sy = (plotH / 2) / yMax, x = pn.x;
    if (!o.bare) {
      g.font = FONT(12); g.textAlign = 'right'; g.textBaseline = 'middle'; g.lineWidth = 1;
      for (const v of linTicks(-yMax, yMax, Math.max(2, Math.floor(plotH / 40))).ticks) {
        const y = Math.round(mid - v * sy) + 0.5; if (y < rect.y - 1 || y > rect.y + plotH + 1) continue;
        g.strokeStyle = v === 0 ? th.zero : th.grid; g.beginPath(); g.moveTo(rect.x, y); g.lineTo(rect.x + plotW, y); g.stroke();
        g.strokeStyle = th.fg; g.beginPath(); g.moveTo(rect.x - 5, y); g.lineTo(rect.x, y); g.stroke();
        g.fillStyle = th.fg; g.fillText(`${+v.toFixed(3)}`, rect.x - 8, Math.min(rect.y + plotH - 5, Math.max(rect.y + 5, y)));
      }
    }
    g.save(); g.beginPath(); g.rect(rect.x, rect.y, plotW, plotH); g.clip();
    if (nsel <= plotW * 2) { // few samples: draw the actual curve
      g.strokeStyle = th.wave; g.lineWidth = 1.5; g.beginPath();
      for (let i = 0; i < nsel; i++) { const px = rect.x + (i + 0.5) / nsel * plotW, py = mid - x[i] * sy; if (i) g.lineTo(px, py); else g.moveTo(px, py); }
      g.stroke();
    } else {
      const rmsTop = new Float32Array(plotW);
      g.fillStyle = th.wave;
      for (let c = 0; c < plotW; c++) {
        const i0 = Math.floor(c * nsel / plotW), i1 = Math.max(i0 + 1, Math.floor((c + 1) * nsel / plotW)); let mn = Infinity, mx = -Infinity, e = 0;
        for (let i = i0; i < i1; i++) { const v = x[i]; if (v < mn) mn = v; if (v > mx) mx = v; e += v * v; }
        rmsTop[c] = Math.sqrt(e / (i1 - i0));
        const y0 = mid - mx * sy, y1 = mid - mn * sy; g.fillRect(rect.x + c, Math.floor(y0), 1, Math.max(1, Math.ceil(y1 - y0)));
      }
      if (o.rms) { g.fillStyle = th.rms; g.globalAlpha = 0.85; for (let c = 0; c < plotW; c++) { const hgt = rmsTop[c] * sy; if (hgt >= 0.5) g.fillRect(rect.x + c, Math.floor(mid - hgt), 1, Math.max(1, Math.round(hgt * 2))); } g.globalAlpha = 1; }
    }
    g.restore();
    if (!o.bare) {
      drawTimeAxis(g, th, rect, t0, t1, { labels: pi === panels.length - 1, grid: true }); frame(g, th, rect);
      if (panels.length > 1 || a.ch.length > 1) { g.font = FONT(12, true); g.fillStyle = th.fg; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(pn.label, rect.x + 8, rect.y + 12); }
    }
  });
  if (!o.bare) {
    g.font = FONT(12); g.fillStyle = th.dim; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(t1 >= 600 ? 'time (m:ss)' : 'time (s)', ML + plotW / 2, H - 5);
    g.save(); g.translate(12, MT + (H - MT - MB) / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle'; g.fillText('amplitude', 0, 0); g.restore();
    title(g, th, W, ML, o.title || '', `${a.sr} Hz · ${a.ch.length} ch · peak ${peak > 0 ? adb(peak).toFixed(1) : '−∞'} dBFS${o.rms && nsel > plotW * 2 ? ' · inner band = RMS' : ''}`);
  }
  return { canvas: cv, rects, plotW, plotH, yMax, peak, panels };
}
register({
  name: 'audio.waveform',
  description: 'Render a waveform PNG: amplitude (−1…+1 full scale) against time in seconds, drawn as the min/max envelope per pixel column with an optional RMS band inside it, one panel per channel. Use to see structure at a glance: where sound and silence are, clipping, fades, loudness changes. Zoom with start/end; under two samples per pixel the actual curve is drawn. Returns the image plus the plot rectangle and ranges.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the audio file' },
      ...RANGE,
      channel: { type: 'string', default: 'all', description: '"all" = one panel per channel (max 4), "mix" = average of channels, or a 0-based channel index' },
      rms: { type: 'boolean', default: true, description: 'Overlay the RMS level per pixel column as an inner band' },
      scale: { type: 'string', enum: ['full', 'fit'], default: 'full', description: 'full = y axis spans ±1.0 (true level visible); fit = zoom the y axis to the peak (quiet files become readable)' },
      theme: { type: 'string', enum: ['dark', 'light', 'phosphor', 'amber'], default: 'dark', description: 'Colours: dark, light (white background), phosphor (green on black), amber' },
      ...IMG_ARGS, height: { ...IMG_ARGS.height, default: 420 },
      output: { type: 'string', description: 'VFS path of the PNG (default: <input>.waveform.png)' },
    },
    required: ['input'],
  },
  examples: ['audio.waveform input=take.wav', 'audio.waveform input=take.wav start=1.2 end=1.25 scale=fit'],
  async run(args) {
    const a = await load(args.input), [s0, s1] = range(a, args);
    const w = renderWaveform(a, s0, s1, { ...args, title: vfs.stat(args.input).path });
    const out = await saveCanvas(w.canvas, vfs.out(args.output, args.input, 'waveform', 'png'), { meta: { kind: 'waveform' } });
    return { output: out, plot: { x: w.rects[0].x, y: w.rects[0].y, width: w.plotW, height: w.plotH }, panels: w.panels.map((p, i) => ({ channel: p.label, y: w.rects[i].y, height: w.plotH })),
      time: { start: r(s0 / a.sr, 6), end: r(s1 / a.sr, 6), secondsPerPixel: r((s1 - s0) / a.sr / w.plotW, 6) }, amplitude: { min: r(-w.yMax, 4), max: r(w.yMax, 4) }, peakDb: dB(w.peak),
      drawn: s1 - s0 <= w.plotW * 2 ? 'sample curve' : `min/max envelope${args.rms ? ' + RMS band' : ''}`, channelsNotShown: args.channel === 'all' && a.ch.length > 4 ? a.ch.length - 4 : undefined };
  },
});

// ═════════════════════════════════════════════ pitch, onsets, tempo ══
register({
  name: 'audio.pitch', readOnly: true,
  description: 'Track the fundamental frequency (YIN algorithm) of a monophonic sound — a voice, a single instrument, a tone. Returns the median f0 with its note name and cents offset, the voiced fraction, a list of detected notes (start, end, note, Hz; capped at 100) and a down-sampled f0 track (capped at maxPoints). Give output=<file>.csv to save the full frame-by-frame track. Not meant for chords or full mixes (it reports one pitch at a time).',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the audio file' },
      ...RANGE,
      minHz: { type: 'number', default: 60, minimum: 20, maximum: 2000, description: 'Lowest pitch to look for (lower = longer analysis window)' },
      maxHz: { type: 'number', default: 1200, minimum: 50, maximum: 8000, description: 'Highest pitch to look for' },
      hop: { type: 'number', default: 0.01, minimum: 0.001, maximum: 1, description: 'Seconds between pitch estimates' },
      threshold: { type: 'number', default: 0.15, minimum: 0.01, maximum: 0.9, description: 'YIN aperiodicity threshold: lower = stricter (fewer, surer voiced frames)' },
      a4: { type: 'number', default: 440, minimum: 380, maximum: 480, description: 'Reference tuning of A4 in Hz for note names' },
      maxPoints: { type: 'integer', default: 60, minimum: 0, maximum: 500, description: 'Most track points to return inline (evenly thinned)' },
      output: { type: 'string', description: 'Optional VFS path for the full track as CSV (time_s,f0_hz,note,cents,clarity)' },
    },
    required: ['input'],
  },
  examples: ['audio.pitch input=sung.wav', 'audio.pitch input=flute.wav minHz=200 maxHz=2500 output=flute.f0.csv'],
  async run(args) {
    const a = await load(args.input), [s0, s1] = range(a, args);
    if (args.minHz >= args.maxHz) throw new Error('minHz must be below maxHz');
    let x = monoOf(a.ch, s0, s1), sr = a.sr;
    const D = Math.floor(sr / Math.max(16000, args.maxHz * 8));
    if (D >= 2) { x = resample(x, 1 / D, 8); sr /= D; }
    const { times, f0, clarity, window } = yin(x, sr, { fmin: args.minHz, fmax: args.maxHz, hop: Math.max(1, Math.round(args.hop * sr)), threshold: args.threshold });
    if (!times.length) throw new Error(`the selection (${r((s1 - s0) / a.sr, 3)} s) is shorter than one analysis window (${r(window / sr, 3)} s at minHz=${args.minHz}); raise minHz or use a longer range`);
    const t0 = s0 / a.sr, voiced = []; for (let i = 0; i < f0.length; i++) if (f0[i] > 0) voiced.push(f0[i]);
    // notes: runs of frames on the same semitone (bridging gaps of ≤ 2 frames), at least 3 frames long
    const notes = []; let cur = null; const hopS = times.length > 1 ? times[1] - times[0] : args.hop;
    const close = () => { if (cur && cur.count >= 3) { cur.hz.sort((p, q) => p - q); const hz = cur.hz[cur.hz.length >> 1], nt = noteOf(hz, args.a4); notes.push({ start: r(t0 + cur.start - hopS / 2, 3), end: r(t0 + cur.end + hopS / 2, 3), note: nt.note, hz: r(hz, 2), cents: nt.cents }); } cur = null; };
    for (let i = 0; i < f0.length; i++) {
      if (!(f0[i] > 0)) { if (cur && times[i] - cur.end > hopS * 2.5) close(); continue; }
      const m = noteOf(f0[i], args.a4).midi;
      if (cur && cur.midi === m) { cur.end = times[i]; cur.count++; cur.hz.push(f0[i]); } else { close(); cur = { midi: m, start: times[i], end: times[i], count: 1, hz: [f0[i]] }; }
    }
    close();
    const res = { duration: r((s1 - s0) / a.sr, 6), method: 'YIN', analysisRate: sr, frames: f0.length, hop: r(hopS, 5), voicedFraction: r(voiced.length / f0.length, 3) };
    if (voiced.length) {
      const sorted = Float32Array.from(voiced).sort(), med = sorted[sorted.length >> 1], nt = noteOf(med, args.a4);
      Object.assign(res, { medianHz: r(med, 2), note: nt.note, cents: nt.cents, midi: nt.midi, minHz: r(sorted[0], 2), maxHz: r(sorted.at(-1), 2), meanHz: r(voiced.reduce((s, v) => s + v, 0) / voiced.length, 2) });
    } else Object.assign(res, { medianHz: null, note: null, hint: 'no periodic (voiced) frames found — the sound may be noise, silence, polyphonic, or outside minHz…maxHz' });
    res.notes = notes.slice(0, 100); res.noteCount = notes.length;
    const step = args.maxPoints ? Math.max(1, Math.ceil(f0.length / args.maxPoints)) : 0;
    res.track = []; if (step) for (let i = 0; i < f0.length; i += step) res.track.push({ t: r(t0 + times[i], 3), hz: f0[i] > 0 ? r(f0[i], 1) : null, note: f0[i] > 0 ? noteOf(f0[i], args.a4).note : null });
    res.truncated = notes.length > 100 || step > 1 || undefined;
    if (args.output) {
      const lines = ['time_s,f0_hz,note,cents,clarity'];
      for (let i = 0; i < f0.length; i++) { const nt = f0[i] > 0 ? noteOf(f0[i], args.a4) : null; lines.push(`${(t0 + times[i]).toFixed(4)},${nt ? f0[i].toFixed(2) : ''},${nt ? nt.note : ''},${nt ? nt.cents : ''},${clarity[i].toFixed(3)}`); }
      res.output = await vfs.write(args.output, lines.join('\n') + '\n', { mime: 'text/csv', meta: { rows: f0.length } });
    }
    return res;
  },
});

/** onset envelope with the detection-latency correction applied to times: {env, rate, bias} */
function envelopeOf(x, sr) { const e = onsetEnvelope(x, sr, 200); return { ...e, bias: ONSET_BIAS * e.fftSize / sr - e.lead / e.rate }; }
// A transient first shows in the frame whose Hann window just reaches it; the flux peak leads the true onset by ≈ this fraction of the window.
const ONSET_BIAS = 0.36;
function pickOnsets(env, rate, threshold, minGap) {
  let max = 0; for (const v of env) if (v > max) max = v;
  if (!(max > 0)) return [];
  const pre = Math.round(rate * 0.1), post = Math.round(rate * 0.05), loc = Math.max(1, Math.round(rate * 0.03)), gap = Math.max(1, Math.round(minGap * rate)), out = [];
  for (let i = 0; i < env.length - 1; i++) {
    const v = env[i]; let isMax = v > 0;
    for (let j = Math.max(0, i - loc); j <= Math.min(env.length - 1, i + loc); j++) if (env[j] > v) { isMax = false; break; }
    if (!isMax) continue;
    let m = 0, c = 0; for (let j = Math.max(0, i - pre); j <= Math.min(env.length - 1, i + post); j++) { m += env[j]; c++; }
    if (v / max < m / c / max + threshold) continue;
    if (out.length && i - out.at(-1).i < gap) { if (v > out.at(-1).v) out[out.length - 1] = { i, v }; continue; }
    out.push({ i, v });
  }
  return out.map((o) => ({ frame: o.i, strength: o.v / max }));
}
register({
  name: 'audio.onsets', readOnly: true,
  description: 'Detect note/drum/word onsets (moments where new energy appears) by spectral flux. Returns onset times in seconds with a relative strength 0…1 (capped at max), their count and the median gap between them. Timing is accurate to roughly ±10 ms. Use for counting events, slicing, or checking rhythm; for a tempo figure use audio.tempo.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the audio file' },
      ...RANGE,
      threshold: { type: 'number', default: 0.1, minimum: 0.005, maximum: 1, description: 'How far above the local average (as a fraction of the strongest onset) a peak must rise; lower = more onsets' },
      minGap: { type: 'number', default: 0.05, minimum: 0.01, maximum: 5, description: 'Minimum seconds between reported onsets' },
      max: { type: 'integer', default: 200, minimum: 1, maximum: 500, description: 'Most onsets to return' },
    },
    required: ['input'],
  },
  examples: ['audio.onsets input=drums.wav'],
  async run(args) {
    const a = await load(args.input), [s0, s1] = range(a, args), x = monoOf(a.ch, s0, s1);
    const e = envelopeOf(x, a.sr), found = pickOnsets(e.env, e.rate, args.threshold, args.minGap);
    const times = found.map((o) => Math.max(0, o.frame / e.rate + e.bias) + s0 / a.sr);
    const gaps = []; for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    return { duration: r((s1 - s0) / a.sr, 6), count: found.length, medianInterval: gaps.length ? r(percentile(gaps, 0.5), 4) : null,
      onsets: found.slice(0, args.max).map((o, i) => ({ t: r(times[i], 3), strength: r(o.strength, 3) })), truncated: found.length > args.max || undefined, method: 'spectral flux, 5 ms frames' };
  },
});

register({
  name: 'audio.tempo', readOnly: true,
  description: 'Estimate tempo in beats per minute from the autocorrelation of the onset-strength envelope, with a preference for tempi near 120 BPM when a rhythm is ambiguous between a tempo and its double/half. Returns bpm, a 0…1 confidence, alternative candidates, the beat period and an estimated beat grid (first 64 beat times). Needs a few seconds of rhythmic material; half/double-time errors are the usual failure, so check the candidates.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the audio file' },
      ...RANGE,
      minBpm: { type: 'number', default: 50, minimum: 20, maximum: 300, description: 'Slowest tempo considered' },
      maxBpm: { type: 'number', default: 220, minimum: 30, maximum: 400, description: 'Fastest tempo considered' },
    },
    required: ['input'],
  },
  examples: ['audio.tempo input=loop.wav'],
  async run(args) {
    if (args.minBpm >= args.maxBpm) throw new Error('minBpm must be below maxBpm');
    const a = await load(args.input), [s0, s1] = range(a, args), x = monoOf(a.ch, s0, s1);
    const { env, rate, bias } = envelopeOf(x, a.sr), n = env.length;
    const lagMin = Math.max(2, Math.floor(rate * 60 / args.maxBpm)), lagMax = Math.min(Math.ceil(rate * 60 / args.minBpm), Math.floor(n / 3)); // a tempo needs at least three beat periods of audio
    if (n < lagMin * 3) throw new Error(`the selection (${r((s1 - s0) / a.sr, 2)} s) is too short to estimate a tempo; give at least ${r(3 * 60 / args.maxBpm + 0.2, 1)} s, ideally 5 s or more`);
    // remove the slow trend, keep the positive part
    const e = new Float32Array(n), half = Math.round(rate * 0.5); let acc = 0; const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { acc += env[i]; cs[i + 1] = acc; }
    for (let i = 0; i < n; i++) { const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1); e[i] = Math.max(0, env[i] - (cs[hi] - cs[lo]) / (hi - lo)); }
    const L = Math.min(n - 2, lagMax * 4 + 8), acf = new Float64Array(L + 1);
    for (let l = 0; l <= L; l++) { let s = 0; for (let i = 0; i + l < n; i++) s += e[i] * e[i + l]; acf[l] = s / (n - l); }
    if (!(acf[0] > 0)) return { bpm: null, confidence: 0, note: 'no onsets found (silence or a steady tone)' };
    const interp = (l) => { if (l < 1 || l >= L) return { lag: l, v: acf[l] }; const p = acf[l - 1], q = acf[l], s = acf[l + 1], den = p - 2 * q + s, d = den < 0 ? 0.5 * (p - s) / den : 0; return { lag: l + d, v: q - 0.25 * (p - s) * d }; };
    const cands = [];
    for (let l = lagMin; l <= Math.min(lagMax, L - 1); l++) {
      if (!(acf[l] > acf[l - 1] && acf[l] >= acf[l + 1]) || acf[l] <= 0) continue;
      const bpm = 60 * rate / l, prior = Math.exp(-0.5 * (Math.log2(bpm / 120)) ** 2);
      cands.push({ l, score: acf[l] / acf[0] * prior, strength: acf[l] / acf[0] });
    }
    if (!cands.length) return { bpm: null, confidence: 0, note: `no periodicity found between ${r(60 * rate / lagMax, 1)} and ${args.maxBpm} BPM (slower tempi need a longer excerpt: at least three beats)` };
    cands.sort((p, q) => q.score - p.score);
    if (cands[0].strength < 0.1) return { bpm: null, confidence: r(Math.max(0, cands[0].strength), 3), weakestGuess: r(60 * rate / cands[0].l, 1), note: 'no clear beat: the onset envelope is not periodic enough (autocorrelation peak below 0.1) — a steady tone, noise, speech or free-time music' };
    // near-tie between a tempo and its double (nothing in the signal marks every other beat): take the faster, which is the actual period
    for (const c of cands.slice(1)) { const ratio = cands[0].l / c.l; if (c.score >= 0.9 * cands[0].score && c.strength >= 0.95 * cands[0].strength && Math.abs(ratio - Math.round(ratio)) < 0.06 && Math.round(ratio) >= 2) { cands.splice(cands.indexOf(c), 1); cands.unshift(c); break; } }
    const refine = (l) => { // use the peak at the highest clear multiple of the lag for a finer estimate
      let best = interp(l).lag;
      for (let m = 2; m <= 4; m++) { const c = Math.round(best * m); if (c + m + 1 > L) break; let pk = -1, pv = -Infinity; for (let j = c - m - 1; j <= c + m + 1; j++) if (acf[j] > pv) { pv = acf[j]; pk = j; } if (pk <= 0 || pv < 0.5 * acf[l] || !(acf[pk] >= acf[pk - 1] && acf[pk] >= acf[pk + 1])) break; best = interp(pk).lag / m; }
      return best;
    };
    const lag = refine(cands[0].l), bpm = 60 * rate / lag;
    // beat phase: comb of the period over the envelope
    let bestPhase = 0, bestSum = -1;
    for (let ph = 0; ph < Math.floor(lag); ph++) { let s = 0; for (let t = ph; t < n; t += lag) s += e[Math.round(t)] || 0; if (s > bestSum) { bestSum = s; bestPhase = ph; } }
    const beats = []; for (let t = bestPhase; t < n && beats.length < 64; t += lag) beats.push(r(Math.max(0, t / rate + bias) + s0 / a.sr, 3));
    const total = Math.floor((n - bestPhase) / lag) + 1;
    return { bpm: r(bpm, 2), confidence: r(Math.max(0, Math.min(1, cands[0].strength)), 3), beatPeriod: r(lag / rate, 4),
      candidates: cands.slice(0, 4).map((c) => ({ bpm: r(60 * rate / refine(c.l), 2), strength: r(c.strength, 3) })),
      firstBeat: beats[0], beatCount: total, beats, truncated: total > beats.length || undefined, duration: r((s1 - s0) / a.sr, 6), method: 'onset-envelope autocorrelation, log-normal prior centred on 120 BPM' };
  },
});

// ═══════════════════════════════════════════════════════════ synth ══
const DTMF_ROWS = [697, 770, 852, 941], DTMF_COLS = [1209, 1336, 1477, 1633], DTMF_KEYS = ['123A', '456B', '789C', '*0#D'];
const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', _: '..--.-', '"': '.-..-.', $: '...-..-', '@': '.--.-.' };
const MORSE_REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
const SYNTH_TYPES = ['sine', 'square', 'saw', 'triangle', 'sweep', 'white', 'pink', 'brown', 'dtmf', 'morse', 'notes', 'clicks', 'impulse', 'silence'];
function polyblep(t, dt) { if (t < dt) { t /= dt; return t + t - t * t - 1; } if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; } return 0; }
/** one oscillator sample at phase ph ∈ [0,1) with phase increment dt */
function osc(wave, ph, dt, bl) {
  switch (wave) {
    case 'square': return (ph < 0.5 ? 1 : -1) + (bl ? polyblep(ph, dt) - polyblep((ph + 0.5) % 1, dt) : 0);
    case 'saw': return 2 * ph - 1 - (bl ? polyblep(ph, dt) : 0);
    case 'triangle': return 1 - 4 * Math.abs(((ph + 0.25) % 1) - 0.5);
    default: return Math.sin(2 * Math.PI * ph);
  }
}
/** add a gated tone burst (sum of freqs) with raised-cosine ramps into buf */
function burst(buf, sr, at, len, freqs, amp, rampS, wave = 'sine', bl = true) {
  const n0 = Math.round(at * sr), n = Math.round(len * sr), ramp = Math.max(1, Math.min(Math.round(rampS * sr), n >> 1));
  for (const f of freqs) {
    const dt = f / sr; let ph = 0;
    for (let i = 0; i < n && n0 + i < buf.length; i++) {
      let g = 1; if (i < ramp) g = 0.5 - 0.5 * Math.cos(Math.PI * i / ramp); else if (i >= n - ramp) g = 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / ramp);
      buf[n0 + i] += amp * g * osc(wave, ph, dt, bl); ph += dt; if (ph >= 1) ph -= 1;
    }
  }
}
register({
  name: 'audio.synth',
  description: 'Generate a test or signalling sound as WAV, fully deterministic (same args + seed = same samples). type: sine | square | saw | triangle (frequency), sweep (chirp from frequency to endFrequency, linear or log), white | pink | brown noise, dtmf (telephone keypad tones from text such as "0123#"), morse (text → Morse code at wpm), notes (melody/chords from note names, e.g. "C4 E4 G4 C4+E4+G4:2"), clicks (metronome at bpm), impulse (single full-level sample), silence. level sets the peak in dBFS. Use to make known-answer signals for testing other tools, or audible cues.',
  schema: {
    properties: {
      type: { type: 'string', enum: SYNTH_TYPES, default: 'sine', description: 'Signal kind' },
      duration: { type: 'number', minimum: 0.001, maximum: 3600, description: 'Length in seconds (default 1; for dtmf, morse and notes the length follows from the content and this is ignored)' },
      frequency: { type: 'number', minimum: 0.01, description: 'Frequency in Hz: tone pitch, sweep start, morse tone (default 700) or click tone (default 1000). Default 440. A note name is also accepted through "notes"' },
      endFrequency: { type: 'number', minimum: 0.01, description: 'sweep: final frequency in Hz (default: 0.45 × sample rate)' },
      sweep: { type: 'string', enum: ['linear', 'log'], default: 'linear', description: 'sweep: frequency rises linearly (straight line on a linear spectrogram) or exponentially (straight on a log one)' },
      level: { type: 'number', default: -6, minimum: -120, maximum: 0, description: 'Peak level in dBFS (−6 → amplitude 0.501). Noise is scaled so its largest sample hits this level' },
      text: { type: 'string', description: 'dtmf: keys 0-9 A-D * # (space or comma = pause). morse: the message (letters, digits, common punctuation; space = word gap)' },
      notes: { type: 'string', description: 'notes: space-separated tokens. A token is a note (A4, C#3, Bb2) or a frequency in Hz, several joined by + for a chord, R for a rest, with optional :beats length (default 1). Example: "E4 D4 C4:2 R C4+E4+G4:4"' },
      wave: { type: 'string', enum: ['sine', 'square', 'saw', 'triangle'], default: 'sine', description: 'notes: oscillator shape' },
      bpm: { type: 'number', default: 120, minimum: 10, maximum: 600, description: 'notes: beats per minute (one beat per token unless :beats is given). clicks: clicks per minute' },
      toneMs: { type: 'number', default: 100, minimum: 20, maximum: 5000, description: 'dtmf: length of each key tone in milliseconds' },
      gapMs: { type: 'number', default: 100, minimum: 10, maximum: 5000, description: 'dtmf: silence between key tones in milliseconds' },
      wpm: { type: 'number', default: 20, minimum: 3, maximum: 60, description: 'morse: speed in words per minute (dot = 1200 ÷ wpm ms, PARIS timing)' },
      bandlimited: { type: 'boolean', default: true, description: 'square/saw: suppress aliasing with polyBLEP (peaks may overshoot the level by under 1 dB). false = naive, exact ±level steps' },
      fadeMs: { type: 'number', default: 0, minimum: 0, maximum: 60000, description: 'Fade the start and end by this many milliseconds (tones, sweep, noise) to avoid edge clicks' },
      seed: { type: 'integer', default: 1, description: 'Random seed for the noise types' },
      sampleRate: { type: 'integer', default: 48000, minimum: 1000, maximum: 384000, description: 'Sample rate in Hz' },
      channels: { type: 'integer', default: 1, minimum: 1, maximum: 2, description: '1 = mono, 2 = stereo with identical channels' },
      output: { type: 'string', description: 'VFS path to write (default: <type>.wav)' },
      format: OUT.format, bitDepth: { ...OUT.bitDepth, description: 'WAV sample format: 16 (default) or 24-bit PCM, 32 = float' }, bitrate: OUT.bitrate,
    },
  },
  examples: ['audio.synth type=sine frequency=440 duration=2 level=-6', 'audio.synth type=sweep frequency=100 endFrequency=8000 duration=5', 'audio.synth type=dtmf text=555-0199', 'audio.synth type=morse text="CQ CQ DE K1ABC" wpm=18', 'audio.synth type=notes notes="C4 E4 G4 C4+E4+G4:2"'],
  async run(args) {
    const sr = args.sampleRate, amp = lin(args.level), type = args.type, nyq = sr / 2;
    const f0 = args.frequency ?? (type === 'morse' ? 700 : type === 'clicks' ? 1000 : 440);
    if (['sine', 'square', 'saw', 'triangle', 'sweep', 'morse', 'clicks'].includes(type) && f0 >= nyq) throw new Error(`frequency ${f0} Hz must be below the Nyquist frequency ${nyq} Hz (sampleRate ÷ 2)`);
    let x, info = {};
    const dur = args.duration ?? 1, alloc = (seconds) => { checkSize(seconds * sr, args.channels, 'the requested signal'); return new Float32Array(Math.max(1, Math.round(seconds * sr))); };
    if (['sine', 'square', 'saw', 'triangle'].includes(type)) {
      x = alloc(dur); const dt = f0 / sr;
      if (type === 'sine') { const w = 2 * Math.PI * dt; for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(w * i); }
      else for (let i = 0; i < x.length; i++) { const ph = (i * dt) % 1; x[i] = amp * osc(type, ph, dt, args.bandlimited); }
      info = { frequency: f0 };
    } else if (type === 'sweep') {
      x = alloc(dur); const f1 = args.endFrequency ?? 0.45 * sr, T = x.length / sr;
      if (f1 >= nyq) throw new Error(`endFrequency ${f1} Hz must be below the Nyquist frequency ${nyq} Hz`);
      if (args.sweep === 'log') { const k = f1 / f0, c = 2 * Math.PI * f0 * T / Math.log(k); for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(k === 1 ? 2 * Math.PI * f0 * i / sr : c * (k ** (i / x.length) - 1)); }
      else for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = amp * Math.sin(2 * Math.PI * (f0 * t + (f1 - f0) * t * t / (2 * T))); }
      info = { frequency: f0, endFrequency: f1, sweep: args.sweep };
    } else if (['white', 'pink', 'brown'].includes(type)) {
      x = alloc(dur); const rnd = prng(args.seed); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, acc = 0;
      for (let i = 0; i < x.length; i++) {
        const w = rnd() * 2 - 1;
        if (type === 'white') x[i] = w;
        else if (type === 'pink') { // Paul Kellet's filter: −3 dB/octave within ±0.05 dB above 9 Hz at 44.1 kHz
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
          x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
        } else { acc = 0.999 * acc + w * 0.02; x[i] = acc; } // leaky integrator: −6 dB/octave
      }
      let pk = 0; for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > pk) pk = v; }
      const g = pk > 0 ? amp / pk : 0; for (let i = 0; i < x.length; i++) x[i] *= g;
      info = { seed: args.seed };
    } else if (type === 'dtmf') {
      const text = (args.text ?? '').toUpperCase(); if (!text.trim()) throw new Error('type=dtmf needs text, e.g. text="0123456789*#"');
      const tone = args.toneMs / 1000, gap = args.gapMs / 1000, ev = []; let t = gap;
      for (const ch of text) {
        if (ch === ' ' || ch === ',' || ch === '-') { if (ch !== '-') t += tone + gap; continue; }
        const row = DTMF_KEYS.findIndex((k) => k.includes(ch)); if (row < 0) throw new Error(`"${ch}" is not a DTMF key — allowed: 0-9 A-D * # (space or comma = pause, - is ignored)`);
        ev.push({ t, f: [DTMF_ROWS[row], DTMF_COLS[DTMF_KEYS[row].indexOf(ch)]] }); t += tone + gap;
      }
      x = alloc(t); for (const e of ev) burst(x, sr, e.t, tone, e.f, amp / 2, 0.003);
      info = { digits: text.replace(/[^0-9A-D*#]/g, ''), keys: ev.length, toneMs: args.toneMs, gapMs: args.gapMs };
    } else if (type === 'morse') {
      const text = (args.text ?? '').toUpperCase().replace(/\s+/g, ' ').trim(); if (!text) throw new Error('type=morse needs text');
      const dot = 1.2 / args.wpm, ev = []; let t = dot * 3, code = [];
      for (const [i, ch] of [...text].entries()) {
        if (ch === ' ') { t += dot * 4; code.push('/'); continue; } // 3 (letter gap already added) + 4 = 7 dots
        const m = MORSE[ch]; if (!m) throw new Error(`"${ch}" has no Morse code here — allowed: A-Z 0-9 . , ? ' ! / ( ) & : ; = + - _ " $ @ and space`);
        for (const s of m) { const len = s === '.' ? dot : 3 * dot; ev.push({ t, len }); t += len + dot; }
        t += dot * 2; code.push(m); void i;
      }
      x = alloc(t + dot); for (const e of ev) burst(x, sr, e.t, e.len, [f0], amp, Math.min(0.005, dot / 5));
      info = { text, morse: code.join(' ').slice(0, 400), wpm: args.wpm, dotMs: r(dot * 1000, 2), frequency: f0 };
    } else if (type === 'notes') {
      const toks = (args.notes ?? '').split(/[\s,]+/).filter(Boolean); if (!toks.length) throw new Error('type=notes needs notes, e.g. notes="C4 E4 G4 C4+E4+G4:2"');
      if (toks.length > 2000) throw new Error('at most 2000 note tokens');
      const beat = 60 / args.bpm, ev = []; let t = 0;
      for (const tok of toks) {
        const [names, beatsS] = tok.split(':'), beats = beatsS === undefined ? 1 : Number(beatsS);
        if (!(beats > 0)) throw new Error(`bad length in "${tok}" — write NOTE:beats with beats > 0, e.g. C4:2 or G3:0.5`);
        if (!/^(r|-|_)$/i.test(names)) {
          const fr = names.split('+').map((nm) => { const hz = noteToHz(nm) ?? (Number(nm) > 0 ? Number(nm) : null); if (!hz) throw new Error(`cannot read note "${nm}" in "${tok}" — use names like A4, C#3, Bb2, a frequency in Hz, or R for a rest`); if (hz >= nyq) throw new Error(`note "${nm}" (${r(hz, 1)} Hz) is above the Nyquist frequency`); return hz; });
          ev.push({ t, len: beats * beat, fr });
        }
        t += beats * beat;
      }
      x = alloc(t); for (const e of ev) burst(x, sr, e.t, e.len, e.fr, amp / e.fr.length, 0.012, args.wave, args.bandlimited);
      info = { tokens: toks.length, sounding: ev.length, bpm: args.bpm, wave: args.wave };
    } else if (type === 'clicks') {
      x = alloc(dur); const period = 60 / args.bpm, len = Math.min(0.03, period / 2); let count = 0;
      for (let t = 0; t < dur - 1e-9; t += period, count++) { const n0 = Math.round(t * sr), n = Math.round(len * sr); for (let i = 0; i < n && n0 + i < x.length; i++) x[n0 + i] = amp * Math.cos(2 * Math.PI * f0 * i / sr) * Math.exp(-i / (0.005 * sr)); }
      info = { bpm: args.bpm, clicks: count, firstClick: 0, clickHz: f0 };
    } else if (type === 'impulse') { x = alloc(dur); x[0] = amp; }
    else x = alloc(dur);
    if (args.fadeMs && !['dtmf', 'morse', 'notes', 'clicks', 'impulse', 'silence'].includes(type)) { const nf = Math.min(x.length >> 1, Math.round(args.fadeMs / 1000 * sr)); for (let i = 0; i < nf; i++) { const g = 0.5 - 0.5 * Math.cos(Math.PI * i / nf); x[i] *= g; x[x.length - 1 - i] *= g; } }
    const chs = args.channels === 2 ? [x, x] : [x];
    return { ...(await writeOut(chs, sr, args, `${type}.wav`, null, 16)), type, duration: r(x.length / sr, 6), level: args.level, ...info };
  },
});

// ══════════════════════════════════════════════════ dtmf and morse ══
register({
  name: 'audio.dtmf', readOnly: true,
  description: 'Decode DTMF (telephone keypad) tones with Goertzel filters: returns the key string (0-9 A-D * #) and each key\'s start/end time. Tones should last at least ~40 ms with ~30 ms between repeats of the same key. Round-trips with audio.synth type=dtmf.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the audio file' },
      ...RANGE,
      minLevelDb: { type: 'number', default: -45, minimum: -90, maximum: 0, description: 'Ignore tone pairs quieter than this (dB re full scale, per tone)' },
      maxTwistDb: { type: 'number', default: 10, minimum: 1, maximum: 30, description: 'Largest allowed level difference between the low and high tone of a key' },
    },
    required: ['input'],
  },
  examples: ['audio.dtmf input=call.wav'],
  async run(args) {
    const a = await load(args.input), [s0, s1] = range(a, args), x = monoOf(a.ch, s0, s1), sr = a.sr;
    const N = Math.round(sr * 0.03), hop = Math.max(1, Math.round(N / 4)), win = windowFn('hamming', N); let w2 = 0, w1 = 0; for (const v of win) { w2 += v * v; w1 += v; }
    const minP = lin(args.minLevelDb) ** 2, seq = [];
    for (let s = 0; s + N <= x.length; s += hop) {
      let e = 0; for (let i = 0; i < N; i++) { const v = x[s + i] * win[i]; e += v * v; }
      const total = 2 * e / w2; let key = null;
      if (total > minP) {
        const rp = DTMF_ROWS.map((f) => goertzel(x, s, N, f, sr, win)), cp = DTMF_COLS.map((f) => goertzel(x, s, N, f, sr, win));
        const best = (p) => { let bi = 0; for (let i = 1; i < 4; i++) if (p[i] > p[bi]) bi = i; let second = 0; for (let i = 0; i < 4; i++) if (i !== bi && p[i] > second) second = p[i]; return { i: bi, p: p[bi], second }; };
        const R = best(rp), C = best(cp);
        // Goertzel output is amplitude² of a sine; total is the windowed signal power ×2 (so one sine of amplitude A gives A² in both)
        const ok = R.p > minP && C.p > minP && Math.abs(10 * Math.log10(R.p / C.p)) <= args.maxTwistDb && R.second < R.p * 0.2 && C.second < C.p * 0.2 && (R.p + C.p) > 0.6 * total * (w1 * w1 / (N * w2));
        if (ok) key = DTMF_KEYS[R.i][C.i];
      }
      seq.push(key);
    }
    const events = []; let cur = null;
    const flush = () => { if (cur && cur.count >= 2) events.push(cur); cur = null; };
    seq.forEach((k, i) => {
      if (k && cur && cur.key === k && i - cur.last <= 2) { cur.last = i; cur.count++; }
      else if (k) { flush(); cur = { key: k, first: i, last: i, count: 1 }; }
      else if (cur && i - cur.last > 2) flush();
    });
    flush();
    const t0 = s0 / sr, tm = (i) => (i * hop + N / 2) / sr + t0;
    return { digits: events.map((e) => e.key).join(''), count: events.length, events: events.slice(0, 200).map((e) => ({ key: e.key, start: r(tm(e.first) - N / (4 * sr), 3), end: r(tm(e.last) + N / (4 * sr), 3) })),
      truncated: events.length > 200 || undefined, duration: r((s1 - s0) / sr, 6), method: 'Goertzel, 30 ms Hamming blocks, 7.5 ms hop; times ±15 ms' };
  },
});

register({
  name: 'audio.morse', readOnly: true,
  description: 'Decode Morse code (CW: an on/off keyed tone) to text. Finds the tone frequency and keying speed automatically (or take frequency / wpm as hints), then classifies dots, dashes and letter/word gaps. Returns the text, the dot-dash transcription, estimated WPM and tone frequency. Works on clean or moderately noisy machine-timed code; hand-sent code with irregular timing may decode with errors ("?" marks unknown symbols). Round-trips with audio.synth type=morse.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the audio file' },
      ...RANGE,
      frequency: { type: 'number', minimum: 50, maximum: 20000, description: 'Tone frequency in Hz (default: the strongest spectral peak between 200 and 4000 Hz)' },
      wpm: { type: 'number', minimum: 2, maximum: 80, description: 'Sending speed in words per minute (default: estimated from the mark lengths)' },
    },
    required: ['input'],
  },
  examples: ['audio.morse input=cw.wav'],
  async run(args) {
    const a = await load(args.input), [s0, s1] = range(a, args), x = monoOf(a.ch, s0, s1), sr = a.sr;
    let f = args.frequency;
    if (!f) { const { p, binHz } = averageSpectrum(x, sr, 4096, 'hann'); const lo = Math.ceil(200 / binHz), hi = Math.min(p.length - 2, Math.floor(4000 / binHz)); const pk = spectralPeaks(p.subarray(0, hi + 2), binHz, 1, 200, lo, true)[0]; if (!pk) throw new Error('no tone found between 200 and 4000 Hz; pass frequency=<Hz> if the tone lies elsewhere'); f = pk.hz; }
    if (f >= sr / 2) throw new Error(`frequency ${f} Hz is above the Nyquist frequency of this file`);
    const N = Math.max(8, Math.round(sr * 0.008)), hop = Math.max(1, Math.round(sr * 0.002)), win = windowFn('hann', N), frames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
    if (frames < 5) throw new Error('the selection is too short to hold Morse code');
    const env = new Float32Array(frames); for (let i = 0; i < frames; i++) env[i] = Math.sqrt(goertzel(x, i * hop, N, f, sr, win));
    const top = percentile(env, 0.995);
    if (!(top > 1e-4)) throw new Error(`no keyed tone found at ${r(f, 1)} Hz (level below −80 dB)`);
    const hiT = top * 0.5, loT = top * 0.35, runs = []; let on = false, start = 0;
    for (let i = 0; i < frames; i++) { const v = env[i]; if (!on && v > hiT) { runs.push({ on: false, len: i - start }); on = true; start = i; } else if (on && v < loT) { runs.push({ on: true, len: i - start }); on = false; start = i; } }
    runs.push({ on, len: frames - start });
    const dt = hop / sr, marks = runs.filter((q) => q.on).map((q) => q.len * dt);
    if (!marks.length) throw new Error('no key-down marks found');
    const inner = runs.slice(1, -1).filter((q) => !q.on).map((q) => q.len * dt);
    let unit;
    if (args.wpm) unit = 1.2 / args.wpm;
    else {
      let c1 = Math.min(...marks), c2 = Math.max(...marks);
      for (let it = 0; it < 20; it++) { let s1m = 0, n1 = 0, s2m = 0, n2 = 0; for (const m of marks) { if (Math.abs(Math.log(m / c1)) <= Math.abs(Math.log(m / c2))) { s1m += m; n1++; } else { s2m += m; n2++; } } if (n1) c1 = s1m / n1; if (n2) c2 = s2m / n2; }
      if (c2 / c1 > 1.8) unit = (c1 + c2 / 3) / 2;
      else { const m = marks.reduce((s, v) => s + v, 0) / marks.length, g = inner.length ? Math.min(...inner) : m; unit = m / g > 2 ? m / 3 : m; } // one mark length only: dashes if marks are ≈3× the shortest gap
    }
    if (!args.wpm) { // the threshold shortens marks and lengthens gaps by the same amount: average dots with intra-character gaps
      const dots = marks.filter((m) => m < 2 * unit), gaps1 = inner.filter((g) => g < 2 * unit), mean = (v) => v.reduce((s, q) => s + q, 0) / v.length;
      if (dots.length && gaps1.length) unit = (mean(dots) + mean(gaps1)) / 2;
    }
    const letters = []; let sym = '', text = '', unknown = 0;
    const endLetter = () => { if (!sym) return; const ch = MORSE_REV[sym]; if (!ch) unknown++; text += ch || '?'; letters.push(sym); sym = ''; };
    runs.forEach((q, i) => {
      const d = q.len * dt;
      if (q.on) sym += d >= 2 * unit ? '-' : '.';
      else if (i > 0 && i < runs.length - 1) { if (d >= 5 * unit) { endLetter(); text += ' '; letters.push('/'); } else if (d >= 2 * unit) endLetter(); }
    });
    endLetter();
    return { text: text.slice(0, 2000), morse: letters.join(' ').slice(0, 2000), characters: text.length, unknownSymbols: unknown, wpm: r(1.2 / unit, 1), dotMs: r(unit * 1000, 1), frequency: r(f, 1), marks: marks.length,
      truncated: text.length > 2000 || undefined, duration: r((s1 - s0) / sr, 6), note: unknown ? '"?" = a dot-dash group that is not a known character (timing or noise)' : undefined };
  },
});

// ══════════════════════════════════════════════════════ previewer ══
// Waveform overview above the native player.
M.registerPreviewer(
  (stat) => /^audio\//.test(stat.mime || ''),
  async (stat, el) => {
    el.replaceChildren();
    const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:stretch;width:100%';
    try {
      const a = await load(stat.path);
      const w = renderWaveform(a, 0, a.n, { channel: 'all', rms: true, scale: 'full', theme: 'phosphor', width: 1200, height: a.ch.length > 1 ? 380 : 280, title: stat.path });
      const { bytes } = await canvasBytes(w.canvas, 'png');
      const img = document.createElement('img'); img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' })); img.alt = `waveform of ${stat.path}`; img.style.cssText = 'max-width:100%;height:auto;display:block';
      img.onload = () => URL.revokeObjectURL(img.src);
      wrap.appendChild(img);
    } catch (e) { const p = document.createElement('div'); p.textContent = `waveform unavailable: ${e.message}`; wrap.appendChild(p); }
    const au = document.createElement('audio'); au.controls = true; au.src = vfs.url(stat.path); au.style.width = '100%';
    wrap.appendChild(au); el.appendChild(wrap);
  },
);
