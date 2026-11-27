// μεταμόρφωσις :: media/ff — ffmpeg.wasm (single-thread core, CPU) loaded lazily from same-origin vendor files.
// The class worker (vendor/ffmpeg/ffmpeg/worker.js) is a same-origin module worker; it imports the ESM core by absolute
// same-origin URL, so nothing touches a CDN and no COOP/COEP (SharedArrayBuffer) is needed.
import { vfs } from '../core.js';

const V = (p) => new URL(`../../vendor/ffmpeg/${p}`, import.meta.url).href;
export const FF_URLS = { classes: V('ffmpeg/index.js'), core: V('core/ffmpeg-core.js'), wasm: V('core/ffmpeg-core.wasm') };
export const FF_MAX_INPUT = 1024 * 1024 * 1024;   // inputs are mounted as Blobs (not copied into the wasm heap) …
const FF_RECYCLE_BYTES = 96 * 1024 * 1024;        // … but the heap never shrinks: recycle the worker after big jobs
const LOAD_TIMEOUT = 120000;

let inst = null, loading = null, chain = Promise.resolve(), jobSeq = 0;
const msgOf = (e) => (typeof e === 'string' ? e : e?.message || String(e));

export const ffLoaded = () => !!inst;
export function ffTerminate() { try { inst?.terminate(); } catch { /* already gone */ } inst = null; loading = null; }

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
    inst = f; return f;
  })().catch((e) => { loading = null; throw new Error(`ffmpeg.wasm fallback could not be loaded (${msgOf(e)})`); });
  return loading;
}

