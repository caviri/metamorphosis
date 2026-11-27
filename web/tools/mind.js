// model.* · speech.* · llm.* — neural models that run inside the page: Whisper speech-to-text and small language models,
// on Transformers.js / ONNX Runtime Web (vendored, same origin), WebGPU when the browser has it, single-threaded WASM otherwise.
//
// The runtime is self-hosted. The WEIGHTS are not: they are downloaded on demand from the Hugging Face Hub
// (huggingface.co and its CDN) and kept in the browser's Cache API. That is the one cross-origin exception of this site;
// only model files come in, and nothing — audio, prompts, results, telemetry — goes out.
//
// Nothing heavy is imported here: the worker, the runtime and the WASM load on the first call that needs them.
import { vfs, register } from '../js/core.js';
import { CATALOG, DEFAULTS, DTYPES, HUB, MB, idsOf, resolveModel, planFor, memoryEstimate, mb } from '../js/mind/catalog.js';
import { probeGpu, probeWasm, human } from '../js/mind/caps.js';
import * as modelCache from '../js/mind/cache.js';
import * as engine from '../js/mind/client.js';

const round = (x, d = 2) => { const k = 10 ** d; return Math.round(x * k) / k; };
const ms = (t0) => Math.round(performance.now() - t0);

const PRIVACY = 'Runs entirely in this page: the audio/prompt and the result never leave the browser. The only network traffic is the one-time download of model files from huggingface.co (and its CDN hosts under hf.co), cached afterwards in the browser (Cache API).';
const sizeLine = (task) => CATALOG.filter((m) => m.task === task).map((m) => `${m.id} ${Math.round(m.bytes.gpu / MB)} MB${m.bytes.cpu ? ` (${Math.round(m.bytes.cpu / MB)} MB on CPU)` : ' (WebGPU only)'}`).join(', ');

const BACKEND = { type: 'string', enum: ['auto', 'gpu', 'cpu'], default: 'auto', description: 'auto = WebGPU when a hardware adapter exists, else single-threaded WebAssembly (the result says which, and why a fallback happened); gpu = WebGPU or fail; cpu = force WebAssembly' };
const DTYPE = { type: 'string', enum: ['auto', ...DTYPES], default: 'auto', description: 'Weight quantisation to load. auto picks per backend: speech → fp32 encoder + q4 decoder on WebGPU, q8 on CPU; llm → q4f16 on WebGPU with the shader-f16 feature (q4 without it, and always q4 for the Qwen2.5 models and for uncatalogued repos, whose 16-bit exports can produce garbage on WebGPU), q8 on CPU. Set it only to trade size for quality or for a repo that lacks the default file; the size figures in descriptions apply to auto.' };

async function machine() {
  const [gpu, wasm] = [await probeGpu(), probeWasm()];
  const usable = gpu.available && !gpu.fallbackAdapter;
  return { gpu, wasm, device: usable ? 'webgpu' : 'wasm', usable };
}
const gpuSummary = (g) => (g.available
  ? { available: true, adapter: [g.vendor, g.architecture, g.description].filter(Boolean).join(' ') || 'unknown', softwareFallback: g.fallbackAdapter, shaderF16: g.shaderF16, maxBufferSizeMB: g.maxBufferSize ? Math.round(g.maxBufferSize / MB) : null }
  : { available: false, reason: g.reason });

// ───────────────────────────────────────────────────────── audio in ──
/** Any audio/video file the browser can decode → Float32Array, mono, 16 kHz. */
async function decodeTo16k(path) {
  const st = vfs.stat(path);
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('this browser has no OfflineAudioContext (Web Audio API), which speech.transcribe needs to decode audio');
  let ac, direct = true;
  try { ac = new OAC(1, 1, 16000); } catch { ac = new OAC(1, 1, 44100); direct = false; }   // some engines refuse a 16 kHz context
  let buf;
  try { buf = await ac.decodeAudioData(vfs.read(path).slice().buffer); } catch (e) {
    throw new Error(`cannot decode "${st.path}" (${st.mime}, ${human(st.bytes)}) as audio in this browser: ${e?.message || e}. Web Audio decodes wav, mp3, flac, ogg/opus, m4a/aac and usually the audio track of mp4/webm; what exactly is supported differs between Chrome, Firefox and Safari. Convert first — audio.convert (audio room) to wav, or video.extractAudio (video room) for a video — then transcribe the result.`);
  }
  const n = buf.length, ch = buf.numberOfChannels;
  let mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i]; }
  if (ch > 1) for (let i = 0; i < n; i++) mono[i] /= ch;
  const sourceRate = buf.sampleRate;
  if (sourceRate !== 16000) {
    // context could not run at 16 kHz: average-then-interpolate down (box low-pass over each output sample's span)
    const ratio = sourceRate / 16000, m = Math.floor(n / ratio), out = new Float32Array(m);
    for (let i = 0; i < m; i++) { const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.min(n, Math.floor((i + 1) * ratio))); let s = 0; for (let j = a; j < b; j++) s += mono[j]; out[i] = s / (b - a); }
    mono = out;
  }
  return { audio: mono, channels: ch, resampledBy: direct && sourceRate === 16000 ? 'browser (decodeAudioData at 16 kHz)' : 'javascript box filter' };
}

