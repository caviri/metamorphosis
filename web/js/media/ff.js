// μεταμόρφωσις :: media/ff — ffmpeg.wasm (single-thread core, CPU) loaded lazily from same-origin vendor files.
// The class worker (vendor/ffmpeg/ffmpeg/worker.js) is a same-origin module worker; it imports the ESM core by absolute
// same-origin URL, so nothing touches a CDN and no COOP/COEP (SharedArrayBuffer) is needed.
import { vfs } from '../core.js';

const V = (p) => new URL(`../../vendor/ffmpeg/${p}`, import.meta.url).href;
export const FF_URLS = { classes: V('ffmpeg/index.js'), core: V('core/ffmpeg-core.js'), wasm: V('core/ffmpeg-core.wasm') };
export const FF_MAX_INPUT = 1024 * 1024 * 1024;   // inputs are mounted as Blobs (not copied into the wasm heap)
// ffmpeg.wasm leaves main() through an exception, so whatever a run had allocated is never freed and the heap never
// shrinks. A worker is therefore only good for a handful of runs: recycle it by count and after big jobs.
const RECYCLE_BYTES = 96 * 1024 * 1024;
const RECYCLE_RUNS_JOB = 6;        // a new job gets a fresh worker once this many runs have happened in the current one
const RECYCLE_RUNS_INNER = 12;     // inside a stateless job (frame grabbing) the worker is swapped after this many runs
const LOAD_TIMEOUT = 120000;

let inst = null, loading = null, chain = Promise.resolve(), jobSeq = 0, runsSinceLoad = 0;
const msgOf = (e) => (typeof e === 'string' ? e : e?.message || String(e));

export const ffLoaded = () => !!inst;
export function ffTerminate() { try { inst?.terminate(); } catch { /* already gone */ } inst = null; loading = null; runsSinceLoad = 0; }

