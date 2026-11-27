// μεταμόρφωσις :: diag — who is running us, what it can do, and a log an agent can read back.
// Nothing here assumes a browser by name: every capability is detected, then each room is judged against
// what it needs (required / faster-with / optional), so the page can say exactly what will be slow or missing.
import { M, vfs, register } from './core.js';
import { ROOMS } from './rooms.js';

const T0 = performance.now();
const LOG_MAX = 800;
const logs = [];
let seq = 0;
const counts = { error: 0, warn: 0 };
let verbose = false;
try { verbose = new URLSearchParams(location.search).has('debug') || localStorage.getItem('mu-debug') === '1'; } catch { /* storage blocked */ }

/** push one entry: level debug|info|warn|error, src = tool or subsystem */
export function log(level, src, msg, data) {
  const e = { n: ++seq, t: Math.round(performance.now() - T0), level, src, msg: String(msg).slice(0, 2000) };
  if (data !== undefined) { try { e.data = JSON.parse(JSON.stringify(data)); } catch { e.data = String(data); } }
  logs.push(e); if (logs.length > LOG_MAX) logs.shift();
  if (level === 'error' || level === 'warn') { counts[level]++; M.emit('diag', { counts: { ...counts }, last: e }); }
  if (verbose) console[level === 'debug' ? 'debug' : level === 'info' ? 'info' : level]?.(`[μ +${e.t}ms] ${src}: ${e.msg}`, data ?? '');
  return e;
}

// ─────────────────────────────────────────────────────── wiring ──
M.on('log', ({ level, tool, msg }) => log(level === 'warn' ? 'warn' : 'info', tool || 'log', msg));
M.on('call:start', ({ id, tool, args }) => log('debug', tool, `call #${id} start`, args));
M.on('call:end', (e) => (e.ok ? log('debug', e.tool, `call #${e.id} ok in ${e.ms} ms${e.result?.backend ? ` on ${e.result.backend}` : ''}`) : log('error', e.tool, `call #${e.id} failed in ${e.ms} ms: ${e.error}`)));
M.on('progress', ({ tool, fraction, note }) => { if (verbose) log('debug', tool, `progress ${fraction != null ? Math.round(fraction * 100) + '%' : ''} ${note || ''}`); });
addEventListener('error', (ev) => {
  if (ev.target && ev.target !== window && (ev.target.src || ev.target.href)) log('error', 'resource', `failed to load ${ev.target.src || ev.target.href}`);
  else log('error', 'page', `${ev.message || 'error'}${ev.filename ? ` @ ${ev.filename.split('/').slice(-2).join('/')}:${ev.lineno}:${ev.colno}` : ''}`);
}, true);
addEventListener('unhandledrejection', (ev) => log('error', 'page', `unhandled rejection: ${ev.reason?.message || ev.reason}`, ev.reason?.stack?.split('\n').slice(0, 4)));
addEventListener('securitypolicyviolation', (ev) => log('error', 'csp', `blocked ${ev.blockedURI} (${ev.violatedDirective})`));