const stamp = (t, sep) => {
  const msT = Math.max(0, Math.round(t * 1000)); const h = Math.floor(msT / 3600000), m = Math.floor(msT / 60000) % 60, s = Math.floor(msT / 1000) % 60, r = msT % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
};
const toSrt = (segs) => segs.map((s, i) => `${i + 1}\n${stamp(s.start, ',')} --> ${stamp(s.end, ',')}\n${s.text.trim()}\n`).join('\n');
const toVtt = (segs) => `WEBVTT\n\n${segs.map((s) => `${stamp(s.start, '.')} --> ${stamp(s.end, '.')}\n${s.text.trim()}\n`).join('\n')}`;

// ─────────────────────────────────────────────────────────── speech ──
register({
  name: 'speech.transcribe', gpu: true,
  description: `Speech-to-text with OpenAI Whisper running in the browser: turn any audio or video file in the VFS into text, with timestamps, in 99 languages (auto-detected), or translate foreign speech into English text. Use it for recordings, voice notes, podcasts, meetings, video soundtracks and subtitles. Any length: the audio is decoded to 16 kHz mono and walked through in 30 s windows, each new window starting where the last complete segment ended, so sentences are not cut and times are continuous. Always writes <name>.transcript.txt; on request also .srt and .vtt subtitles and a .json with every segment {start,end,text} (and words when timestamps=word). Returns the text (capped by maxChars, with a truncated flag), the language (and detection candidates), audio duration, real-time factor (processing time ÷ audio time; 0.1 = ten times faster than real time), the backend and quantisation actually used, load/run timings, downloadedBytes vs fromCache, and the output file stats. DOWNLOADS on first use of a model, from huggingface.co: ${sizeLine('speech')}; plus the 29 MB runtime from this site. Speed measured on a desktop PC (RTX-class GPU, fast CPU core) on a 90 s clip: with WebGPU whisper-tiny runs 23×, whisper-base 19× and whisper-small 13× faster than real time (the first window after a load adds 0.5–3 s of shader compilation); on CPU (single-threaded WASM — this host cannot enable threads) whisper-tiny 12×, whisper-base 6.5×, whisper-small 2.3×; expect several times less on a laptop or phone. Word timestamps take about three times as long. Limits: greedy decoding; a window in which the decoder loops on a phrase is detected and decoded again with temperature 0.4 / 0.8 (reported as redecodedWindows, and repetitiveWindows when that did not help), but there is no no-speech or log-probability filter, so long silences or music can still yield invented text; word mode has no loop check; no speaker labels. ${PRIVACY}`,
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the audio or video file (wav, mp3, flac, ogg/opus, m4a/aac, mp4, webm … whatever this browser\'s Web Audio decoder accepts)' },
      model: { type: 'string', default: DEFAULTS.speech, description: `Whisper model: ${idsOf('speech').join(' | ')} — tiny is fastest, small most accurate; ".en" variants are English-only and slightly better on English. Or any Hugging Face repo id with a Transformers.js Whisper export (e.g. onnx-community/whisper-large-v3-turbo, ~1 GB — WebGPU only in practice). model.list has sizes and what this machine can run.` },
      language: { type: 'string', default: 'auto', description: 'Spoken language as an ISO 639-1 code or English name ("es", "german"); auto = detect from the first 30 s. Give it when you know it: detection on tiny/base can be wrong for short or noisy clips.' },
      task: { type: 'string', enum: ['transcribe', 'translate'], default: 'transcribe', description: 'transcribe = text in the spoken language; translate = English text from non-English speech (multilingual models only)' },
      timestamps: { type: 'string', enum: ['segment', 'word'], default: 'segment', description: 'segment = phrase-level times from Whisper\'s own timestamp tokens (reliable to about ±0.3 s). word = one time span per word from the decoder\'s cross-attention; this loads the separate "<model>_timestamped" export (same size, a second download), runs in 30 s chunks with 5 s overlap, is slower, and word boundaries are approximate (±0.1–0.3 s).' },
      formats: { type: 'array', items: { type: 'string', enum: ['srt', 'vtt', 'json'] }, default: [], description: 'Extra output files besides the .txt: srt and/or vtt subtitles, json = all segments (and words) with start/end seconds' },
      start: { type: 'number', minimum: 0, description: 'Only transcribe from this second of the file (times in the outputs stay relative to the whole file)' },
      end: { type: 'number', minimum: 0, description: 'Only transcribe up to this second of the file' },
      backend: BACKEND,
      dtype: DTYPE,
      maxChars: { type: 'integer', default: 4000, minimum: 0, maximum: 100000, description: 'Cap on the text returned inline; the .txt file is never capped' },
      output: { type: 'string', description: 'VFS path of the text file (default: <input name>.transcript.txt); the other formats use the same name with their own extension' },
    },
    required: ['input'],
  },
  examples: ['speech.transcribe input=memo.mp3', 'speech.transcribe input=talk.mp4 model=whisper-small formats=srt,vtt', 'speech.transcribe input=entrevista.wav language=es task=translate', 'speech.transcribe input=clip.wav model=whisper-tiny.en backend=cpu timestamps=word formats=json'],
  async run(args, ctx) {
    const t0 = performance.now();
    resolveModel(args.model, 'speech');                       // fail on a bad model name before decoding anything
    ctx.progress(0, 'decoding audio');
    const dec = await decodeTo16k(args.input);
    const fileDuration = dec.audio.length / 16000;
    const a = Math.min(fileDuration, args.start || 0), b = Math.min(fileDuration, args.end ?? fileDuration);
    if (b - a < 0.1) throw new Error(`nothing to transcribe: the selected range is ${round(b - a, 2)} s (file is ${round(fileDuration, 2)} s; start=${args.start ?? 0}, end=${args.end ?? 'end'})`);
    // .slice (not subarray): the samples are transferred to the worker
    const audio = a > 0 || b < fileDuration ? dec.audio.slice(Math.round(a * 16000), Math.round(b * 16000)) : dec.audio;
    const duration = audio.length / 16000;
    let peak = 0; for (let i = 0; i < audio.length; i += 7) { const v = Math.abs(audio[i]); if (v > peak) peak = v; }
    const decodeMs = ms(t0);
    ctx.log(`audio decoded in ${decodeMs} ms: ${round(duration, 2)} s, ${dec.channels} channel(s) → mono 16 kHz via ${dec.resampledBy}, peak ${round(peak, 3)}`);
    if (peak < 0.003) ctx.warn('the audio is (near) silent — Whisper tends to invent text on silence');

    const r = await engine.request('speech', 'transcribe', { audio, model: args.model, backend: args.backend, dtype: args.dtype, language: args.language, task: args.task, timestamps: args.timestamps }, ctx, {
      transfer: [audio.buffer], wantGpu: args.backend !== 'cpu', plan: { model: args.model, task: 'speech', backend: args.backend, dtype: args.dtype, word: args.timestamps === 'word' },
    });
    const segments = r.segments.map((s, i) => ({ id: i + 1, start: round(s.start + a, 2), end: round(s.end + a, 2), text: s.text.trim() }));
    const words = r.words ? r.words.map((w) => ({ start: round(w.start + a, 2), end: round(w.end + a, 2), text: w.text.trim() })) : null;

    const txtPath = vfs.out(args.output, args.input, 'transcript', 'txt');
    const base = txtPath.replace(/\.[A-Za-z0-9]+$/, '');
    const meta = { duration: round(duration, 2), language: r.language };
    const outputs = [await vfs.write(txtPath, r.text + (r.text ? '\n' : ''), { mime: 'text/plain', meta })];
    const want = new Set(args.formats);
    const side = (ext) => vfs.out(args.output && `${base}.${ext}`, args.input, 'transcript', ext);
    if (want.has('srt')) outputs.push(await vfs.write(side('srt'), toSrt(segments), { meta }));
    if (want.has('vtt')) outputs.push(await vfs.write(side('vtt'), toVtt(segments), { meta }));
    if (want.has('json')) {
      outputs.push(await vfs.write(side('json'), JSON.stringify({
        source: args.input, model: r.model, repo: r.repo, language: r.language, task: r.task, duration: round(fileDuration, 2), range: [round(a, 2), round(b, 2)],
        text: r.text, segments, ...(words ? { words } : {}),
      }, null, 1), { mime: 'application/json', meta }));
    }
    const res = {
      text: r.text.slice(0, args.maxChars), chars: r.text.length, truncated: r.text.length > args.maxChars,
      language: r.language, languageDetected: r.languageDetected, languageCandidates: r.languageCandidates, task: r.task,
      duration: round(duration, 2), segments: segments.length, words: words ? words.length : undefined,
      firstSegments: segments.slice(0, 5), segmentsTruncated: segments.length > 5,
      realTimeFactor: round(r.runMs / 1000 / duration, 3), speed: `${round(duration / (r.runMs / 1000), 1)}× real time`,
      backend: r.backend, fallbackReason: r.fallbackReason, model: r.model, repo: r.repo, dtype: r.dtype, timestamps: args.timestamps,
      windows: r.windows, redecodedWindows: r.redecodedWindows || undefined, repetitiveWindows: r.repetitiveWindows || undefined, decodeMs, loadMs: r.loadMs, runMs: r.runMs, firstWindowMs: r.firstWindowMs ?? undefined,
      downloadedBytes: r.downloadedBytes, fromCache: r.fromCache, downloadedFrom: r.downloadedFrom, outputs,
    };
    if (r.repetitiveWindows) res.note = `${r.repetitiveWindows} window(s) of 30 s stayed stuck in a repetition loop: part of the text is unreliable — use a larger model (whisper-base or whisper-small)`;
    else if (!r.text) res.note = 'no speech recognised — check the file has an audible voice track (audio.stats), try a larger model, or set language explicitly';
    else if (r.languageDetected && r.languageCandidates?.[0]?.probability < 0.8) res.note = `language detection was unsure (${r.languageCandidates.map((c) => `${c.language} ${Math.round(c.probability * 100)}%`).join(', ')}) — pass language=<code> if the text looks wrong`;
    return res;
  },
});