export async function ffLoad(ctx) {
  if (inst) return inst;
  loading ||= (async () => {
    ctx?.log?.('loading ffmpeg.wasm core (~31 MB, CPU, single thread)…');
    const { FFmpeg } = await import(FF_URLS.classes);
    const f = new FFmpeg();
    let timer;
    try {
      await Promise.race([
        f.load({ coreURL: FF_URLS.core, wasmURL: FF_URLS.wasm }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer from the ffmpeg worker after ${LOAD_TIMEOUT / 1000}s`)), LOAD_TIMEOUT); }),
      ]);
    } catch (e) { try { f.terminate(); } catch { /* */ } throw e; } finally { clearTimeout(timer); }
    inst = f; runsSinceLoad = 0; return f;
  })().catch((e) => { loading = null; throw new Error(`ffmpeg.wasm fallback could not be loaded (${msgOf(e)})`); });
  return loading;
}

const FATAL = /abort|out of memory|memory access out of bounds|unreachable|RuntimeError|Cannot enlarge memory|OOM|table index is out of bounds|null function|startsWith/i;
const NOISE = /^(frame=|size=|video:|\s*$|Conversion failed!$|\[.*\] (Qavg|frame|kb\/s|mb|ref|coded|i\d|consecutive|Weighted|final ratefactor))|Aborted\(\)|^Exiting normally|^pthread|^Input #|^Output #|^Stream mapping|^Press \[q\]|^ {2,}|^ffmpeg version|^  built with|^  configuration|^  lib/;
const hms = (s) => { const m = /(-?\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(s); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null; };

/**
 * ffJob(ctx, async (job) => …, {retry = true}) — run one serialized ffmpeg session. Inside:
 *   job.input(vfsPath) → path usable in args (zero-copy WORKERFS mount of the VFS blob)
 *   job.tmp(name)      → scratch file name in the wasm FS, deleted afterwards
 *   job.write(name, bytes|string) · job.writeOwned(name, bytes) (transfers the buffer) · job.read(name) → Uint8Array · job.exists(name)
 *   job.exec(args, {duration?, span?, timeout?, stall?, allowFail?}) → {code, log[]}   (throws on non-zero unless allowFail)
 *   job.probe(args) → {code, log[]}   (ffprobe)
 *   job.stateless = true  declares that runs do not depend on scratch files of earlier runs, which lets the worker be swapped mid-job
 * With retry (default) a job that crashes or runs out of memory on a used worker is repeated once on a fresh one,
 * so `fn` must be safe to run twice.
 */
export function ffJob(ctx, fn, opts = {}) {
  const run = chain.then(async () => {
    if (inst && runsSinceLoad >= RECYCLE_RUNS_JOB) ffTerminate();
    const dirty = !!inst && runsSinceLoad > 0;
    try { return await runJob(ctx, fn); } catch (e) {
      if (!e?.ffCrash || !dirty || opts.retry === false) throw e;
      ctx?.log?.('ffmpeg crashed on a used worker; retrying once on a fresh one');
      ffTerminate();
      return runJob(ctx, fn);
    }
  });
  chain = run.catch(() => {});
  return run;
}

async function runJob(ctx, fn) {
  let f = await ffLoad(ctx);
  const id = ++jobSeq, dir = `/in${id}`;
  const blobs = []; const scratch = new Set(); let mountedCount = -1, dirMade = false, bytesIn = 0, bytesOut = 0, dead = false;
  let log = [], onLine = null, onProg = null, lastLog = performance.now();
  const logCb = ({ message }) => { lastLog = performance.now(); log.push(message); if (log.length > 600) log = log.slice(-300); onLine?.(message); };
  const progCb = (d) => { lastLog = performance.now(); onProg?.(d); };
  const attach = () => { f.on('log', logCb); f.on('progress', progCb); };
  const detach = () => { try { f.off('log', logCb); f.off('progress', progCb); } catch { /* */ } };
  attach();
  const fail = (e, what) => {
    const m = msgOf(e); let err;
    if (FATAL.test(m) || /terminated/i.test(m)) {
      dead = true;
      err = /Cannot enlarge memory|out of memory|OOM|allocation/i.test(m)
        ? new Error(`ffmpeg ${what} ran out of memory (${m.slice(0, 120)}): the job needs more than the single-thread WebAssembly heap allows (2 GB hard limit; in practice inputs up to a few hundred MB). Trim or downscale first, or use backend=webcodecs.`)
        : new Error(`ffmpeg ${what} crashed inside WebAssembly (${m.slice(0, 120)}). Either this encoder/filter is broken in the ffmpeg.wasm build (known: libvpx-vp9 and libx265 encoding, libopus above -compression_level 1) or the job ran out of memory. Try another codec, a smaller job, or backend=webcodecs.`);
      err.ffCrash = true;
    } else err = new Error(`ffmpeg ${what} failed: ${m}`);
    return err;
  };
  const mount = async () => {
    if (mountedCount === blobs.length) return;
    if (!dirMade) { await f.createDir(dir); dirMade = true; }
    if (mountedCount >= 0) await f.unmount(dir);
    await f.mount('WORKERFS', { blobs: blobs.map((b) => ({ name: b.name, data: b.data })) }, dir);
    mountedCount = blobs.length;
  };
  const swap = async () => { detach(); ffTerminate(); f = await ffLoad(ctx); attach(); mountedCount = -1; dirMade = false; scratch.clear(); dead = false; };
  const once = async (kind, args, { duration, span, timeout, stall, note }) => {
    await mount();
    log = [];
    let last = 0;
    const report = (t) => { const now = performance.now(); if (t === null || !(duration > 0) || now - last < 250) return; last = now; ctx?.progress?.(span[0] + (span[1] - span[0]) * Math.max(0, Math.min(1, t / duration)), note); };
    onLine = (line) => { if (line.includes('time=')) report(hms(line.slice(line.indexOf('time=')))); };
    onProg = ({ time }) => { if (typeof time === 'number' && time > 0) report(time / 1e6); };
    // ffmpeg.wasm's own timeout is only checked between frames, so a stuck encoder would hang forever: watch it from outside
    let code, dog; const t0 = lastLog = performance.now();
    const watchdog = new Promise((_, rej) => { dog = setInterval(() => {
      const now = performance.now();
      if (now - t0 > timeout) rej(new Error(`timeout: no result after ${Math.round(timeout / 1000)} s`));
      else if (now - lastLog > stall) rej(new Error(`stalled: ffmpeg produced no output for ${Math.round(stall / 1000)} s (this encoder/filter does not work in the WebAssembly build, or the job is far too heavy for one CPU thread)`));
    }, 1000); });
    runsSinceLoad++;
    try { code = await Promise.race([f[kind](args, timeout), watchdog]); } catch (e) {
      if (/^(timeout|stalled):/.test(msgOf(e))) { dead = true; throw new Error(`ffmpeg ${kind} ${msgOf(e)} — the worker was stopped`); }
      throw fail(e, kind);
    } finally { clearInterval(dog); onLine = null; onProg = null; }
    const lines = log.slice();
    const crash = code !== 0 && lines.find((l) => /Cannot enlarge memory|out of memory|OOM|memory access out of bounds|Aborted\([^)]/i.test(l));   // a bare "Aborted()" ends every normal run
    if (crash) throw fail(`RuntimeError: ${crash}`, kind);
    return { code, log: lines };
  };
  const job = {
    stateless: false,
    input(path) {
      const st = vfs.stat(path);
      bytesIn += st.bytes;
      if (bytesIn > FF_MAX_INPUT) throw new Error(`"${path}" is too large for the ffmpeg backend (${Math.round(bytesIn / 1048576)} MB of input; limit ${FF_MAX_INPUT / 1048576} MB). Use backend=webcodecs or trim first.`);
      const name = `${blobs.length}.${vfs.extOf(path) || 'bin'}`;
      blobs.push({ name, data: vfs.blob(path) });
      return `${dir}/${name}`;
    },
    tmp(name) { const n = `j${id}_${name}`; scratch.add(n); return n; },
    async write(name, data) { scratch.add(name); await f.writeFile(name, typeof data === 'string' ? new TextEncoder().encode(data) : data.slice()); },
    async writeOwned(name, data) { scratch.add(name); await f.writeFile(name, data); },
    async read(name) { try { const b = await f.readFile(name); bytesOut += b.byteLength; return b; } catch (e) { throw fail(e, `read of ${name}`); } },
    async exists(name) { const i = name.lastIndexOf('/'); const list = await f.listDir(i > 0 ? name.slice(0, i) : '/'); return list.some((x) => x.name === name.slice(i + 1)); },
    exec: (args, opts = {}) => job.run('exec', args, opts),
    probe: (args, opts = {}) => job.run('ffprobe', args, opts),
    async run(kind, args, { duration, span = [0, 1], timeout = 30 * 60000, stall = 150000, allowFail = false, note = 'ffmpeg' } = {}) {
      const o = { duration, span, timeout, stall, note };
      if (job.stateless && runsSinceLoad >= RECYCLE_RUNS_INNER) await swap();
      let r;
      try { r = await once(kind, args, o); } catch (e) {
        if (!e.ffCrash || !job.stateless || runsSinceLoad <= 1) throw e;
        await swap(); r = await once(kind, args, o);            // the heap was probably exhausted by earlier runs: once more on a fresh worker
      }
      if (r.code !== 0 && !allowFail) {
        const why = r.log.filter((l) => !NOISE.test(l)).slice(-6).join(' | ').slice(0, 700);
        throw new Error(r.code === 1 && !why ? `ffmpeg timed out or failed without a message (args: ${args.join(' ').slice(0, 200)})` : `ffmpeg exited with code ${r.code}: ${why || '(no message)'}`);
      }
      return r;
    },
  };
  try {
    return await fn(job);
  } finally {
    detach();
    if (dead || bytesIn + bytesOut > RECYCLE_BYTES) ffTerminate();
    else {
      for (const n of scratch) { try { await f.deleteFile(n); } catch { /* never written */ } }
      try { if (mountedCount >= 0) await f.unmount(dir); if (dirMade) await f.deleteDir(dir); } catch { /* */ }
    }
  }
}
