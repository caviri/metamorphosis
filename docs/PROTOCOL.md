# πρωτόκολλον — how a tool is made

The site is `web/`: plain ES modules, no bundler, no server. Everything must work from a static host under a
sub-path (`https://<user>.github.io/metamorphosis/`), so **never use absolute URLs or CDNs at runtime** — resolve
assets with `new URL('../vendor/x/y.js', import.meta.url)`.

## Shape

```js
// web/tools/<family>.js   (loaded at boot by web/js/main.js; one file per family, see MODULES there)
import { M, vfs, register, accel } from '../js/core.js';
import { decode, save, encode, toCanvas, saveCanvas, blank, luma } from '../js/img.js';

register({
  name: 'image.blur',                 // domain.verb — lowercase domain, camelCase verb allowed
  description: 'Gaussian blur. …',    // written for an agent choosing a tool: what it does, when to use it, what comes back
  gpu: true,                          // true if the tool has a WebGPU path (still must work without one)
  readOnly: false,                    // true if it writes nothing to the VFS (pure analysis)
  schema: {                           // JSON Schema for the args object; every property needs a description
    properties: {
      input:   { type: 'string', description: 'VFS path of the source image' },
      sigma:   { type: 'number', default: 2, minimum: 0.1, maximum: 100, description: 'Blur radius in pixels' },
      backend: { type: 'string', enum: ['auto', 'gpu', 'cpu'], default: 'auto', description: 'auto = WebGPU when available, else WASM' },
      output:  { type: 'string', description: 'VFS path to write (default: derived from input)' },
    },
    required: ['input'],
  },
  examples: ['image.blur input=cat.png sigma=4'],
  async run(args, ctx) {              // args already validated: defaults applied, types coerced, enums checked
    const img = await decode(args.input);
    const out = await save(result, vfs.out(args.output, args.input, 'blur', 'png'));
    return { output: out, backend: 'wasm', sigma: args.sigma };
  },
});
```

## Rules

1. **Files move through the VFS only.** Inputs are VFS paths (`input`, or `inputs` for a list); outputs are written
   with `vfs.write` / `save` and reported as `output: <stat>` (one file) or `outputs: [<stat>…]` (many).
   A stat is `{path, mime, bytes, ...meta}`; put `width`/`height`/`pages`/`duration` in `meta` when known.
   Name outputs with `vfs.out(args.output, args.input, '<tag>', '<ext>')`.
2. **Results are small JSON.** Numbers, short strings, short arrays. Never return pixel arrays, base64 blobs or
   megabytes of text — write a file and return its stat. Analysis tools return the measurements themselves.
   Cap any returned list (e.g. top 50) and say so (`truncated: true`).
3. **Errors are thrown `Error`s with a message an agent can act on** (what was wrong, what is accepted).
   `M.call` turns them into `{ok:false, error}`.
4. **Load heavy code lazily.** A tool file must import in milliseconds: no top-level import of vendored libraries
   or WASM. Do `const lib = await import(new URL('../vendor/…', import.meta.url))` (or `M.loadScript(url)` for
   UMD/IIFE globals) inside `run`, cached in a module-level promise.
5. **Vendor everything** into `web/vendor/<lib>/` (only the files needed at runtime, plus the lib's LICENSE), and
   append a row to `web/vendor/README.md` (`| lib | version | license | files | used by |`) — append only your own
   rows; other agents edit that file too. No CDN links at runtime.
6. **GPU is optional.** A tool with `gpu:true` takes `backend: auto|gpu|cpu` and reports the backend it actually
   used (`'webgpu' | 'wasm' | 'js'`). `await accel(op, img, params, backend)` returns `{img, backend:'webgpu'}`
   or `null` (then run the CPU path). GPU kernels are registered with `M.gpu.register(op, fn)`.
7. **Call other tools** with `await M.run('pdf.render', {...})` (returns the raw result, throws on error).
8. **Previews**: `M.registerPreviewer((stat) => bool, async (stat, el) => { … })` paints a file type into the
   viewport element. Images, video, audio, text and hex are built in.
9. **Progress/logs**: `ctx.log('…')`, `ctx.progress(0..1, 'note')`.

## Core API (web/js/core.js)

- `vfs.write(path, bytes|Blob|string, {mime?, meta?}) → stat` · `vfs.read(path) → Uint8Array` (do not mutate) ·
  `vfs.text` · `vfs.json` · `vfs.blob` · `vfs.url` (object URL) · `vfs.stat` · `vfs.exists` · `vfs.list(prefix)` ·
  `vfs.rm` · `vfs.mv` · `vfs.unique(base, ext)` · `vfs.out(explicit, input, tag, ext)` · `vfs.extOf/stemOf/mimeOf/extForMime/isTextMime`
- `M.call(name, args) → {ok, tool, ms, result|error}` (agent entry, never throws) · `M.run(name, args)` (raw, throws)
- `M.gpu.device() → GPUDevice|null` · `M.gpu.register(op, fn)` · `M.accel(op, img, params, backend)`
- `M.loadScript(url)` · `M.b64.enc/dec` · `M.human(bytes)`

## Image helper (web/js/img.js)

An **img** is `{width, height, data: Uint8ClampedArray}` — RGBA, 8-bit, row-major.
`decode(pathOrBytes, {maxSide?}) → img` · `encode(img, {format, quality}) → {bytes, mime}` ·
`save(img, path, {format?, quality?, meta?}) → stat` · `toCanvas(img)` · `saveCanvas(canvas, path) → stat` ·
`canvasOf(w, h)` · `blank(w, h, rgba)` · `luma(img) → Float32Array`

## Test it for real

```sh
npm install                      # once: puppeteer-core (drives the installed Chrome, headless)
node scripts/mu.mjs call image.blur --args-file a.json --put ./cat.png --get cat.blur.png:./out/cat.blur.png
node scripts/mu.mjs script ./probe.js     # body runs in the page as: async (M) => { … return value }
node scripts/mu.mjs call sys.env          # add --cpu to disable WebGPU and prove the fallback
```

`--put local[:vfsname]` uploads a file into the VFS before the call, `--get vfsname[:local]` pulls one out after.
Page console errors are echoed to stderr. Keep scratch files in `.scratch/` (git-ignored).