// ────────────────────────────────────────────────────────────── llm ──
const LLM_PROPS = {
  model: { type: 'string', default: DEFAULTS.llm, description: `Which language model: ${CATALOG.filter((m) => m.task === 'llm').map((m) => `${m.id} (${m.params} parameters, ${Math.round(m.bytes.gpu / MB)} MB)`).join(' | ')}. Or any Hugging Face repo id holding a Transformers.js-compatible ONNX causal LM with a chat template (an onnx/ folder with model_q4f16.onnx etc., e.g. onnx-community/…) — untested repos may fail to load. model.list shows licences, memory needs and what this machine can run.` },
  system: { type: 'string', description: 'System prompt: standing instructions for the model (role, format, tone). Prepended as the system turn of the chat template.' },
  maxTokens: { type: 'integer', default: 256, minimum: 1, maximum: 4096, description: 'Upper bound on generated tokens (a token is roughly ¾ of an English word). Generation also ends at the model\'s end-of-turn token or a stop string.' },
  temperature: { type: 'number', default: 0, minimum: 0, maximum: 2, description: '0 = greedy decoding: deterministic, best for extraction and factual answers. 0.3–1.0 = sampling for more varied text.' },
  topP: { type: 'number', default: 0.9, minimum: 0.01, maximum: 1, description: 'Nucleus sampling: sample only from the smallest set of tokens whose probability mass reaches this value. Used when temperature > 0.' },
  topK: { type: 'integer', minimum: 1, maximum: 1000, description: 'Sample only from the k most likely tokens (default: the model\'s own setting). Used when temperature > 0.' },
  seed: { type: 'integer', minimum: 0, maximum: 4294967295, description: 'Seed for the sampler: the same seed, prompt, model, backend and quantisation reproduce the same text. Only matters when temperature > 0.' },
  repetitionPenalty: { type: 'number', minimum: 1, maximum: 2, description: 'Penalise tokens already present (> 1 discourages loops; default: the model\'s own setting, typically 1.0–1.2)' },
  stop: { type: 'array', items: { type: 'string' }, default: [], description: 'Stop strings: generation ends as soon as one appears in the output, and the text is cut before it (e.g. "\\n\\n", "###", "</answer>")' },
  backend: BACKEND,
  dtype: DTYPE,
  maxChars: { type: 'integer', default: 8000, minimum: 0, maximum: 100000, description: 'Cap on the text returned inline; when the reply is longer the full text is written to a VFS file (result.output)' },
  output: { type: 'string', description: 'Also write the full reply to this VFS path (text file)' },
};
const LLM_NOTE = `Returns the text, finishReason (eos = the model ended its turn, length = maxTokens reached, stop = a stop string matched), promptTokens, tokens generated, tokensPerSecond (after the first token), timeToFirstTokenMs, the backend and quantisation actually used (with fallbackReason when WebGPU was not used), loadMs, downloadedBytes vs fromCache. These are SMALL models (0.1–1.7 B parameters): good for rewriting, summarising a paragraph, classification, extraction to a format, simple Q&A; weak at arithmetic, long reasoning and obscure facts — check what they say. DOWNLOADS on first use of a model, from huggingface.co: ${sizeLine('llm')}; plus the 29 MB runtime from this site. Speed measured on a desktop PC (RTX-class GPU, fast CPU core): on WebGPU about 100 tokens/s for the SmolLM2 models and 40 for qwen2.5-0.5b, plus 0.2–1 s of shader compilation on the first call after a load; on CPU (single-threaded WASM — this host cannot enable threads) 35 / 18 / 13 tokens/s for smollm2-135m / smollm2-360m / qwen2.5-0.5b, several times less on a laptop or phone; smollm2-1.7b is refused on CPU. The CPU builds are 8-bit quantised and make slightly more mistakes than the WebGPU builds. One language model stays loaded at a time, in its own worker next to the speech model's (model.status / model.unload); switching models restarts that worker and loads the other from cache in 1–4 s. ${PRIVACY}`;