const FATAL = /abort|out of memory|memory access out of bounds|unreachable|RuntimeError|Cannot enlarge memory|OOM|table index is out of bounds/i;
const NOISE = /^(frame=|size=|video:|\s*$|Conversion failed!$|\[.*\] (Qavg|frame|kb\/s|mb|ref|coded|i\d|consecutive|Weighted|final ratefactor))|Aborted\(\)|^Exiting normally|^pthread|^Input #|^Output #|^Stream mapping|^Press \[q\]|^ {2,}|^ffmpeg version|^  built with|^  configuration|^  lib/;
const hms = (s) => { const m = /(-?\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(s); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null; };

/**
 * ffJob(ctx, async (job) => …) — run one serialized ffmpeg session. Inside:
 *   job.input(vfsPath) → path usable in args (zero-copy WORKERFS mount of the VFS blob)
 *   job.tmp(name)      → scratch file name in the wasm FS, deleted afterwards
 *   job.write(name, bytes|string) · job.read(name) → Uint8Array · job.exists(name) · job.ls(prefix)
 *   job.exec(args, {duration?, span?, timeout?, allowFail?}) → {code, log[]}   (throws on non-zero unless allowFail)
 *   job.probe(args) → {code, log[]}   (ffprobe)
 */
export function ffJob(ctx, fn) {
  const run = chain.then(() => runJob(ctx, fn));
  chain = run.catch(() => {});
  return run;
}

async function runJob(ctx, fn) {
  const f = await ffLoad(ctx);
  const id = ++jobSeq, dir = `/in${id}`;
  const blobs = []; const scratch = new Set(); let mountedCount = -1, dirMade = false, bytesIn = 0, bytesOut = 0, dead = false;
  let log = []; let onLine = null;
  let lastLog = performance.now();
  const logCb = ({ message }) => { lastLog = performance.now(); log.push(message); if (log.length > 600) log = log.slice(-300); onLine?.(message); };
  f.on('log', logCb);
  const fail = (e, what) => {
    const m = msgOf(e);
    if (FATAL.test(m) || /terminated/i.test(m)) {
      dead = true;
      if (/Cannot enlarge memory|out of memory|OOM|allocation/i.test(m)) return new Error(`ffmpeg ${what} ran out of memory (${m.slice(0, 120)}): the job needs more than the single-thread WebAssembly heap allows (2 GB hard limit; in practice inputs up to a few hundred MB). Trim or downscale first, or use backend=webcodecs.`);
      return new Error(`ffmpeg ${what} crashed inside WebAssembly (${m.slice(0, 120)}). Either this encoder/filter is broken in the ffmpeg.wasm build (known: libvpx-vp9 and libx265 encoding, libopus above -compression_level 1) or the job ran out of memory. Try another codec, a smaller job, or backend=webcodecs.`);
    }
    return new Error(`ffmpeg ${what} failed: ${m}`);
  };
  const mount = async () => {
    if (mountedCount === blobs.length) return;
    if (!dirMade) { await f.createDir(dir); dirMade = true; }
    if (mountedCount >= 0) await f.unmount(dir);
    await f.mount('WORKERFS', { blobs: blobs.map((b) => ({ name: b.name, data: b.data })) }, dir);
    mountedCount = blobs.length;
  };
  const job = {
    input(path) {
      const st = vfs.stat(path);
      bytesIn += st.bytes;
      if (bytesIn > FF_MAX_INPUT) throw new Error(`"${path}" is too large for the ffmpeg backend (${Math.round(bytesIn / 1048576)} MB of input; limit ${FF_MAX_INPUT / 1048576} MB). Use backend=webcodecs or trim first.`);
      const name = `${blobs.length}.${vfs.extOf(path) || 'bin'}`;
      blobs.push({ name, data: vfs.blob(path) });
      return `${dir}/${name}`;
    },
    tmp(name) { const n = `j${id}_${name}`; scratch.add(n); return n; },
    async write(name, data) { scratch.add(name); const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice(); await f.writeFile(name, bytes); },
    async read(name) { try { const b = await f.readFile(name); bytesOut += b.byteLength; return b; } catch (e) { throw fail(e, `read of ${name}`); } },
    async exists(name) { const i = name.lastIndexOf('/'); const list = await f.listDir(i > 0 ? name.slice(0, i) : '/'); return list.some((x) => x.name === name.slice(i + 1)); },
    async ls(prefix) { return (await f.listDir('/')).filter((x) => !x.isDir && x.name.startsWith(prefix)).map((x) => x.name).sort(); },
    async exec(args, opts = {}) { return job.run('exec', args, opts); },
    async probe(args, opts = {}) { return job.run('ffprobe', args, opts); },
    async run(kind, args, { duration, span = [0, 1], timeout = 30 * 60000, stall = 150000, allowFail = false, note = 'ffmpeg' } = {}) {
      await mount();
      log = [];
      let last = 0;
      onLine = duration > 0 ? (line) => {
        if (!line.includes('time=')) return;
        const t = hms(line.slice(line.indexOf('time='))); const now = performance.now();
        if (t === null || now - last < 250) return;
        last = now; ctx?.progress?.(span[0] + (span[1] - span[0]) * Math.max(0, Math.min(1, t / duration)), note);
      } : null;
      // ffmpeg.wasm's own timeout is only checked between frames, so a stuck encoder would hang forever: watch it from outside
      let code, dog; const t0 = lastLog = performance.now();
      const watchdog = new Promise((_, rej) => { dog = setInterval(() => {
        const now = performance.now();
        if (now - t0 > timeout) rej(new Error(`timeout: no result after ${Math.round(timeout / 1000)} s`));
        else if (now - lastLog > stall) rej(new Error(`stalled: ffmpeg produced no output for ${Math.round(stall / 1000)} s (this encoder/filter does not work in the WebAssembly build, or the job is far too heavy for one CPU thread)`));
      }, 1000); });
      try { code = await Promise.race([f[kind](args, timeout), watchdog]); } catch (e) {
        if (/^(timeout|stalled):/.test(msgOf(e))) { dead = true; throw new Error(`ffmpeg ${kind} ${msgOf(e)} — the worker was stopped`); }
        throw fail(e, kind);
      } finally { clearInterval(dog); onLine = null; }
      const lines = log.slice();
      const crash = code !== 0 && lines.find((l) => /Cannot enlarge memory|out of memory|OOM|memory access out of bounds|Aborted\([^)]/i.test(l));   // a bare "Aborted()" ends every normal run
      if (crash) throw fail(`RuntimeError: ${crash}`, kind);
      if (code !== 0 && !allowFail) {
        const why = lines.filter((l) => !NOISE.test(l)).slice(-6).join(' | ').slice(0, 700);
        throw new Error(code === 1 && !why ? `ffmpeg timed out or failed without a message (args: ${args.join(' ').slice(0, 200)})` : `ffmpeg exited with code ${code}: ${why || '(no message)'}`);
      }
      return { code, log: lines };
    },
  };
  try {
    return await fn(job, f);
  } finally {
    f.off('log', logCb);
    if (dead || bytesIn + bytesOut > FF_RECYCLE_BYTES) ffTerminate();
    else {
      for (const n of scratch) { try { await f.deleteFile(n); } catch { /* never written */ } }
      try { if (mountedCount >= 0) await f.unmount(dir); if (dirMade) await f.deleteDir(dir); } catch { /* */ }
    }
  }
}