// ───────────────────────────────────────────────────── browser ──
export function browser() {
  const ua = navigator.userAgent; const uad = navigator.userAgentData;
  const pick = (re) => { const m = re.exec(ua); return m ? m[1] : null; };
  let name = 'unknown', version = null, engine = 'unknown';
  if (/Firefox\//.test(ua)) { name = 'Firefox'; version = pick(/Firefox\/([\d.]+)/); engine = 'Gecko'; } else if (/Edg\//.test(ua)) { name = 'Edge'; version = pick(/Edg\/([\d.]+)/); engine = 'Blink'; } else if (/OPR\//.test(ua)) { name = 'Opera'; version = pick(/OPR\/([\d.]+)/); engine = 'Blink'; } else if (/Chrome\//.test(ua)) { name = /HeadlessChrome/.test(ua) ? 'Chrome (headless)' : 'Chrome'; version = pick(/Chrome\/([\d.]+)/); engine = 'Blink'; } else if (/Safari\//.test(ua) && /Version\//.test(ua)) { name = 'Safari'; version = pick(/Version\/([\d.]+)/); engine = 'WebKit'; }
  if (uad?.brands?.length) { const b = uad.brands.find((x) => !/Not.?A.?Brand|Chromium/i.test(x.brand)); if (b && name === 'Chrome' && !/Chrome/i.test(b.brand)) name = b.brand; }
  const os = uad?.platform || (/Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown');
  const mobile = uad?.mobile ?? /Mobi|Android|iPhone|iPad/.test(ua);
  return { name, version, major: version ? parseInt(version, 10) : null, engine, os, mobile, automated: !!navigator.webdriver };
}

// ─────────────────────────────────────────────────── capabilities ──
const wasmHas = (bytes) => { try { return WebAssembly.validate(new Uint8Array(bytes)); } catch { return false; } };
const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

let probed = null;
/** probe() → {feature: {ok, detail?}} — cached; every check is defensive and time-boxed */
export function probe(force = false) {
  if (probed && !force) return probed;
  return (probed = (async () => {
    const t = performance.now(); const f = {};
    const set = (k, ok, detail) => { f[k] = detail ? { ok: !!ok, detail } : { ok: !!ok }; };
    set('secureContext', globalThis.isSecureContext, location.protocol);
    set('crossOriginIsolated', globalThis.crossOriginIsolated, globalThis.crossOriginIsolated ? '' : 'no COOP/COEP headers (static host): no SharedArrayBuffer, WASM runs single-threaded');
    // WebAssembly
    set('wasm', typeof WebAssembly === 'object');
    set('wasmSimd', wasmHas([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    set('wasmThreads', typeof SharedArrayBuffer !== 'undefined' && !!globalThis.crossOriginIsolated);
    set('wasmBigInt', (() => { try { return typeof BigInt64Array !== 'undefined' && wasmHas([0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 126, 1, 126, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 6, 1, 4, 0, 32, 0, 11]); } catch { return false; } })());
    // GPU
    try {
      const info = await withTimeout(M.gpu.info(), 6000, { available: false, timeout: true });
      let extra = {};
      if (info.available) { const d = await M.gpu.device(); extra = { f16: !!info.f16, maxTexture: d.limits.maxTextureDimension2D, maxBufferMB: Math.round(d.limits.maxBufferSize / 1048576) }; }
      set('webgpu', info.available, info.available ? `${[info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'adapter'}${info.fallback ? ' — SOFTWARE fallback adapter' : ''}; f16 ${extra.f16 ? 'yes' : 'no'}; max texture ${extra.maxTexture}; max buffer ${extra.maxBufferMB} MB` : !navigator.gpu ? 'navigator.gpu is absent (not shipped, disabled by flag/policy, or insecure context)' : info.timeout ? 'adapter request timed out' : 'navigator.gpu exists but no adapter was returned (blocklisted driver, or GPU process disabled)');
      set('webgpuF16', !!extra.f16); set('webgpuSoftware', !!info.fallback);
    } catch (e) { set('webgpu', false, e.message); }
    set('webgl2', (() => { try { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); const ok = !!g; g?.getExtension('WEBGL_lose_context')?.loseContext(); return ok; } catch { return false; } })());
    // canvas & images
    set('offscreenCanvas', (() => { try { return typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d') && typeof OffscreenCanvas.prototype.convertToBlob === 'function'; } catch { return false; } })());
    set('createImageBitmap', typeof createImageBitmap === 'function');
    set('imageDecoder', typeof ImageDecoder !== 'undefined');
    const enc = async (type) => { try { const c = document.createElement('canvas'); c.width = c.height = 2; return (await new Promise((r) => c.toBlob(r, type)))?.type === type; } catch { return false; } };
    set('encodeWebp', await enc('image/webp')); set('encodeAvif', await enc('image/avif'));
    // media
    set('videoEncoder', typeof VideoEncoder !== 'undefined'); set('videoDecoder', typeof VideoDecoder !== 'undefined');
    set('audioEncoder', typeof AudioEncoder !== 'undefined'); set('audioDecoder', typeof AudioDecoder !== 'undefined');
    if (f.videoEncoder.ok) {
      const cfg = { width: 1280, height: 720, bitrate: 2e6, framerate: 30 }; const codecs = {};
      for (const [k, codec] of [['h264', 'avc1.42001f'], ['vp9', 'vp09.00.10.08'], ['av1', 'av01.0.04M.08'], ['hevc', 'hvc1.1.6.L93.B0']]) { try { codecs[k] = !!(await withTimeout(VideoEncoder.isConfigSupported({ codec, ...cfg }), 2000, {})).supported; } catch { codecs[k] = false; } }
      f.videoEncoder.detail = 'encode: ' + (Object.entries(codecs).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'); f.videoEncoder.codecs = codecs;
    }
    set('webAudio', typeof OfflineAudioContext !== 'undefined' || typeof webkitOfflineAudioContext !== 'undefined');
    // storage
    set('indexedDB', typeof indexedDB !== 'undefined');
    set('cacheStorage', typeof caches !== 'undefined');
    set('opfs', typeof navigator.storage?.getDirectory === 'function');
    try { const est = await withTimeout(navigator.storage?.estimate?.() ?? Promise.resolve(null), 2000, null); if (est) { set('storage', true, `${M.human(est.usage || 0)} used of ${M.human(est.quota || 0)}`); f.storage.quota = est.quota; f.storage.usage = est.usage; f.storage.persisted = await navigator.storage.persisted?.().catch(() => false); } else set('storage', false, 'no storage estimate'); } catch { set('storage', false); }
    // misc
    set('compressionStreams', (() => { try { new DecompressionStream('deflate-raw'); return true; } catch { return false; } })(), 'deflate-raw');
    set('moduleWorkers', (() => { let ok = false; try { const u = URL.createObjectURL(new Blob([''], { type: 'text/javascript' })); new Worker(u, { get type() { ok = true; return 'module'; } }).terminate(); URL.revokeObjectURL(u); } catch { /* no workers */ } return ok; })());
    set('subtleCrypto', !!globalThis.crypto?.subtle);
    set('webmcpNative', !!M.webmcp?.native, M.webmcp?.native ? 'document.modelContext' : `not built in — polyfilled (${M.webmcp?.count || 0} tools registered on ${M.webmcp?.api || 'nothing'})`);
    set('structuredClone', typeof structuredClone === 'function');
    f._ms = Math.round(performance.now() - t);
    return f;
  })());
}

// what each room needs. need: 'required' (tools fail without it) | 'faster' (works without, slower) | 'optional' (some tools/paths missing)
const NEEDS = {
  image: [['wasmSimd', 'required', 'the pixel kernel is a SIMD WebAssembly binary — no image.* tool runs without it'], ['webgpu', 'faster', 'blur, convolve, morphology, resize, bilateral run on the WASM kernel instead'], ['offscreenCanvas', 'optional', 'falls back to DOM canvases'], ['encodeWebp', 'optional', 'WebP output is unavailable']],
  analysis: [['wasmSimd', 'required', 'the analysis kernel is a SIMD WebAssembly binary'], ['offscreenCanvas', 'optional', 'falls back to DOM canvases']],
  synth: [['webgpu', 'optional', 'gpu.* tools (shader playground, kernels) are unavailable; synth.* generators run in JS; dither.* runs on WASM'], ['wasmSimd', 'optional', 'dither.* needs the SIMD kernel']],
  vision: [['wasm', 'required', 'OCR, barcode and neural engines are WebAssembly'], ['webgpu', 'faster', 'vision.classify runs on single-threaded WASM (≈3–5× slower)'], ['wasmSimd', 'faster', 'OCR falls back to the non-SIMD core']],
  pdf: [['moduleWorkers', 'required', 'the PDF renderer runs in a module worker'], ['offscreenCanvas', 'optional', 'page rendering falls back to DOM canvases'], ['wasm', 'optional', 'JPEG2000 / JBIG2 images inside PDFs will not decode']],
  video: [['wasm', 'required', 'the ffmpeg fallback is WebAssembly'], ['videoEncoder', 'faster', 'no WebCodecs: every conversion runs in ffmpeg.wasm on one CPU thread (roughly 10–50× slower, 30 MB first download)'], ['audioEncoder', 'faster', 'audio encodes go through ffmpeg.wasm'], ['wasmThreads', 'optional', 'ffmpeg.wasm is single-threaded on this host (always, on a static site)']],
  audio: [['webAudio', 'required', 'decoding uses Web Audio'], ['audioEncoder', 'optional', 'compressed output (mp3/m4a/ogg/opus) goes through ffmpeg.wasm; WAV is unaffected']],
  geo: [['offscreenCanvas', 'optional', 'map rendering falls back to DOM canvases'], ['compressionStreams', 'optional', 'KMZ / zipped shapefiles use the JS inflater']],
  data: [['subtleCrypto', 'optional', 'only on insecure origins']],
  bytes: [['subtleCrypto', 'optional', 'SHA-1/256/384/512 need a secure context (https or localhost)'], ['wasmBigInt', 'optional', 'xxh64 unavailable']],
  doc: [['compressionStreams', 'optional', 'docx/pptx/epub unzip uses the JS inflater']],
  mind: [['webgpu', 'faster', 'no WebGPU: Whisper runs on single-threaded WASM (slow) and language models are mostly refused'], ['webgpuF16', 'optional', 'half-precision weights unavailable — larger downloads / more memory'], ['cacheStorage', 'required', 'model weights are cached with the Cache API'], ['wasm', 'required', 'the inference runtime is WebAssembly + WebGPU']],
  claude: [['offscreenCanvas', 'optional', 'falls back to DOM canvases']],
};

/** rooms() → [{id, status: ok|degraded|blocked, issues:[{feature, need, effect}]}] */
export async function rooms() {
  const f = await probe();
  return ROOMS.map((r) => {
    const issues = (NEEDS[r.id] || []).filter(([k]) => !f[k]?.ok).map(([feature, need, effect]) => ({ feature, need, effect }));
    if (r.id === 'mind' && f.webgpuSoftware?.ok) issues.push({ feature: 'webgpuSoftware', need: 'faster', effect: 'the WebGPU adapter is a software rasteriser — models will be very slow' });
    const status = issues.some((i) => i.need === 'required') ? 'blocked' : issues.some((i) => i.need === 'faster') ? 'degraded' : 'ok';
    return { id: r.id, status, issues };
  });
}

// ───────────────────────────────────────────────────────── tools ──
register({
  name: 'sys.diag', readOnly: true,
  description: 'Compatibility report for THIS browser: which browser/engine/OS it is, every capability the site uses (WebGPU adapter and limits, WASM SIMD/threads, WebCodecs codecs, canvas, storage quota, workers, WebMCP…) with a reason when one is missing, and a verdict per room — ok, degraded (works but slower, says why) or blocked (says what is missing). Call this first when something fails or is slow, or before choosing a backend.',
  schema: { properties: { room: { type: 'string', description: 'Only this room\'s verdict (default: all rooms)' }, refresh: { type: 'boolean', default: false, description: 'Re-run the capability probes instead of using the cached result' } } },
  async run({ room, refresh }) {
    const f = await probe(refresh); const all = await rooms(); const { _ms, ...features } = f;
    const missing = Object.entries(features).filter(([k, v]) => !v.ok && k !== 'webgpuSoftware').map(([k]) => k);
    return {
      browser: browser(), room: M.room?.id,
      summary: { rooms: Object.fromEntries(['ok', 'degraded', 'blocked'].map((s) => [s, all.filter((r) => r.status === s).map((r) => r.id)])), missing },
      rooms: room ? all.filter((r) => r.id === room) : all.filter((r) => r.status !== 'ok'),
      features, cores: navigator.hardwareConcurrency || null, memoryGB: navigator.deviceMemory || null,
      log: { errors: counts.error, warnings: counts.warn, hint: 'sys.log level=warn shows them' }, probeMs: _ms,
    };
  },
});

register({
  name: 'sys.log', readOnly: true,
  description: 'Read the page\'s diagnostic log: every tool call with its duration and backend, tool log lines (downloads, backend choices, fallbacks), warnings, failed calls, uncaught page errors and failed resource loads. Use it to see why a call failed or where the time went. Newest last.',
  schema: {
    properties: {
      level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], default: 'info', description: 'Minimum level (debug includes every call start/end)' },
      tool: { type: 'string', description: 'Only entries from this tool or subsystem (prefix match, e.g. "video" or "pdf.render")' },
      last: { type: 'integer', default: 50, minimum: 1, maximum: 400, description: 'How many entries to return' },
      since: { type: 'integer', minimum: 0, description: 'Only entries with n greater than this (pass the previous result\'s lastN to poll)' },
    },
  },
  run({ level, tool, last, since }) {
    const rank = { debug: 0, info: 1, warn: 2, error: 3 };
    let list = logs.filter((e) => rank[e.level] >= rank[level] && (!tool || e.src.startsWith(tool)) && (since === undefined || e.n > since));
    const total = list.length; list = list.slice(-last);
    return { entries: list, returned: list.length, matched: total, truncated: total > list.length, lastN: seq, counts: { ...counts }, uptimeMs: Math.round(performance.now() - T0), verbose };
  },
});

register({
  name: 'sys.debug',
  description: 'Switch verbose diagnostics on or off: when on, every log entry (including progress ticks) is mirrored to the browser console with millisecond timestamps, and the setting is remembered for this browser. Also available as ?debug in the URL.',
  schema: { properties: { on: { type: 'boolean', default: true, description: 'true = verbose, false = quiet' } } },
  run({ on }) { verbose = on; try { localStorage.setItem('mu-debug', on ? '1' : '0'); } catch { /* storage blocked */ } return { verbose, note: on ? 'entries are mirrored to the console; sys.log level=debug reads them here' : 'quiet' }; },
});

export const diag = (M.diag = { log, logs, counts, browser, probe, rooms, get verbose() { return verbose; } });
log('info', 'boot', `${browser().name} ${browser().version || ''} on ${browser().os} · room ${M.room?.id || '?'} · ${location.href}`);