function chatMessages(messages, system) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages must be a non-empty array of {role, content}');
  const out = messages.map((m, i) => {
    if (!m || typeof m !== 'object' || typeof m.content !== 'string') throw new Error(`messages[${i}] must be an object {role, content} with a string content`);
    const role = String(m.role || '').toLowerCase();
    if (!['system', 'user', 'assistant'].includes(role)) throw new Error(`messages[${i}].role must be system | user | assistant (got ${JSON.stringify(m.role)})`);
    if (role === 'system' && i > 0) throw new Error(`messages[${i}]: a system message is only allowed first`);
    return { role, content: m.content };
  });
  if (system) { if (out[0].role === 'system') throw new Error('give the system prompt either as the "system" argument or as the first message, not both'); out.unshift({ role: 'system', content: system }); }
  if (out.at(-1).role !== 'user') throw new Error('the last message must have role "user" — the model writes the assistant turn that follows it');
  return out;
}

async function llmRun(args, ctx, payload, tag) {
  resolveModel(args.model, 'llm');
  const r = await engine.request('llm', 'generate', {
    ...payload, model: args.model, backend: args.backend, dtype: args.dtype, maxTokens: args.maxTokens, temperature: args.temperature, topP: args.topP,
    topK: args.topK, seed: args.seed, repetitionPenalty: args.repetitionPenalty, stop: args.stop,
  }, ctx, { wantGpu: args.backend !== 'cpu', plan: { model: args.model, task: 'llm', backend: args.backend, dtype: args.dtype } });
  const truncated = r.text.length > args.maxChars;
  const res = {
    text: r.text.slice(0, args.maxChars), chars: r.text.length, truncated, finishReason: r.finishReason, stopString: r.stopString,
    promptTokens: r.promptTokens, tokens: r.tokens, tokensPerSecond: r.tokensPerSecond, timeToFirstTokenMs: r.timeToFirstTokenMs, generateMs: r.generateMs,
    sampling: r.sampling, backend: r.backend, fallbackReason: r.fallbackReason, model: r.model, repo: r.repo, dtype: r.dtype, contextTokens: r.context,
    loadMs: r.loadMs, downloadedBytes: r.downloadedBytes, fromCache: r.fromCache, downloadedFrom: r.downloadedFrom,
  };
  if (args.output || truncated) res.output = await vfs.write(args.output || vfs.unique(tag, 'txt'), r.text, { mime: 'text/plain' });
  if (r.finishReason === 'length') res.note = `stopped at maxTokens=${args.maxTokens}: the reply may be cut mid-sentence — raise maxTokens for a complete answer`;
  return res;
}

