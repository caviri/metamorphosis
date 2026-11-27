// mind :: the inference engine. Runs inside a dedicated module worker (js/mind/worker.js) so the page stays responsive;
// the same module is imported directly by the page when a worker cannot be used (no module workers, or WebGPU exposed
// only on the window). It owns the vendored runtime (Transformers.js on ONNX Runtime Web), the loaded models and the
// one sanctioned cross-origin channel of this site: model files from the Hugging Face Hub. Audio and prompts never leave.
import { probeGpu, probeWasm, human } from './caps.js';
import { HUB, HUB_HOSTS, CACHE_NAME, CPU_LLM_MAX_BYTES, MB, resolveModel, planFor, memoryEstimate, idsOf, CATALOG } from './catalog.js';

const V = (p) => new URL(`../../vendor/${p}`, import.meta.url).href;
const now = () => performance.now();
const ms = (t0) => Math.round(performance.now() - t0);
const round = (x, d = 2) => { const k = 10 ** d; return Math.round(x * k) / k; };

let rt = null;                 // promise → { tf, ort, loadMs }
let rtVersions = null;
const loaded = new Map();      // plan.key → record
let job = null;                // the operation in flight: { id, op, em, net, fatal }
let lost = null;               // { reason, message } once the GPUDevice is gone
let host = { fatal() {} };     // set by the embedding side: told when the engine must be torn down
const contacted = new Set();   // every cross-origin host this engine has talked to
const hooked = new WeakSet();
let disposing = 0;               // > 0 while we release sessions ourselves

export function setHost(h) { host = h; }

// ───────────────────────────────────────────────────────── runtime ──
function runtime(em) {
  if (!rt) {
    rt = (async () => {
      const t0 = now();
      // ONNX Runtime Web 1.31.1 as already vendored for vision.classify: one .wasm serves WebGPU and single-threaded CPU.
      const ort = await import(V('onnxruntime-web/ort.webgpu.min.mjs'));
      ort.env.wasm.wasmPaths = V('onnxruntime-web/');   // same-origin glue + wasm; set BEFORE Transformers.js loads so its CDN default is never used
      ort.env.wasm.numThreads = 1;                      // no COOP/COEP on a static host → no SharedArrayBuffer → one thread
      ort.env.wasm.proxy = false;
      const tf = await import(V('transformers/transformers.web.min.js'));
      const e = tf.env;
      e.allowLocalModels = false; e.allowRemoteModels = true; e.remoteHost = HUB;
      e.useBrowserCache = typeof caches !== 'undefined'; e.cacheKey = CACHE_NAME;
      e.useWasmCache = false; e.useCustomCache = false; e.experimental_useCrossOriginStorage = false;
      e.logLevel = tf.LogLevel.ERROR;
      e.fetch = trackedFetch;
      const info = { tf, ort, loadMs: ms(t0), versions: { transformers: e.version, onnxruntimeWeb: ort.env.versions?.web || '?' } };
      rtVersions = info.versions;
      em?.log(`runtime loaded in ${info.loadMs} ms: transformers.js ${info.versions.transformers} on onnxruntime-web ${info.versions.onnxruntimeWeb} (${typeof document === 'undefined' ? 'worker' : 'page main thread'}; wasm threads: 1; browser cache: ${e.useBrowserCache ? 'Cache API' : 'UNAVAILABLE — models are re-downloaded on every page load'})`);
      if (!e.useBrowserCache) em?.warn('the Cache API is not available in this context (private window or insecure origin?): model files cannot be kept between page loads');
      return info;
    })();
    rt.catch(() => { rt = null; });
  }
  return rt;
}

