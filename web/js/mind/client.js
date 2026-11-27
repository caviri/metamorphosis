// mind :: page-side handle on the inference engines. One dedicated module worker per task ("speech", "llm"), each holding at
// most one model, started on first use (never at import). Why workers, and why one per task:
//   · inference blocks for seconds to minutes (fully, on the single-threaded WASM backend) — the page must stay responsive;
//   · a WebAssembly heap never shrinks and fragments: loading a second large model into a used runtime fails with
//     std::bad_alloc. So a model switch or an unload TERMINATES the worker — the only way to really return the WASM heap,
//     the GPU buffers and the GPUDevice to the browser — and the next model starts in a fresh one;
//   · a broken runtime (GPU device lost, out of memory) is torn down the same way, so the page can never hang on it.
// When workers cannot be used (no module workers, or WebGPU exposed only on the window) the same engine module runs on the
// page's main thread instead, shared by both tasks.
import { probeGpu } from './caps.js';

const engines = new Map();   // slot → { slot, mode: 'worker'|'page', worker?, send(msg, transfer), pending: Map }
const starting = new Map();  // slot → promise
let pageEngine = null;       // the single in-page engine, once we had to fall back to it
let queue = Promise.resolve();
let seq = 0;
let lastExit = null;         // why the previous engine went away
const hosts = new Set();     // cross-origin hosts contacted by any engine of this page (survives worker restarts)

function spawn() {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') { reject(new Error('Worker is not defined')); return; }
    let w;
    try { w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'mu-mind' }); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { w.terminate(); reject(new Error('the worker did not start within 20 s')); }, 20000);
    w.onmessage = (e) => { if (e.data?.type === 'ready') { clearTimeout(timer); resolve(w); } };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(new Error(e?.message || 'module worker failed to load (no module-worker support?)')); };
  });
}

function kill(e, reason, quiet = false) {
  if (!e || e.dead) return;
  e.dead = true;
  for (const [slot, x] of engines) if (x === e) engines.delete(slot);
  if (pageEngine === e) pageEngine = null;
  if (!quiet) lastExit = reason;
  for (const p of e.pending.values()) p.reject(new Error(reason));
  e.pending.clear();
  try { e.worker?.terminate(); } catch { /* already gone */ }
}

function onMessage(e, msg) {
  if (e.dead) return;
  if (msg.type === 'fatal') { kill(e, msg.error); return; }
  const p = e.pending.get(msg.id); if (!p) return;
  if (msg.type === 'log') p.ctx?.log(msg.msg);
  else if (msg.type === 'warn') p.ctx?.warn(msg.msg);
  else if (msg.type === 'progress') p.ctx?.progress(msg.fraction, msg.note);
  else if (msg.type === 'result') { e.pending.delete(msg.id); for (const h of msg.result?.downloadedFrom || msg.result?.contactedHosts || []) hosts.add(h); p.resolve(msg.result); }
  else if (msg.type === 'error') {
    e.pending.delete(msg.id); p.reject(new Error(msg.error));
    if (msg.fatal) kill(e, msg.error);
  }
}

function raw(e, op, args, ctx, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    e.pending.set(id, { resolve, reject, ctx });
    try { e.send({ id, op, args }, transfer || []); } catch (err) { e.pending.delete(id); reject(err); }
  });
}

async function inPage() {
  if (pageEngine) return pageEngine;
  const E = await import('./engine.js');
  const e = { slot: 'page', mode: 'page', pending: new Map() };
  E.setHost({ fatal: (error) => kill(e, error) });
  e.send = (msg) => { E.handle(msg, (m) => onMessage(e, m)); };
  return (pageEngine = e);
}