register({
  name: 'llm.generate', gpu: true,
  description: `Run a small instruction-tuned language model in the browser on one prompt and get its text back. Use it for a single self-contained instruction ("summarise this", "extract the dates as JSON", "rewrite politely") when a round trip to a hosted model is unwanted or the text must stay on this machine. By default the prompt is wrapped as a user turn in the model's chat template (with the optional system prompt); raw=true feeds the prompt verbatim for plain text continuation. For a multi-turn conversation use llm.chat. ${LLM_NOTE}`,
  schema: {
    properties: {
      prompt: { type: 'string', description: 'The instruction or question (or, with raw=true, the text to continue)' },
      input: { type: 'string', description: 'VFS path of a text file whose content is appended to the prompt after a blank line (the document to work on). The whole prompt must fit the model\'s context: 8192 tokens for SmolLM2, 32768 for Qwen2.5.' },
      raw: { type: 'boolean', default: false, description: 'true = no chat template: the model continues the prompt text as-is (system is then not allowed)' },
      ...LLM_PROPS,
    },
    required: ['prompt'],
  },
  examples: ['llm.generate prompt="What is the capital of France? Answer in one word."', 'llm.generate prompt="Summarise in two sentences." input=notes.txt model=smollm2-1.7b maxTokens=120', 'llm.generate prompt="Write a haiku about rain" temperature=0.8 seed=7 model=smollm2-360m'],
  async run(args, ctx) {
    let prompt = args.prompt;
    if (args.input) prompt += `\n\n${vfs.text(args.input)}`;
    if (args.raw && args.system) throw new Error('raw=true bypasses the chat template, so a system prompt cannot be applied — drop "system" or use raw=false');
    const payload = args.raw ? { prompt } : { messages: chatMessages([{ role: 'user', content: prompt }], args.system) };
    return llmRun(args, ctx, payload, 'llm.generate');
  },
});