/** Every network request of the runtime goes through here: same-origin or Hugging Face only; sizes are logged and counted. */
async function trackedFetch(input, init) {
  const raw = typeof input === 'string' ? input : input?.url ?? String(input);
  const url = new URL(raw, self.location.href);
  const same = url.origin === self.location.origin;
  if (!same && !HUB_HOSTS.test(url.hostname)) throw new Error(`refusing to contact ${url.hostname}: this page fetches model files from huggingface.co only`);
  // credentials are never sent: public model files need none, and nothing about the user should reach the Hub
  const res = await fetch(input, same ? init : { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!same) {
    let final = url.hostname; try { if (res.url) final = new URL(res.url).hostname; } catch { /* opaque */ }
    contacted.add(url.hostname); contacted.add(final);
    const ranged = new Headers(init?.headers || {}).has('range');
    if (!ranged && res.ok && (init?.method || 'GET') === 'GET') {
      const bytes = Number(res.headers.get('content-length')) || 0;
      const file = url.pathname.replace(/^\/[^/]+\/[^/]+\/resolve\/[^/]+\//, '');
      if (job) { job.net.files.push({ file, bytes, host: final }); job.net.bytes += bytes; job.em.log(`download ${file} — ${bytes ? human(bytes) : 'size not announced'} from ${final}`); }
    }
  }
  return res;
}

/** progress_callback for from_pretrained: aggregates per-file byte counts into one fraction inside [lo, hi]. */
function tracker(em, expected, lo, hi) {
  const files = new Map(); let last = 0;
  const cb = (d) => {
    if (!d?.file || (d.status !== 'progress' && d.status !== 'done')) return;
    if (d.status === 'progress') files.set(d.file, { loaded: d.loaded || 0, total: d.total || d.loaded || 0 });
    else {
      const f = files.get(d.file); if (f) f.loaded = f.total; cb.filesDoneAt = now();
      // small JSON files arrive compressed without a usable content-length: count them once they are complete
      const n = job?.net.files.find((x) => x.file === d.file && !x.bytes); if (n && f) { n.bytes = f.total; job.net.bytes += f.total; }
    }
    const t = now(); if (t - last < 250 && d.status !== 'done') return; last = t;
    let L = 0, T = 0; for (const f of files.values()) { L += f.loaded; T += f.total; }
    const total = Math.max(T, expected || 0);
    const net = job?.net.files.some((f) => f.file === d.file);
    em.progress(lo + (hi - lo) * (total ? Math.min(1, L / total) : 0), `${net ? 'downloading' : 'reading browser cache'}: ${d.file} — ${human(L)} of ${human(total)}`);
  };
  cb.files = files;
  return cb;
}

// ─────────────────────────────────────────────────────────── errors ──
function describe(e, op) {
  const native = typeof e === 'number';
  let m = native ? `the ONNX Runtime WebAssembly module aborted with native exception ${e}` : (e?.message || String(e));
  const oom = native || /out of memory|\bOOM\b|bad_alloc|allocation failed|Aborted\(|memory access out of bounds|failed to allocate|Array buffer allocation|Invalid typed array length|Invalid array buffer length|exceeds the max(imum)? buffer size/i.test(m);
  const gone = !!lost || /device (is |was |has been )?lost|Device lost|GPUDevice.*lost|A valid external Instance reference no longer exists/i.test(m);
  const where = job?.backend ? ` on ${job.backend}` : '';
  if (gone) {
    return { fatal: true, message: `WebGPU device lost during ${op}${lost ? ` (${lost.reason || 'unknown'}: ${lost.message || 'no message'})` : ''} — usually the GPU ran out of memory, the driver reset, or another tab took the GPU. Every model was unloaded and the inference engine was shut down; the next call starts a fresh one. Retry with a smaller model (model.list shows memory needs) or backend=cpu. Detail: ${m}` };
  }
  if (oom) {
    return { fatal: true, message: `out of memory during ${op}${where}: ${m}. Every model was unloaded and the inference engine was shut down; the next call starts a fresh one. Retry with a smaller model or a smaller quantisation (model.list shows sizes and memory needs)${job?.backend === 'wasm' ? '; WebAssembly is limited to 4 GB per page' : ', close other GPU-heavy tabs, or use backend=cpu'}. Note that ONNX Runtime Web builds every session inside a 32-bit WebAssembly heap even on WebGPU: a single weight file above roughly 1.5 GB cannot be loaded at all.` };
  }
  if (/Failed to fetch|NetworkError|network error|Load failed|ERR_/i.test(m)) m = `network error while fetching model files from huggingface.co (${m}) — check connectivity, a proxy/firewall blocking huggingface.co or its CDN (*.hf.co), then retry; files already complete stay cached`;
  else if (/Unauthorized|401|403|Forbidden/i.test(m)) m = `${m} — the Hub answers this for a repo id that does not exist, is private, or is gated behind a licence click-through (not usable from a browser without a token)`;
  else if (/QuotaExceeded|quota/i.test(m)) m = `browser storage quota exceeded while caching model files (${m}) — model.cache shows usage and quota; free space with model.remove`;
  return { fatal: false, message: m };
}

function watchDevice(ort, em) {
  // ORT owns the GPUDevice; once a WebGPU session exists it is exposed on env.webgpu.device.
  Promise.resolve().then(() => ort.env.webgpu?.device).then((dev) => {
    if (!dev || typeof dev !== 'object' || hooked.has(dev)) return;
    hooked.add(dev);
    dev.lost?.then((info) => {
      // ONNX Runtime destroys its GPUDevice itself when the last WebGPU session is released (and makes a new one for the
      // next session): that is the normal end of a model.unload / model switch, not a failure.
      if (info?.reason === 'destroyed' && (disposing > 0 || ![...loaded.values()].some((r) => r.backend === 'webgpu'))) return;
      lost = { reason: info?.reason, message: info?.message };
      const err = new Error(`GPUDevice lost: ${info?.message || info?.reason || ''}`);
      if (job?.fatal) job.fatal(err); else host.fatal(describe(err, 'idle').message);
    });
    dev.addEventListener?.('uncapturederror', (ev) => { job?.em.warn(`WebGPU error: ${ev?.error?.message || ev?.error || 'unknown'}`); });
  }).catch(() => { /* the runtime did not expose its device: device loss then surfaces as a failed run */ });
}

// ───────────────────────────────────────────────── backend + loading ──
async function decide(backend, em) {
  const g = await probeGpu();
  if (backend === 'cpu') return { device: 'wasm', g };
  let why = null;
  if (!g.available) why = g.reason;
  else if (g.fallbackAdapter && backend === 'auto') why = `the WebGPU adapter is a software fallback (${[g.vendor, g.architecture, g.description].filter(Boolean).join(' ') || 'CPU rasteriser'}), which is slower than WebAssembly for neural inference`;
  if (!why) {
    if (g.fallbackAdapter) em.warn('backend=gpu on a software (fallback) WebGPU adapter: expect it to be slower than backend=cpu');
    return { device: 'webgpu', g };
  }
  if (backend === 'gpu') throw new Error(`backend=gpu requested but ${why}. Use backend=auto or backend=cpu.`);
  return { device: 'wasm', g, reason: why };
}

async function cpuPolicy(tf, entry, plan) {
  if (entry.task !== 'llm') return;
  const small = CATALOG.filter((m) => m.task === 'llm' && m.cpu !== 'no').map((m) => m.id).join(', ');
  if (entry.cpu === 'no') throw new Error(`${entry.id} is not offered on the CPU (WebAssembly) backend: without threads it would generate well under 1 token/s and its weights do not fit comfortably in WASM's 4 GB. Run it with WebGPU (backend=gpu), or pick a model that is allowed on CPU: ${small}.`);
  if (entry.custom) {
    let size = null;
    try { let s = 0; for (const f of plan.files) { const md = await tf.ModelRegistry.get_file_metadata(plan.repo, f); if (md?.exists && md.size) s += md.size; const ext = await tf.ModelRegistry.get_file_metadata(plan.repo, `${f}_data`).catch(() => null); if (ext?.exists && ext.size) s += ext.size; } size = s || null; } catch { /* decided at load */ }
    if (size && size > CPU_LLM_MAX_BYTES) throw new Error(`${plan.repo} [${plan.label}] is ${human(size)}: language models above ${human(CPU_LLM_MAX_BYTES)} are refused on the CPU (WebAssembly) backend — single-threaded they take minutes per answer. Use WebGPU (backend=gpu) or a smaller model: ${small}.`);
  }
}

async function dispose(key, em) {
  const rec = loaded.get(key); if (!rec) return false;
  loaded.delete(key);
  disposing++;
  try { await rec.model.dispose(); } catch (e) { em?.warn(`disposing ${rec.id} reported: ${e?.message || e}`); }
  await new Promise((r) => setTimeout(r, 0));   // let the device's `lost` promise (reason "destroyed") settle while we still expect it
  disposing--;
  return true;
}

async function loadOn(tf, ort, entry, device, g, opts, em, span) {
  const plan = planFor(entry, device, g.shaderF16, opts.dtype, opts.word);
  const hit = loaded.get(plan.key);
  if (hit) { hit.lastUsed = Date.now(); return { rec: hit, fresh: false, plan }; }
  if (device === 'wasm') await cpuPolicy(tf, entry, plan);
  for (const [k, r] of [...loaded]) {
    if (r.task === entry.task) { em.log(`unloading ${r.id} [${r.backend}, ${r.dtype}] first: one ${entry.task} model is kept in memory at a time`); await dispose(k, em); }
  }
  const t0 = now();
  const cb = tracker(em, plan.bytes, span[0], span[1]);
  const before = job.net.bytes;
  em.log(`loading ${plan.repo} [${plan.label}] on ${device}${plan.bytes ? ` — ${human(plan.bytes)} if not cached yet` : ''}`);
  job.backend = device;
  const mo = { device, dtype: plan.dtype, progress_callback: cb };
  const parts = entry.task === 'speech'
    ? [tf.AutoModelForSpeechSeq2Seq.from_pretrained(plan.repo, mo), tf.AutoTokenizer.from_pretrained(plan.repo, { progress_callback: cb }), tf.AutoProcessor.from_pretrained(plan.repo, { progress_callback: cb })]
    : [tf.AutoModelForCausalLM.from_pretrained(plan.repo, mo), tf.AutoTokenizer.from_pretrained(plan.repo, { progress_callback: cb })];
  const done = await Promise.allSettled(parts);
  const bad = done.find((d) => d.status === 'rejected');
  if (bad) {
    if (done[0].status === 'fulfilled') { try { await done[0].value.dispose(); } catch { /* already gone */ } }
    let err = bad.reason;
    if (/Could not locate file|404|not found/i.test(err?.message || '')) {
      let have = null; try { have = await tf.ModelRegistry.get_available_dtypes(plan.repo); } catch { /* repo itself is missing */ }
      err = new Error(`${err.message} — ${have?.length ? `this repo offers dtype: ${have.join(', ')} (requested ${plan.label}); pass dtype=<one of them>` : 'the repo has no Transformers.js-compatible ONNX files (expected an onnx/ folder with model*.onnx), or does not exist'}`);
    }
    throw err;
  }
  const [model, tokenizer, processor] = done.map((d) => d.value);
  if (entry.task === 'speech' && !/whisper/.test(model.config?.model_type || '')) { try { await model.dispose(); } catch { /* ignore */ } throw new Error(`${plan.repo} is a "${model.config?.model_type}" model: speech.transcribe supports Whisper-architecture models only`); }
  let weightsBytes = 0; for (const [f, v] of cb.files) if (/\.onnx(_data.*)?$/.test(f)) weightsBytes += v.total;
  const loadMs = ms(t0); const filesMs = cb.filesDoneAt ? Math.round(cb.filesDoneAt - t0) : null;
  const downloadedBytes = job.net.bytes - before;
  const rec = {
    key: plan.key, id: entry.id, repo: plan.repo, task: entry.task, backend: device, dtype: plan.label, model, tokenizer, processor,
    weightsBytes, memoryBytes: memoryEstimate(weightsBytes, device), loadMs, downloadedBytes, loadedAt: Date.now(), lastUsed: Date.now(), runs: 0,
  };
  loaded.set(plan.key, rec);
  em.log(`${entry.id} ready on ${device} in ${loadMs} ms — files ${filesMs ?? '?'} ms (${downloadedBytes ? `${human(downloadedBytes)} downloaded` : 'all from browser cache'}), session creation ${filesMs == null ? '?' : loadMs - filesMs} ms; weights ${human(weightsBytes)}, estimated memory ${human(rec.memoryBytes)}`);
  if (device === 'webgpu') watchDevice(ort, em);
  if (downloadedBytes && typeof caches !== 'undefined') {
    // Transformers.js only warns when the Cache API refuses a file (quota); make that visible.
    try { const c = await caches.open(CACHE_NAME); const miss = []; for (const f of plan.files) if (!(await c.match(`${HUB}${plan.repo}/resolve/main/${f}`))) miss.push(f); if (miss.length) em.warn(`not stored in the browser cache (storage quota?): ${miss.join(', ')} — it will be downloaded again next time; see model.cache`); } catch { /* cache inspection is best effort */ }
  }
  return { rec, fresh: true, plan };
}

/** Load (or reuse) a model for this call. → { rec, fresh, fallbackReason } */
async function ensure(args, task, em, span = [0, 0.3]) {
  const { tf, ort } = await runtime(em);
  const entry = resolveModel(args.model, task);
  const d = await decide(args.backend || 'auto', em);
  if (d.reason) em.warn(`WebGPU not used: ${d.reason} → running on WebAssembly (single thread)`);
  else em.log(d.device === 'webgpu' ? `backend: WebGPU — ${[d.g.vendor, d.g.architecture, d.g.description].filter(Boolean).join(' ') || 'adapter'}; shader-f16 ${d.g.shaderF16 ? 'yes' : 'NO (16-bit float models unavailable; using fp32 activations)'}` : 'backend: WebAssembly (single thread) as requested');
  const opts = { dtype: args.dtype || 'auto', word: !!args.word };
  try {
    return { ...(await loadOn(tf, ort, entry, d.device, d.g, opts, em, span)), fallbackReason: d.reason, entry, tf };
  } catch (e) {
    const info = describe(e, 'model load');
    // only a failure of the GPU path itself is worth a CPU retry — not a missing repo, a refused download or a full disk
    if (d.device !== 'webgpu' || (args.backend || 'auto') !== 'auto' || lost || /Unauthorized|Could not locate|HTTP \d|404|network error|quota|this repo offers|no Transformers\.js-compatible/i.test(info.message)) throw e;
    if (entry.task === 'llm' && entry.cpu === 'no') throw e;   // no CPU variant to fall back to
    if (info.fatal) throw e;                                    // after an out-of-memory abort the runtime itself is suspect: restart it rather than retry inside it
    const why = `WebGPU load failed (${info.message.slice(0, 300)})`;
    em.warn(`${why} → retrying on WebAssembly`);
    return { ...(await loadOn(tf, ort, entry, 'wasm', d.g, opts, em, span)), fallbackReason: why, entry, tf };
  }
}

const common = (r, t) => ({
  model: r.rec.id, repo: r.rec.repo, backend: r.rec.backend, dtype: r.rec.dtype, fallbackReason: r.fallbackReason,
  loadMs: r.fresh ? r.rec.loadMs : 0, downloadedBytes: job.net.bytes, fromCache: job.net.bytes === 0,
  downloadedFrom: job.net.bytes ? [...new Set(job.net.files.map((f) => f.host))] : undefined, totalMs: ms(t),
});

// ───────────────────────────────────────────────────────── whisper ──
const SR = 16000, WINDOW = 30 * SR;

/** Share of distinct token 3-grams: ≈ 1 for normal speech, near 0 for a decoder stuck in a loop. Short outputs count as fine. */
function distinctness(ids) {
  if (ids.length < 24) return 1;
  const seen = new Set();
  for (let i = 2; i < ids.length; i++) seen.add(`${ids[i - 2]},${ids[i - 1]},${ids[i]}`);
  return seen.size / (ids.length - 2);
}

async function detectLanguage(tf, rec, features) {
  const gc = rec.model.generation_config;
  const ids = Object.entries(gc.lang_to_id || {});
  if (!ids.length) return null;
  const keep = new Set(ids.map((x) => x[1]));
  let top = null;
  class LanguageOnly extends tf.LogitsProcessor {
    _call(_ids, logits) {
      const d = logits.data; let mx = -Infinity;
      for (const [, i] of ids) if (d[i] > mx) mx = d[i];
      let sum = 0; const p = ids.map(([tok, i]) => { const e = Math.exp(d[i] - mx); sum += e; return [tok.slice(2, -2), e]; });
      p.sort((a, b) => b[1] - a[1]); top = p.slice(0, 3).map(([language, e]) => ({ language, probability: round(e / sum, 3) }));
      for (let i = 0; i < d.length; i++) if (!keep.has(i)) d[i] = -Infinity;
      return logits;
    }
  }
  const lp = new tf.LogitsProcessorList(); lp.push(new LanguageOnly());
  await rec.model.generate({ inputs: features, decoder_input_ids: [gc.decoder_start_token_id], max_new_tokens: 1, logits_processor: lp });
  return top;
}

/**
 * Long-form transcription the way the reference Whisper does it: slide a 30 s window; each window is decoded with
 * timestamp tokens; the next window starts at the last timestamp the model closed, so no sentence is cut at a window edge
 * and segment times are (window start + in-window timestamp) — nothing is merged by text overlap.
 */
async function transcribe(args, em) {
  const t = now();
  const audio = args.audio;
  const word = args.timestamps === 'word';
  const r = await ensure({ ...args, word }, 'speech', em);
  const { rec, tf } = r;
  const gc = rec.model.generation_config;
  const multilingual = gc.is_multilingual ?? !!gc.lang_to_id;
  let language = args.language && args.language !== 'auto' ? String(args.language).toLowerCase() : null;
  const task = args.task || 'transcribe';
  if (!multilingual) {
    if (language && !['en', 'english'].includes(language)) throw new Error(`${rec.id} is an English-only model and cannot transcribe "${language}" — use a multilingual model: ${idsOf('speech').filter((x) => !x.endsWith('.en')).join(', ')}`);
    if (task === 'translate') throw new Error(`${rec.id} is English-only: task=translate needs a multilingual model (${idsOf('speech').filter((x) => !x.endsWith('.en')).join(', ')})`);
  }
  const lo = r.fresh ? 0.3 : 0;
  const runT = now();
  let detected = null, detectMs = 0;
  if (multilingual && !language) {
    const td = now();
    // detect on the loudest of the first few windows' start: plain "first 30 s" as the reference implementation does
    const feats = await rec.processor(audio.subarray(0, Math.min(audio.length, WINDOW)));
    detected = await detectLanguage(tf, rec, feats.input_features);
    detectMs = ms(td);
    language = detected?.[0]?.language || 'en';
    em.log(`language detected in ${detectMs} ms: ${detected ? detected.map((d) => `${d.language} ${Math.round(d.probability * 100)}%`).join(', ') : 'unavailable → en'}`);
  }
  const lang = multilingual ? { language, task } : {};
  if (!multilingual) language = 'en';
  const duration = audio.length / SR;
  const segments = []; let words = null; let windows = 0, tokens = 0, firstTokenMs = null, wordGlue = null, redecoded = 0, loops = 0;

  if (word) {
    // Word times come from the decoder's cross-attention (DTW), which only the *_timestamped exports expose; this path
    // uses the runtime's own pipeline: 30 s chunks with 5 s overlap, merged on the overlapping words.
    const pipe = new tf.AutomaticSpeechRecognitionPipeline({ task: 'automatic-speech-recognition', model: rec.model, tokenizer: rec.tokenizer, processor: rec.processor });
    const nChunks = audio.length <= WINDOW ? 1 : Math.ceil((audio.length - WINDOW) / (20 * SR)) + 1;
    em.progress(lo, `word-level pass over ${nChunks} chunk(s)`);
    const out = await pipe(audio, { ...lang, return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
    windows = nChunks;
    const glue = ['zh', 'ja', 'th', 'lo', 'my', 'yue', 'chinese', 'japanese', 'thai', 'lao', 'myanmar', 'cantonese'].includes(language) ? '' : ' ';   // scripts written without spaces
    wordGlue = glue;
    words = (out.chunks || []).map((c) => ({ start: round(c.timestamp[0] ?? 0, 2), end: round(Math.min(c.timestamp[1] ?? duration, duration), 2), text: c.text }));
    // group words into subtitle-sized segments: break on sentence punctuation, a pause > 0.8 s, or 12 s / 84 characters
    let cur = null;
    for (const w of words) {
      if (cur && (w.start - cur.end > 0.8 || w.end - cur.start > 12 || cur.text.length > 84 || /[.!?。？！]$/.test(cur.text))) { segments.push(cur); cur = null; }
      const piece = w.text.trim();
      if (!cur) cur = { start: w.start, end: w.end, text: piece }; else { cur.end = w.end; cur.text += (/^['’\-]/.test(piece) ? '' : glue) + piece; }   // "o" + "'clock" is one word
    }
    if (cur) segments.push(cur);
    tokens = words.length;
  } else {
    const tsBegin = gc.no_timestamps_token_id + 1;
    const eot = Array.isArray(gc.eos_token_id) ? gc.eos_token_id[0] : gc.eos_token_id;
    const decode = (ids) => rec.tokenizer.decode(ids, { skip_special_tokens: true });
    const add = (offset, a, b, ids) => {
      const textIds = ids.filter((x) => x < eot);
      if (!textIds.length) return;                                   // a pair of timestamps around silence
      const text = decode(textIds);
      if (!text.trim()) return;
      const start = Math.min(duration, offset + a), end = Math.min(duration, Math.max(offset + b, offset + a));
      segments.push({ start: round(start, 2), end: round(end, 2), text });
    };
    let seek = 0;
    while (seek < audio.length) {
      const chunk = audio.subarray(seek, Math.min(audio.length, seek + WINDOW));
      if (chunk.length < SR / 10 && windows > 0) break;              // < 0.1 s tail: nothing to hear
      const offset = seek / SR, winDur = chunk.length / SR;
      em.progress(lo + (1 - lo) * (seek / audio.length), `window ${windows + 1}: ${offset.toFixed(1)}–${(offset + winDur).toFixed(1)} s of ${duration.toFixed(1)} s`);
      const feats = await rec.processor(chunk);
      const tg = now();
      const decodeWindow = async (temperature) => {
        const o = await rec.model.generate({ inputs: feats.input_features, ...lang, return_timestamps: true, max_new_tokens: 440, ...(temperature ? { do_sample: true, temperature } : { do_sample: false }) });
        return (o.sequences ?? o).tolist()[0].map(Number);
      };
      let seq = await decodeWindow(0);
      if (firstTokenMs == null) { firstTokenMs = ms(tg); em.log(`first window decoded in ${firstTokenMs} ms${rec.runs === 0 && rec.backend === 'webgpu' ? ' (includes WebGPU shader compilation; later windows are faster)' : ''}`); }
      // Greedy Whisper sometimes falls into a loop ("of the list of the list of the …") and swallows the window. Like the
      // reference implementation, re-decode such a window with some temperature and keep the least repetitive result.
      let variety = distinctness(seq.filter((x) => x < eot));
      for (const temperature of [0.4, 0.8]) {
        if (variety >= 0.5) break;
        em.warn(`window ${windows + 1} (${offset.toFixed(1)} s): the decoder fell into a repetition loop (only ${Math.round(variety * 100)}% distinct 3-grams) — decoding it again with temperature ${temperature}`);
        const again = await decodeWindow(temperature); const v = distinctness(again.filter((x) => x < eot));
        redecoded++;
        if (v > variety) { seq = again; variety = v; }
      }
      if (variety < 0.5) { loops++; em.warn(`window ${windows + 1}: still repetitive after two retries — its text is unreliable; try a larger model`); }
      // drop the prompt (<|startoftranscript|><|lang|><|task|>) and end-of-text; keep text and timestamp tokens
      const body = seq.filter((x) => x < eot || x >= tsBegin);
      tokens += body.length; windows++;
      const isTs = (x) => x >= tsBegin; const sec = (x) => (x - tsBegin) * 0.02;
      const pairs = []; for (let i = 1; i < body.length; i++) if (isTs(body[i - 1]) && isTs(body[i])) pairs.push(i);
      const singleEnd = body.length >= 2 && isTs(body.at(-1)) && !isTs(body.at(-2));
      let next;
      if (pairs.length) {
        const cuts = singleEnd ? [...pairs, body.length] : pairs;
        let from = 0;
        for (const cut of cuts) { const s = body.slice(from, cut); if (s.length) add(offset, sec(s[0]), sec(s.at(-1)), s); from = cut; }
        // closed by a lone timestamp → the rest of the window is silence; otherwise resume where the last closed segment ended
        next = singleEnd ? seek + chunk.length : seek + Math.round(sec(body[from - 1]) * SR);
      } else {
        const ts = body.filter(isTs); const end = ts.length && sec(ts.at(-1)) > 0 ? Math.min(winDur, sec(ts.at(-1))) : winDur;
        add(offset, ts.length > 1 ? sec(ts[0]) : 0, end, body);
        next = seek + chunk.length;
      }
      if (next <= seek + SR) next = seek + chunk.length;               // never stall: a window always advances
      seek = next;
    }
  }
  rec.runs++; rec.lastUsed = Date.now();
  const runMs = ms(runT);
  for (const s of segments) s.text = s.text.replace(/\s+/g, ' ');
  // segment texts from Whisper carry their own leading space; word-mode segments were built from trimmed words
  const text = segments.map((s) => s.text).join(wordGlue ?? '').replace(/\s+/g, ' ').trim();
  em.log(`transcribed ${duration.toFixed(1)} s of audio in ${(runMs / 1000).toFixed(1)} s (real-time factor ${round(runMs / 1000 / duration, 3)}) on ${rec.backend}: ${windows} window(s), ${segments.length} segment(s), ${tokens} tokens`);
  return {
    text, segments, words, language, languageDetected: !!detected, languageCandidates: detected || undefined, task: multilingual ? task : 'transcribe',
    multilingual, windows, tokens, runMs, detectMs, firstWindowMs: firstTokenMs, redecodedWindows: redecoded, repetitiveWindows: loops, ...common(r, t),
  };
}

// ───────────────────────────────────────────────────────────── llm ──
async function generate(args, em) {
  const t = now();
  const r = await ensure(args, 'llm', em);
  const { rec, tf } = r; const tk = rec.tokenizer;
  let enc;
  if (args.messages) {
    try { enc = tk.apply_chat_template(args.messages, { add_generation_prompt: true, return_dict: true }); } catch (e) {
      throw new Error(`cannot apply the chat template of ${rec.repo}: ${e?.message || e} — roles must be system/user/assistant in an order the model accepts; a model without a chat template only works with llm.generate raw=true`);
    }
  } else enc = tk(args.prompt);
  const promptTokens = enc.input_ids.dims.at(-1);
  const cfg = rec.model.config || {};
  const context = cfg.max_position_embeddings ?? cfg.n_positions ?? cfg.n_ctx ?? null;
  if (context && promptTokens + args.maxTokens > context) throw new Error(`prompt is ${promptTokens} tokens and maxTokens is ${args.maxTokens}: together they exceed the ${context}-token context of ${rec.id} — shorten the prompt or lower maxTokens`);
  if (promptTokens > 4096) em.warn(`long prompt (${promptTokens} tokens): memory use and time to first token grow with it`);
  em.log(`prompt: ${promptTokens} tokens; generating up to ${args.maxTokens}${args.temperature > 0 ? ` (sampling: temperature ${args.temperature}, top-p ${args.topP}${args.seed != null ? `, seed ${args.seed}` : ''})` : ' (greedy)'}`);

  const lo = r.fresh ? 0.3 : 0;
  let n = 0, tFirst = null, tLast = null, lastTick = 0, stopHit = null;
  const tg = now();
  class Counter extends tf.BaseStreamer {
    constructor() { super(); this.prompt = true; }
    put() {
      if (this.prompt) { this.prompt = false; return; }
      n++; tLast = now();
      if (tFirst == null) { tFirst = tLast; em.log(`first token after ${Math.round(tFirst - tg)} ms${rec.runs === 0 && rec.backend === 'webgpu' ? ' (first run: includes WebGPU shader compilation)' : ''}`); }
      if (tLast - lastTick > 300) { lastTick = tLast; em.progress(lo + (1 - lo) * Math.min(1, n / args.maxTokens), `${n} tokens${n > 1 ? `, ${((n - 1) / ((tLast - tFirst) / 1000)).toFixed(1)} tokens/s` : ''}`); }
    }
    end() {}
  }
  const stops = (args.stop || []).filter((s) => typeof s === 'string' && s.length);
  const criteria = new tf.StoppingCriteriaList();
  if (stops.length) {
    const tail = Math.max(...stops.map((s) => s.length)) + 8;
    class StopOnText extends tf.StoppingCriteria {
      _call(ids) {
        return ids.map((seq) => {
          const from = Math.max(promptTokens, seq.length - tail);
          const text = tk.decode(seq.slice(from), { skip_special_tokens: true });
          const hit = stops.find((s) => text.includes(s));
          if (hit) stopHit = hit;
          return !!hit;
        });
      }
    }
    criteria.push(new StopOnText());
  }
  const gen = { ...enc, max_new_tokens: args.maxTokens, do_sample: args.temperature > 0, streamer: new Counter(), stopping_criteria: criteria };
  if (args.temperature > 0) { gen.temperature = args.temperature; gen.top_p = args.topP; if (args.topK) gen.top_k = args.topK; }
  if (args.repetitionPenalty) gen.repetition_penalty = args.repetitionPenalty;
  if (args.seed != null) tf.random.seed(args.seed);
  const out = await rec.model.generate(gen);
  const generateMs = ms(tg);
  const seq = (out.sequences ?? out).tolist()[0];
  const fresh = seq.slice(promptTokens);
  let text = tk.decode(fresh, { skip_special_tokens: true });
  const eos = [rec.model.generation_config?.eos_token_id, cfg.eos_token_id, tk.eos_token_id].flat().filter((x) => x != null).map(Number);
  let finishReason = fresh.length >= args.maxTokens ? 'length' : 'eos';
  if (fresh.length && eos.includes(Number(fresh.at(-1)))) finishReason = 'eos';
  if (stopHit) {
    const cut = Math.min(...stops.map((s) => text.indexOf(s)).filter((i) => i >= 0));
    if (Number.isFinite(cut)) { text = text.slice(0, cut); finishReason = 'stop'; }
  }
  rec.runs++; rec.lastUsed = Date.now();
  const decodeS = tFirst != null && tLast > tFirst ? (tLast - tFirst) / 1000 : 0;
  const tps = decodeS ? round((n - 1) / decodeS, 1) : null;
  em.log(`generated ${fresh.length} tokens in ${generateMs} ms on ${rec.backend}: first token ${tFirst == null ? '?' : Math.round(tFirst - tg)} ms, then ${tps ?? '?'} tokens/s; finish: ${finishReason}`);
  return {
    text, finishReason, stopString: stopHit || undefined, promptTokens, tokens: fresh.length, tokensPerSecond: tps,
    timeToFirstTokenMs: tFirst == null ? null : Math.round(tFirst - tg), generateMs, context,
    sampling: args.temperature > 0 ? { temperature: args.temperature, topP: args.topP, topK: args.topK || undefined, seed: args.seed ?? null } : 'greedy',
    ...common(r, t),
  };
}

// ──────────────────────────────────────────────────────── download ──
async function download(args, em) {
  const t = now();
  const { tf } = await runtime(em);
  const entry = resolveModel(args.model, args.task);
  const d = await decide(args.backend || 'auto', em);
  const plan = planFor(entry, d.device, d.g.shaderF16, args.dtype || 'auto', !!args.word);
  if (d.device === 'wasm') await cpuPolicy(tf, entry, plan);
  if (typeof caches === 'undefined') throw new Error('the Cache API is not available in this browser context (private window or insecure origin), so nothing can be stored ahead of time; speech.transcribe / llm.* still work but download the model on every page load');
  em.log(`resolving files of ${plan.repo} [${plan.label}] for ${d.device}${d.reason ? ` (WebGPU not usable: ${d.reason})` : ''}`);
  job.backend = d.device;
  let files;
  try { files = await tf.ModelRegistry.get_files(plan.repo, { device: d.device, dtype: plan.dtype, include_processor: entry.task === 'speech' }); } catch (e) {
    throw new Error(`cannot list the files of ${plan.repo}: ${describe(e, 'model.download').message}`);
  }
  const cache = await caches.open(CACHE_NAME);
  const list = []; let cachedBytes = 0, got = 0, live = 0;
  const expected = plan.bytes || 0; let lastTick = 0;
  const inflight = new Map();   // file → bytes so far
  const tick = () => {
    const tt = now(); if (tt - lastTick < 250) return; lastTick = tt;
    live = 0; for (const v of inflight.values()) live += v;
    const all = Math.max(expected, cachedBytes + got + live);
    em.progress(Math.min(0.99, (cachedBytes + got + live) / (all || 1)), `downloading ${[...inflight.keys()].join(' + ')} — ${human(cachedBytes + got + live)} of ${human(all)}`);
  };
  const fetchOne = async (file) => {
    const url = `${HUB}${plan.repo}/resolve/main/${file}`;
    const hit = await cache.match(url);
    if (hit) {
      const b = Number(hit.headers.get('content-length')) || 0;
      // a file the resolver itself fetched a moment ago (config.json) was downloaded by this call, not "already cached"
      const mine = job.net.files.some((f) => f.file === file);
      if (mine) got += b; else cachedBytes += b;
      list.push({ file, bytes: b, cached: !mine }); return;
    }
    const res = await trackedFetch(url, { method: 'GET' });
    if (!res.ok) {
      let have = null; try { have = await tf.ModelRegistry.get_available_dtypes(plan.repo); } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status} for ${file} of ${plan.repo}${have?.length ? ` — this repo offers dtype: ${have.join(', ')} (requested ${plan.label})` : ''}`);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    const headers = new Headers(); const ct = res.headers.get('content-type'); if (ct) headers.set('content-type', ct);
    let bytes = 0; inflight.set(file, 0);
    try {
      if (total > 16 * MB && res.body && typeof TransformStream !== 'undefined') {
        // stream big files straight into the cache: nothing the size of a model is held in memory
        headers.set('content-length', String(total));
        const counter = new TransformStream({ transform(chunk, c) { bytes += chunk.byteLength; inflight.set(file, bytes); tick(); c.enqueue(chunk); } });
        await cache.put(url, new Response(res.body.pipeThrough(counter), { status: 200, headers }));
        if (bytes !== total) { await cache.delete(url); throw new Error(`download of ${file} was cut short (${human(bytes)} of ${human(total)}): network error — retry; complete files stay cached`); }
      } else {
        const buf = await res.arrayBuffer(); bytes = buf.byteLength;
        headers.set('content-length', String(bytes));
        await cache.put(url, new Response(buf, { status: 200, headers }));
      }
    } finally { inflight.delete(file); }
    got += bytes; list.push({ file, bytes, cached: false });
  };
  // three files at a time: the two or three weight files of a model download side by side
  const todo = [...files]; let failure = null;
  await Promise.all(Array.from({ length: Math.min(3, todo.length) }, async () => { while (todo.length && !failure) { try { await fetchOne(todo.shift()); } catch (e) { failure = e; } } }));
  if (failure) throw failure;
  list.sort((x, y) => files.indexOf(x.file) - files.indexOf(y.file));
  const seconds = round(ms(t) / 1000, 1);
  em.log(`${plan.repo} [${plan.label}]: ${human(got)} downloaded, ${human(cachedBytes)} already cached, ${seconds} s`);
  return {
    model: entry.id, repo: plan.repo, task: entry.task, preparedFor: d.device, dtype: plan.label, fallbackReason: d.reason,
    files: list.length, downloadedBytes: got, alreadyCachedBytes: cachedBytes, totalBytes: got + cachedBytes, fromCache: got === 0,
    seconds, megabytesPerSecond: got && seconds ? round(got / MB / seconds, 1) : null,
    downloadedFrom: got ? [...new Set(job.net.files.map((f) => f.host))] : undefined, fileList: list.slice(0, 12),
  };
}

// ─────────────────────────────────────────────── status + unload ──
function status() {
  return {
    loaded: [...loaded.values()].map((r) => ({
      model: r.id, repo: r.repo, task: r.task, backend: r.backend, dtype: r.dtype, weightsBytes: r.weightsBytes, estimatedMemoryBytes: r.memoryBytes,
      loadMs: r.loadMs, runs: r.runs, loadedSecondsAgo: Math.round((Date.now() - r.loadedAt) / 1000), idleSeconds: Math.round((Date.now() - r.lastUsed) / 1000),
    })),
    runtime: rtVersions, busy: job ? job.op : null, deviceLost: lost, contactedHosts: [...contacted],
    context: typeof document === 'undefined' ? 'worker' : 'page',
  };
}

async function unload(args, em) {
  const want = args.model ? String(args.model).toLowerCase() : null;
  const gone = [];
  for (const [k, r] of [...loaded]) {
    if (want && r.id.toLowerCase() !== want && r.repo.toLowerCase() !== want) continue;
    gone.push({ model: r.id, backend: r.backend, dtype: r.dtype, estimatedMemoryBytes: r.memoryBytes });
    await dispose(k, em);
  }
  return { unloaded: gone, remaining: loaded.size };
}

async function probe() {
  return { gpu: await probeGpu(), wasm: probeWasm(), cacheApi: typeof caches !== 'undefined' };
}
async function versions(_a, em) { const r = await runtime(em); return r.versions; }

const OPS = { transcribe, generate, download, unload, probe, versions };

/** One request in, a stream of {log|warn|progress} and exactly one {result|error} out. */
export async function handle({ id, op, args }, post) {
  if (op === 'status') { post({ id, type: 'result', result: status() }); return; }
  if (op === 'plan') {
    // which model would this call need, and is something else loaded? (the page replaces the worker instead of reusing its heap)
    let result = { loaded: false, others: [] };
    try {
      const entry = resolveModel(args.model, args.task);
      const d = await decide(args.backend || 'auto', { log() {}, warn() {} });
      const plan = planFor(entry, d.device, d.g.shaderF16, args.dtype || 'auto', !!args.word);
      result = { key: plan.key, loaded: loaded.has(plan.key), others: [...loaded.values()].filter((r) => r.key !== plan.key).map((r) => `${r.id} [${r.backend}, ${r.dtype}]`) };
    } catch { /* the real call reports the problem */ }
    post({ id, type: 'result', result }); return;
  }
  if (op === '_loseDevice') {   // test hook (not a tool): destroy the runtime's GPUDevice to exercise the device-lost path
    try { const { ort } = await rt; const dev = await ort.env.webgpu.device; dev.destroy(); post({ id, type: 'result', result: { destroyed: true } }); } catch (e) { post({ id, type: 'error', error: `no device to destroy: ${e?.message || e}` }); }
    return;
  }
  const em = {
    log: (msg) => post({ id, type: 'log', msg }), warn: (msg) => post({ id, type: 'warn', msg }),
    progress: (fraction, note) => post({ id, type: 'progress', fraction, note }),
  };
  if (!OPS[op]) { post({ id, type: 'error', error: `mind engine: unknown op ${op}` }); return; }
  const mine = { id, op, em, net: { bytes: 0, files: [] }, backend: null, fatal: null };
  job = mine;
  try {
    const result = await Promise.race([OPS[op](args || {}, em), new Promise((_, rej) => { mine.fatal = rej; })]);
    post({ id, type: 'result', result });
  } catch (e) {
    // a run that dies on the GPU usually fails a moment BEFORE the device's `lost` promise settles: give it that moment,
    // so the caller gets "device lost — do this" instead of a raw buffer-mapping error
    if (mine.backend === 'webgpu' && !lost && typeof e !== 'number' && /gpu|OrtRun|mapAsync|buffer/i.test(e?.message || '')) await new Promise((r) => setTimeout(r, 80));
    const info = describe(e, op);
    if (info.fatal) { for (const [k, r] of [...loaded]) { loaded.delete(k); Promise.resolve().then(() => r.model.dispose()).catch(() => {}); } }
    post({ id, type: 'error', error: info.message, fatal: info.fatal });
  } finally { if (job === mine) job = null; }
}