function start(slot, ctx, wantGpu) {
  if (pageEngine) return Promise.resolve(pageEngine);
  if (engines.has(slot)) return Promise.resolve(engines.get(slot));
  if (!starting.has(slot)) {
    starting.set(slot, (async () => {
      let e;
      try {
        const worker = await spawn();
        e = { slot, mode: 'worker', worker, pending: new Map(), send: (msg, transfer) => worker.postMessage(msg, transfer) };
        worker.onmessage = (ev) => onMessage(e, ev.data);
        worker.onerror = (ev) => kill(e, `the ${slot} inference worker crashed: ${ev?.message || 'unknown error'} — its model was unloaded; the next call starts a new worker`);
        if (wantGpu) {
          // WebGPU inside workers arrived later than on the window in some browsers: if only the window has it, run there.
          const [here, there] = await Promise.all([probeGpu(), raw(e, 'probe', {}, null)]);
          if (here.available && !here.fallbackAdapter && !there.gpu.available) {
            ctx?.warn(`this browser exposes WebGPU to the page but not to workers (${there.gpu.reason}) — running inference on the page's main thread instead: the page will stutter while a model runs`);
            kill(e, 'switching to the in-page engine', true);
            return inPage();
          }
        }
        engines.set(slot, e);
        ctx?.log(`${slot} inference worker started (dedicated module worker: the page stays responsive)`);
      } catch (err) {
        ctx?.warn(`cannot run inference in a worker (${err?.message || err}) — running on the page's main thread: the page will freeze while a model runs`);
        e = await inPage();
      }
      return e;
    })().finally(() => starting.delete(slot)));
  }
  return starting.get(slot);
}

/**
 * Run one engine operation in the worker of `slot` ('speech' | 'llm'). Heavy operations are queued one after another.
 * opts.plan = { model, task, backend, dtype, word }: the model this call needs — if the worker holds a different one,
 * the worker is replaced first (see the note at the top of this file).
 */
export function request(slot, op, args, ctx, { transfer, wantGpu = true, plan } = {}) {
  const run = async () => {
    let e = await start(slot, ctx, wantGpu);
    if (plan && e.mode === 'worker') {
      const p = await raw(e, 'plan', plan, null);
      if (p.others?.length) {
        ctx?.log(`replacing the ${slot} worker to release ${p.others.join(', ')} completely (WASM heap + GPU memory) before loading another model`);
        kill(e, 'model switch', true);
        e = await start(slot, ctx, wantGpu);
      }
    }
    return raw(e, op, args, ctx, transfer);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

const live = () => [...new Set([...engines.values(), ...(pageEngine ? [pageEngine] : [])])];

/** State of every engine, without starting any. */
export async function status() {
  const out = { engine: 'not started', workers: [], loaded: [], busy: null, runtime: null, deviceLost: null, contactedHosts: [...hosts], lastExit };
  for (const e of live()) {
    let s; try { s = await raw(e, 'status', {}, null); } catch { continue; }
    out.engine = e.mode === 'worker' ? 'worker' : 'page (main thread)';
    if (e.mode === 'worker') out.workers.push(e.slot);
    for (const l of s.loaded) out.loaded.push({ ...l, engine: e.mode === 'worker' ? `${e.slot} worker` : 'page' });
    out.busy ||= s.busy; out.runtime ||= s.runtime; out.deviceLost ||= s.deviceLost;
    for (const h of s.contactedHosts || []) hosts.add(h);
  }
  out.contactedHosts = [...hosts];
  return out;
}

/**
 * Unload one model (catalogue id or repo) or, without argument, everything. A worker is terminated outright; the in-page
 * engine can only dispose its sessions. → { unloaded: [...], remaining, engine }
 */
export async function unload(want, ctx) {
  const low = want ? String(want).toLowerCase() : null;
  const unloaded = []; let remaining = 0; const how = new Set();
  for (const e of live()) {
    let s; try { s = await raw(e, 'status', {}, null); } catch { continue; }
    if (s.busy) throw new Error(`the ${e.slot} engine is busy (${s.busy}); wait for that call to finish before unloading`);
    const mine = s.loaded.filter((l) => !low || l.model.toLowerCase() === low || l.repo.toLowerCase() === low);
    if (e.mode === 'worker') {
      if (mine.length || (!low && !s.loaded.length)) { unloaded.push(...mine); kill(e, 'unloaded on request', true); how.add('worker terminated'); } else remaining += s.loaded.length;
    } else if (mine.length) {
      const r = await raw(e, 'unload', { model: want }, ctx); unloaded.push(...mine); remaining += r.remaining;
      how.add('sessions disposed (the in-page runtime itself cannot be unloaded)');
    } else remaining += s.loaded.length;
  }
  return { unloaded: unloaded.map((u) => ({ model: u.model, backend: u.backend, dtype: u.dtype, estimatedMemoryBytes: u.estimatedMemoryBytes })), remaining, engine: [...how].join('; ') || 'nothing was running' };
}

export const running = () => live().length > 0;

/** Test hook: send an engine op outside the queue (used to simulate a lost GPU device while a job runs). */
export function debug(op, args = {}, slot = 'speech') { const e = engines.get(slot) || pageEngine; if (!e) throw new Error('engine not running'); return raw(e, op, args, null); }