register({
  name: 'llm.chat', gpu: true,
  description: `Chat with a small language model running in the browser: pass the conversation so far as messages [{role, content}, …] (roles: system, user, assistant; the last one must be user) and get the assistant's next reply, formatted through the model's own chat template. The tool is stateless — send the whole history each time, appending the returned reply as an assistant message before the next user turn. The reply is in result.text and as result.message {role:"assistant", content}. ${LLM_NOTE}`,
  schema: {
    properties: {
      messages: { type: 'array', items: { type: 'object' }, description: 'Conversation as an array of {role: "system" | "user" | "assistant", content: string}, oldest first; a system message may only come first; must end with a user message. From the terminal pass JSON: messages=[{"role":"user","content":"hi"}]' },
      ...LLM_PROPS,
    },
    required: ['messages'],
  },
  examples: ['llm.chat messages=[{"role":"user","content":"Name three primary colours."}]', 'llm.chat system="Answer in French." messages=[{"role":"user","content":"Where is the Eiffel Tower?"}] model=qwen2.5-0.5b'],
  async run(args, ctx) {
    const messages = chatMessages(args.messages, args.system);
    const res = await llmRun(args, ctx, { messages }, 'llm.chat');
    return { message: { role: 'assistant', content: res.text }, turns: messages.length, ...res };
  },
});

// ──────────────────────────────────────────────────────────── model ──
register({
  name: 'model.list', readOnly: true,
  description: `The catalogue of neural models this room can run, and what THIS browser can do with each: id (the name speech.transcribe / llm.* accept), task (speech = Whisper speech-to-text, llm = text generation), Hugging Face repo, parameters, licence, languages, download size in MB for the WebGPU and CPU variants, approximate memory needed, whether it is already in this browser's cache, whether it is loaded right now, and whether this machine can run it and on which backend (webgpu or wasm) with which quantisation. Also reports the WebGPU adapter (or why there is none), shader-f16 support and WASM facts. Call it first to choose a model that fits the machine and to know how many MB a first use will download from huggingface.co. Reads only local state (no network, does not load the runtime). Models outside the catalogue can still be used by Hugging Face repo id.`,
  schema: { properties: { task: { type: 'string', enum: ['all', 'speech', 'llm'], default: 'all', description: 'Only speech-to-text models, only language models, or both' } } },
  examples: ['model.list', 'model.list task=llm'],
  async run({ task }) {
    const m = await machine(); const st = await engine.status();
    const models = [];
    for (const e of CATALOG.filter((x) => task === 'all' || x.task === task)) {
      const allowed = m.device === 'webgpu' || e.cpu !== 'no';
      const plan = planFor(e, m.device, m.gpu.shaderF16);
      const cached = await modelCache.has(plan.repo, plan.files);
      const row = {
        id: e.id, task: e.task, repo: e.repo, family: e.family, parameters: e.params, licence: e.licence, languages: e.languages,
        contextTokens: e.context, downloadMB: { webgpu: mb(m.gpu.available && !m.gpu.shaderF16 ? e.bytes.gpuNoF16 : e.bytes.gpu), cpu: mb(e.bytes.cpu) },
        canRun: allowed, runsOn: allowed ? m.device : null, dtype: allowed ? plan.label : null,
        memoryMB: allowed && plan.bytes ? Math.round(memoryEstimate(plan.bytes, m.device) / MB) : null,
        cached, loaded: st.loaded.some((l) => l.model === e.id) || undefined, cpu: e.cpu, note: e.note,
      };
      if (!allowed) row.why = `needs WebGPU: ${m.gpu.available ? 'only a software adapter is present' : m.gpu.reason}; too large for single-threaded WASM`;
      models.push(row);
    }
    return {
      count: models.length, models, defaults: DEFAULTS,
      machine: { backend: m.device, webgpu: gpuSummary(m.gpu), wasm: m.wasm },
      weightsFrom: `${HUB} (downloaded on first use or by model.download; cached in the browser; sizes in decimal MB)`,
      notes: [
        'memoryMB is an estimate of RAM (wasm) or GPU memory (webgpu) while loaded; browsers do not report free GPU memory, so "canRun" on webgpu means "an adapter exists", not "it will fit"',
        'cpu: ok = usable on WASM, slow = allowed but a few tokens/s, no = refused on WASM',
        m.usable ? null : `no usable WebGPU here → everything runs on single-threaded WebAssembly: ${m.gpu.available ? 'the adapter is a software fallback' : m.gpu.reason}`,
      ].filter(Boolean),
    };
  },
});

