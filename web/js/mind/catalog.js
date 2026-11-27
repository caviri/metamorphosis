// mind :: the model catalogue and the policy that maps (model, backend, GPU features) → which files to fetch.
// Pure data + pure functions: imported by the page (tools/mind.js) and by the inference engine (worker).
// Weights are NOT part of this site. They are fetched at run time from the Hugging Face Hub and cached by the browser.

export const HUB = 'https://huggingface.co/';
export const HUB_HOSTS = /(^|\.)huggingface\.co$|(^|\.)hf\.co$/;   // huggingface.co and its CDNs (cdn-lfs*.hf.co, cas-bridge.xethub.hf.co, …)
export const CACHE_NAME = 'transformers-cache';                    // Cache API bucket used by Transformers.js
export const MB = 1e6;                                             // sizes below are decimal megabytes of the files on the Hub

/** file-name suffix of each quantisation in Transformers.js-style ONNX repos */
export const DTYPE_SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };
export const DTYPES = Object.keys(DTYPE_SUFFIX);

// bytes: total download per variant (weights + tokenizer/config), measured on the Hub 2026-11-27.
//   gpu    = WebGPU default (speech: fp32 encoder + q4 decoder; llm: q4f16, needs the shader-f16 GPU feature)
//   gpuNoF16 = llm on a WebGPU adapter without shader-f16 (q4, fp32 activations)
//   cpu    = WASM (q8)
const speech = (id, repo, multilingual, params, gpu, cpu, note) => ({
  id, task: 'speech', repo, wordRepo: `${repo}_timestamped`, family: 'Whisper (OpenAI)', params, licence: 'Apache-2.0',
  languages: multilingual ? '99 languages (multilingual); can also translate speech to English' : 'English only',
  multilingual, bytes: { gpu, gpuNoF16: gpu, cpu }, cpu: 'ok', note,
});
// gpuDtype: quantisation used on WebGPU when the adapter has shader-f16 ('q4f16' = 4-bit weights, 16-bit float maths: smallest and
// fastest) — or 'q4' (4-bit weights, 32-bit float maths) for models whose fp16 exports produce garbage on WebGPU.
const llm = (id, repo, family, params, context, gpuDtype, gpu, gpuNoF16, cpuBytes, cpu, languages, note) => ({
  id, task: 'llm', repo, family, params, licence: 'Apache-2.0', languages, context, gpuDtype, bytes: { gpu, gpuNoF16, cpu: cpuBytes }, cpu, note,
});

export const CATALOG = [
  speech('whisper-tiny', 'onnx-community/whisper-tiny', true, '39M', 122388197, 43613734, 'fastest; fine for clear speech, weakest on accents, noise and non-English'),
  speech('whisper-tiny.en', 'onnx-community/whisper-tiny.en', false, '39M', 122309681, 43536374, 'English-only tiny: a little more accurate than whisper-tiny on English'),
  speech('whisper-base', 'onnx-community/whisper-base', true, '74M', 208840059, 79664191, 'default: good speed/accuracy balance'),
  speech('whisper-base.en', 'onnx-community/whisper-base.en', false, '74M', 208760882, 79586556, 'English-only base'),
  speech('whisper-small', 'onnx-community/whisper-small', true, '244M', 588744805, 251846613, 'most accurate here; use for non-English, accents or noisy audio. Slow on CPU (several times slower than whisper-base)'),
  speech('whisper-small.en', 'onnx-community/whisper-small.en', false, '244M', 588664964, 251769085, 'English-only small'),

  llm('smollm2-135m', 'HuggingFaceTB/SmolLM2-135M-Instruct', 'SmolLM2 (Hugging Face TB)', '135M', 8192, 'q4f16', 119800439, 184177866, 139257294, 'ok', 'English',
    'smallest: quick rewrites and toy tasks only; unreliable on facts and arithmetic'),
  llm('smollm2-360m', 'HuggingFaceTB/SmolLM2-360M-Instruct', 'SmolLM2 (Hugging Face TB)', '360M', 8192, 'q4f16', 274846573, 390052544, 366673969, 'ok', 'English',
    'default: small and fast — short summaries, rephrasing, simple extraction and Q&A'),
  llm('qwen2.5-0.5b', 'onnx-community/Qwen2.5-0.5B-Instruct', 'Qwen2.5 (Alibaba)', '494M', 32768, 'q4', 793197262, 793197262, 519136999, 'slow', 'multilingual (29+ languages, strongest in English and Chinese)',
    'smallest multilingual model, 32k context; runs with fp32 maths on WebGPU because its 16-bit exports generate garbage there'),
  llm('smollm2-1.7b', 'HuggingFaceTB/SmolLM2-1.7B-Instruct', 'SmolLM2 (Hugging Face TB)', '1.7B', 8192, 'q4f16', 1110839698, 1414078967, null, 'no', 'English',
    'best English quality here: better summaries, reasoning and format-following; WebGPU only'),
  // Not listed: onnx-community/Qwen2.5-1.5B-Instruct. Tested 2026-11-27 on WebGPU (NVIDIA, Chrome): its q4f16 export loads
  // but generates garbage ("!!!!…", fp16 overflow) and its q4 export (1.79 GB in one file) cannot be loaded — the 32-bit
  // WASM side of ONNX Runtime runs out of memory creating the session (std::bad_alloc).
];