register({
  name: 'model.download', gpu: true,
  description: `Download a model's files from the Hugging Face Hub into this browser's cache ahead of time, without loading it — so a later speech.transcribe / llm.* call starts from cache (fromCache: true) and works offline. Streams straight to the Cache API (the weights are never held in memory), reports progress, and finishes with a report: files, bytes downloaded vs already cached, seconds, MB/s, the hosts used. Fetches exactly the variant this machine will run (backend=auto: the WebGPU quantisation when a GPU adapter exists, else the CPU one; pass backend=cpu or gpu to pre-fetch the other). Sizes fetched from huggingface.co: ${CATALOG.map((m) => `${m.id} ${Math.round(m.bytes.gpu / MB)}${m.bytes.cpu ? `/${Math.round(m.bytes.cpu / MB)}` : ''}`).join(', ')} MB (WebGPU/CPU variant; one number = WebGPU only). Also asks the browser to make this origin's storage persistent so the cache is not evicted under disk pressure (Firefox shows a permission prompt, and the tool does not wait for the answer; Chromium decides silently). Not required before using a model: the other tools download on demand. Only model files are requested; nothing is uploaded.`,
  schema: {
    properties: {
      model: { type: 'string', description: `Catalogue id (${CATALOG.map((m) => m.id).join(', ')}) or a Hugging Face repo id "org/name" with Transformers.js ONNX files` },
      task: { type: 'string', enum: ['speech', 'llm'], description: 'Needed only for a repo id outside the catalogue: is it a Whisper speech model or a text-generation model (default: guessed from the name)' },
      backend: { ...BACKEND, description: 'Which variant to fetch: auto = the one this machine will use (WebGPU files if a hardware adapter exists, else CPU files); gpu / cpu = that variant explicitly' },
      dtype: DTYPE,
      wordTimestamps: { type: 'boolean', default: false, description: 'Speech models only: fetch the "<model>_timestamped" export that speech.transcribe timestamps=word needs (same size as the normal one, a separate download)' },
    },
    required: ['model'],
  },
  examples: ['model.download model=whisper-base', 'model.download model=qwen2.5-0.5b backend=cpu', 'model.download model=onnx-community/whisper-large-v3-turbo task=speech'],
  async run(args, ctx) {
    const entry = resolveModel(args.model, args.task);
    if (args.wordTimestamps && entry.task !== 'speech') throw new Error('wordTimestamps applies to speech models only');
    const before = await modelCache.storage();
    const m = await machine();
    const plan = planFor(entry, args.backend === 'cpu' || (args.backend === 'auto' && !m.usable) ? 'wasm' : 'webgpu', m.gpu.shaderF16, args.dtype, args.wordTimestamps);
    if (plan.bytes && before.freeBytes != null && before.freeBytes < plan.bytes && (await modelCache.has(plan.repo, plan.files)) !== true) {
      throw new Error(`not enough browser storage for ${entry.id}: needs about ${human(plan.bytes)}, but only ${human(before.freeBytes)} of the ${human(before.quotaBytes)} quota is free (${human(before.usageBytes)} in use) — free space with model.remove (model.cache lists what is stored)`);
    }
    const r = await engine.request(entry.task, 'download', { model: args.model, task: args.task, backend: args.backend, dtype: args.dtype, word: args.wordTimestamps }, ctx, { wantGpu: args.backend !== 'cpu' });
    const persistent = await modelCache.requestPersistence();
    const after = await modelCache.storage();
    ctx.progress(1, 'cached');
    return { ...r, storage: { usageBytes: after.usageBytes, quotaBytes: after.quotaBytes, persistent: persistent ?? after.persistent }, note: persistent === false ? 'the browser did not grant persistent storage: cached models may be evicted if the disk runs low (they would simply be downloaded again)' : persistent === 'pending' ? 'the browser is asking the user whether this site may keep its storage permanently; until that is answered the cache is best-effort (it still survives reloads)' : undefined };
  },
});

register({
  name: 'model.status', readOnly: true,
  description: 'What is loaded in memory right now: each loaded model with its backend (webgpu or wasm), quantisation, weight bytes, estimated memory, load time, number of runs and idle time; which inference workers are running (one dedicated worker per task — speech, llm — started on first use and holding one model each), whether one is busy, the runtime versions, which cross-origin hosts it has contacted in this page (model downloads only), the WebGPU adapter and whether its device was lost. Use it to see why memory is high, to confirm a model.unload, or to check which backend a model ended up on. Does not start anything.',
  schema: { properties: {} },
  async run() {
    const [st, m] = [await engine.status(), await machine()];
    const total = st.loaded.reduce((a, l) => a + (l.estimatedMemoryBytes || 0), 0);
    return {
      engine: st.engine, workers: st.workers, busy: st.busy ?? null, loaded: st.loaded, loadedCount: st.loaded.length, estimatedMemoryBytes: total,
      runtime: st.runtime || null, contactedHosts: st.contactedHosts || [], deviceLost: st.deviceLost || null, lastExit: st.lastExit || undefined,
      machine: { backend: m.device, webgpu: gpuSummary(m.gpu), wasm: m.wasm },
      note: 'memory figures are estimates (weights × overhead): browsers expose neither GPU memory use nor per-worker heap size',
    };
  },
});