export const DEFAULTS = { speech: 'whisper-base', llm: 'smollm2-360m' };
export const idsOf = (task) => CATALOG.filter((m) => m.task === task).map((m) => m.id);

/** An uncatalogued LLM larger than this (weights on disk) is refused on WASM: single-threaded CPU inference would take minutes per answer and can exhaust the 4 GB WASM address space. */
export const CPU_LLM_MAX_BYTES = 700 * MB;

/**
 * 'whisper-base' | 'org/repo' → catalogue entry, or a synthetic entry for any other Hugging Face repo id.
 * task: 'speech' | 'llm' (required for uncatalogued repos; guessed from the name when absent).
 */
export function resolveModel(name, task) {
  const want = String(name || (task && DEFAULTS[task]) || '').trim();
  if (!want) throw new Error('no model given');
  const low = want.toLowerCase();
  const hit = CATALOG.find((m) => m.id === low || m.repo.toLowerCase() === low || (m.wordRepo && m.wordRepo.toLowerCase() === low));
  if (hit) {
    if (task && hit.task !== task) throw new Error(`model "${want}" is a ${hit.task} model, not a ${task} model — ${task} models: ${idsOf(task).join(', ')} (or a Hugging Face repo id)`);
    return hit;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(want)) {
    throw new Error(`unknown model "${want}" — catalogue: ${(task ? idsOf(task) : CATALOG.map((m) => m.id)).join(', ')}; or give a Hugging Face repo id "org/name" that holds Transformers.js-compatible ONNX files (an onnx/ folder), e.g. onnx-community/…`);
  }
  const guessed = task || (/whisper/i.test(want) ? 'speech' : 'llm');
  return { id: want, task: guessed, repo: want, family: 'uncatalogued Hugging Face repo', licence: 'see the model card on huggingface.co', languages: 'unknown', bytes: {}, cpu: 'unknown', custom: true, multilingual: guessed === 'speech' ? !/\.en(_|$)/.test(want) : undefined };
}

/**
 * Which quantisation to load. device: 'webgpu' | 'wasm'; f16: adapter has shader-f16; override: explicit dtype or 'auto'.
 * → { dtype (string | per-file map for Transformers.js), label, files: [weight file paths], bytes (catalogue estimate | null), variant }
 */
export function planFor(entry, device, f16, override = 'auto', word = false) {
  const repo = word && entry.wordRepo ? entry.wordRepo : entry.repo;
  const custom = override && override !== 'auto';
  if (custom && !(override in DTYPE_SUFFIX)) throw new Error(`dtype must be one of: auto, ${DTYPES.join(', ')}`);
  const variant = device === 'wasm' ? 'cpu' : (entry.task === 'llm' && !f16 ? 'gpuNoF16' : 'gpu');
  let dtype, label, files;
  if (entry.task === 'speech') {
    // WebGPU: full-precision encoder (runs once per 30 s window) + 4-bit decoder (runs per token) — the combination the upstream
    // WebGPU Whisper demos use; fp16 Whisper exports are not used because they need shader-f16 and have a history of bad output.
    const enc = custom ? override : device === 'wasm' ? 'q8' : 'fp32';
    const dec = custom ? override : device === 'wasm' ? 'q8' : 'q4';
    dtype = { encoder_model: enc, decoder_model_merged: dec };
    label = enc === dec ? enc : `encoder ${enc} + decoder ${dec}`;
    files = [`onnx/encoder_model${DTYPE_SUFFIX[enc]}.onnx`, `onnx/decoder_model_merged${DTYPE_SUFFIX[dec]}.onnx`];
  } else {
    // uncatalogued repos get q4 on WebGPU: fp32 maths is the safe choice (several fp16 exports overflow to garbage on WebGPU)
    dtype = custom ? override : device === 'wasm' ? 'q8' : f16 ? (entry.gpuDtype || 'q4') : 'q4';
    label = dtype; files = [`onnx/model${DTYPE_SUFFIX[dtype]}.onnx`];
  }
  return { repo, dtype, label, files, variant, bytes: custom || (word && entry.wordRepo) ? null : entry.bytes?.[variant] ?? null, key: `${repo}|${device}|${label}` };
}

/** Rough resident memory while a model is loaded (weights + runtime working set). An estimate, not a measurement. */
export function memoryEstimate(bytes, device) {
  if (!bytes) return null;
  return Math.round(device === 'webgpu' ? bytes * 1.3 + 250 * MB : bytes * 2 + 300 * MB);
}

export const mb = (bytes) => (bytes == null ? null : Math.round(bytes / MB * 10) / 10);