register({
  name: 'model.unload',
  description: 'Free a loaded model — its ONNX sessions, WASM heap, GPU buffers and GPU device — without touching the browser cache (loading it again needs no download: 1–4 s from cache). With no argument every loaded model is released. Each task (speech, llm) runs in its own dedicated worker holding one model; unloading terminates that worker, which is the only way to hand all GPU memory and the WASM heap back to the browser, and the next speech/llm call starts a fresh one. Use it after a job, before loading a large model, or when the GPU is needed elsewhere. Returns what was unloaded and what is still loaded.',
  schema: { properties: { model: { type: 'string', description: 'Catalogue id or repo id of the model to unload (default: all loaded models)' } } },
  examples: ['model.unload', 'model.unload model=smollm2-1.7b'],
  async run({ model }, ctx) {
    const st = await engine.status();
    if (st.engine === 'not started') return { unloaded: [], remaining: 0, engine: 'not running', note: 'nothing was loaded' };
    const want = model ? (() => { try { return resolveModel(model).id; } catch { return model; } })() : undefined;
    if (want && !st.loaded.some((l) => l.model === want || l.repo === want)) throw new Error(`"${model}" is not loaded — loaded now: ${st.loaded.map((l) => l.model).join(', ') || '(nothing)'}`);
    const r = await engine.unload(want, ctx);
    return { ...r, estimatedFreedBytes: r.unloaded.reduce((a, u) => a + (u.estimatedMemoryBytes || 0), 0) };
  },
});

register({
  name: 'model.remove',
  description: 'Delete a model from this browser\'s cache to get disk space back: removes every cached file of its Hugging Face repo (all quantisations; for a Whisper model also its word-timestamp export), and unloads it first if it is in memory. The model can be downloaded again later. all=true wipes the whole model cache. Returns the repos removed, files and bytes freed, and the storage numbers afterwards. model.cache shows what is stored.',
  schema: {
    properties: {
      model: { type: 'string', description: 'Catalogue id or Hugging Face repo id to delete from the cache' },
      all: { type: 'boolean', default: false, description: 'Delete every cached model' },
    },
  },
  examples: ['model.remove model=whisper-small', 'model.remove all=true'],
  async run({ model, all }, ctx) {
    if (!all && !model) throw new Error('give model=<id or repo>, or all=true to wipe the model cache');
    if (!modelCache.cacheAvailable()) throw new Error('the Cache API is not available in this browser context: there is no model cache to remove from');
    const cachedRepos = await modelCache.byRepo();
    let repos, ids = [];
    if (all) repos = cachedRepos.map((r) => r.repo);
    else { const e = resolveModel(model); repos = [e.repo, e.wordRepo].filter(Boolean); ids = [e.id]; }
    const st = await engine.status(); const unloaded = [];
    for (const l of st.loaded) {
      if (all || ids.includes(l.model) || repos.includes(l.repo)) { await engine.unload(l.model, ctx); unloaded.push(l.model); }
    }
    const removed = [];
    for (const repo of repos) { const r = await modelCache.removeRepo(repo); if (r.files) removed.push(r); }
    if (!removed.length && !all) throw new Error(`"${model}" is not in the cache — cached repos: ${cachedRepos.map((r) => r.id || r.repo).join(', ') || '(none)'}`);
    const s = await modelCache.storage();
    return { removed, filesRemoved: removed.reduce((a, r) => a + r.files, 0), freedBytes: removed.reduce((a, r) => a + r.bytes, 0), unloaded, storage: s, note: 'the browser may take a moment to return the space: usageBytes can lag behind' };
  },
});

register({
  name: 'model.cache', readOnly: true,
  description: 'What model files this browser has cached and how much room is left: per Hugging Face repo the catalogue id, number of files, bytes and which quantisations are present; the total; and the origin\'s storage usage and quota from navigator.storage.estimate() (usage includes the VFS files as well), plus whether the storage is persistent or may be evicted under disk pressure. The cache is the Cache API bucket "transformers-cache" of this origin: it survives reloads and browser restarts, is private to this site and browser profile, and is cleared by "clear site data". Use it before a large model.download, or to decide what to model.remove.',
  schema: { properties: {} },
  async run() {
    const repos = await modelCache.byRepo(); const s = await modelCache.storage();
    repos.sort((a, b) => b.bytes - a.bytes);
    return {
      cacheApi: modelCache.cacheAvailable(), cacheName: 'transformers-cache',
      models: repos.slice(0, 50).map((r) => ({ repo: r.repo, id: r.id, task: r.task, files: r.files, bytes: r.bytes, quantisations: r.quantisations })), truncated: repos.length > 50,
      count: repos.length, totalBytes: repos.reduce((a, r) => a + r.bytes, 0), total: human(repos.reduce((a, r) => a + r.bytes, 0)),
      storage: { ...s, usage: human(s.usageBytes), quota: human(s.quotaBytes) },
      note: modelCache.cacheAvailable() ? (s.persistent === false ? 'storage is "best effort": the browser may evict it when the disk is nearly full (model.download asks for persistence)' : undefined) : 'the Cache API is unavailable here (private window or insecure origin): models are downloaded again on every page load',
    };
  },
});
