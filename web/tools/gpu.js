// gpu.* — the WebGPU compute layer: accelerated image kernels (registered with M.gpu.register so every image tool can
// use them through accel()), plus tools to inspect the adapter, drive a kernel directly, run custom WGSL and benchmark.
// Importing this file creates no GPU objects; devices, shader modules and pipelines are made on first use and cached
// per GPUDevice (see ../js/gpu/rt.js), so a lost device costs nothing but a recompile.
import { M, vfs, register } from '../js/core.js';
import { decode, save } from '../js/img.js';
import { OPS, OP_NAMES, normParams, gaussWeights, bayerMatrix } from '../js/gpu/ops.js';
import * as rt from '../js/gpu/rt.js';

// ───────────────────────────────────────────────────────── kernels ──
// Every kernel is one or two fullscreen fragment passes reading the source with textureLoad (exact texels, manual
// clamp-to-edge) and writing rgba8unorm (never -srgb). U is 32 floats of parameters, K an optional float table.
const HEAD = (withK) => /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> U: array<vec4f, 8>;
${withK ? '@group(0) @binding(2) var<storage, read> K: array<f32>;' : ''}
fn ld(p: vec2i) -> vec4f { return textureLoad(src, clamp(p, vec2i(0), vec2i(textureDimensions(src)) - 1), 0); }
fn b255(v: vec4f) -> vec4f { return floor(v * 255.0 + 0.5); }
fn outb(v: vec3f, a: f32) -> vec4f { return vec4f(floor(clamp(v, vec3f(0.0), vec3f(255.0)) + 0.5) / 255.0, a); }
fn lum1e4(c: vec3u) -> u32 { return 2126u * c.r + 7152u * c.g + 722u * c.b; }
`;
const FS = '@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f { let p = vec2i(pos.xy);';

const WGSL = {
  // U[0] = (radius, dx, dy, final). K = half kernel. Intermediate pass stays in float (rgba32float target).
  gaussian: `${FS}
    let r = i32(U[0].x); let d = vec2i(U[0].yz);
    var acc = vec3f(0.0);
    for (var i = -r; i <= r; i++) { acc += K[u32(abs(i))] * ld(p + d * i).rgb; }
    let a = ld(p).a;
    if (U[0].w > 0.5) { return outb(acc * 255.0, a); }
    return vec4f(acc, a);
  }`,
  // U[0] = (size, divisor, bias). K = kernel row-major.
  convolve: `${FS}
    let n = i32(U[0].x); let h = n / 2;
    var acc = vec3f(0.0);
    for (var j = 0; j < n; j++) { for (var i = 0; i < n; i++) { acc += K[u32(j * n + i)] * b255(ld(p + vec2i(i - h, j - h))).rgb; } }
    return outb(acc / U[0].y + U[0].z, ld(p).a);
  }`,
  sobel: `fn l(p: vec2i) -> f32 { return dot(b255(ld(p)).rgb, vec3f(0.2126, 0.7152, 0.0722)); }
  ${FS}
    let a = l(p + vec2i(-1, -1)); let b = l(p + vec2i(0, -1)); let c = l(p + vec2i(1, -1));
    let d = l(p + vec2i(-1, 0)); let f = l(p + vec2i(1, 0));
    let g = l(p + vec2i(-1, 1)); let h = l(p + vec2i(0, 1)); let i = l(p + vec2i(1, 1));
    let gx = (c + 2.0 * f + i) - (a + 2.0 * d + g);
    let gy = (g + 2.0 * h + i) - (a + 2.0 * b + c);
    let m = min(sqrt(gx * gx + gy * gy), 255.0);
    return outb(vec3f(m), 1.0);
  }`,
  grayscale: `${FS}
    let c = ld(p); let g = f32((lum1e4(vec3u(b255(c).rgb)) + 5000u) / 10000u) / 255.0;
    return vec4f(g, g, g, c.a);
  }`,
  invert: `${FS}
    let c = ld(p); return outb(255.0 - b255(c).rgb, c.a);
  }`,
  // U[0].x = t·10000
  threshold: `${FS}
    let v = select(0.0, 1.0, f32(lum1e4(vec3u(b255(ld(p)).rgb))) >= U[0].x - 0.5);
    return vec4f(v, v, v, 1.0);
  }`,
  // U[0..4] = the 20 matrix entries, row-major
  colorMatrix: `fn m(i: i32) -> f32 { return U[i / 4][i % 4]; }
  ${FS}
    let c = ld(p); var o = vec4f(0.0);
    for (var r = 0; r < 4; r++) { o[r] = m(r * 5) * c.r + m(r * 5 + 1) * c.g + m(r * 5 + 2) * c.b + m(r * 5 + 3) * c.a + m(r * 5 + 4); }
    return floor(clamp(o, vec4f(0.0), vec4f(1.0)) * 255.0 + 0.5) / 255.0;
  }`,
  // U[0] = (sw, sh, dw, dh), U[1].x = 1 for bilinear. Source coordinates are computed on integers (exact).
  resize: `${FS}
    let s = vec2i(U[0].xy); let d = vec2i(U[0].zw);
    if (U[1].x < 0.5) { return ld(((2 * p + 1) * s) / (2 * d)); }
    let den = 2 * d; let n = (2 * p + 1) * s - d + den;      // (source coord + 1) · den, always ≥ 0
    let i0 = n / den - 1; let t = vec2f(n - (n / den) * den) / vec2f(den);
    let top = mix(b255(ld(i0)), b255(ld(i0 + vec2i(1, 0))), t.x);
    let bot = mix(b255(ld(i0 + vec2i(0, 1))), b255(ld(i0 + vec2i(1, 1))), t.x);
    return floor(mix(top, bot, t.y) + 0.5) / 255.0;
  }`,
  // U[0] = (radius, dx, dy, dilate)
  morph: `${FS}
    let r = i32(U[0].x); let d = vec2i(U[0].yz); let dil = U[0].w > 0.5;
    var v = ld(p).rgb;
    for (var i = -r; i <= r; i++) { let c = ld(p + d * i).rgb; if (dil) { v = max(v, c); } else { v = min(v, c); } }
    return vec4f(v, ld(p).a);
  }`,
  // U[0] = (levels, n, mono). K = Bayer index matrix. level = floor(v·L/den + (2B+1)/(2n²)) on integers.
  bayer: `fn lvl(v: u32, den: u32, L: u32, B: u32, nn2: u32) -> u32 {
    let a = v * L; let q = a / den; let r = a % den;
    return min(q + select(0u, 1u, r * nn2 + den * (2u * B + 1u) >= den * nn2), L);
  }
  fn back(l: u32, L: u32) -> f32 { return f32((l * 510u + L) / (2u * L)) / 255.0; }
  ${FS}
    let L = u32(U[0].x) - 1u; let n = u32(U[0].y); let nn2 = 2u * n * n;
    let B = u32(K[(u32(p.y) % n) * n + (u32(p.x) % n)]);
    let c = ld(p); let v = vec3u(b255(c).rgb);
    if (U[0].z > 0.5) { let g = back(lvl(lum1e4(v), 2550000u, L, B, nn2), L); return vec4f(g, g, g, c.a); }
    return vec4f(back(lvl(v.r, 255u, L, B, nn2), L), back(lvl(v.g, 255u, L, B, nn2), L), back(lvl(v.b, 255u, L, B, nn2), L), c.a);
  }`,
  // U[0] = (radius, 1/(2σs²), 1/(2σc²))
  bilateral: `${FS}
    let r = i32(U[0].x); let c = ld(p); let c0 = b255(c).rgb;
    var acc = vec3f(0.0); var ws = 0.0;
    for (var j = -r; j <= r; j++) { for (var i = -r; i <= r; i++) {
      let s = b255(ld(p + vec2i(i, j))).rgb; let dc = s - c0;
      let w = exp(-f32(i * i + j * j) * U[0].y - dot(dc, dc) * U[0].z);
      acc += w * s; ws += w;
    } }
    return outb(acc / ws, c.a);
  }`,
};

/** steps: [{op, u:number[], k?:Float32Array, format?, width?, height?, cost?}] — chained passes, the last one read back. */
async function runSteps(device, img, steps) {
  rt.checkSize(device, img.width, img.height);
  return rt.scoped(device, async () => {
    const trash = [];
    try {
      let cur = rt.uploadImg(device, img); trash.push(cur);
      let w = img.width, h = img.height;
      for (const s of steps) {
        const tw = s.width ?? w, th = s.height ?? h; const format = s.format || 'rgba8unorm';
        const { pipeline, layout } = rt.renderPipeline(device, { code: HEAD(!!s.k) + WGSL[s.op], kinds: s.k ? ['utex', 'uniform', 'storage'] : ['utex', 'uniform'], format });
        const target = rt.makeTarget(device, tw, th, format); trash.push(target);
        const u = new Float32Array(32); u.set(s.u || []);
        const res = [cur, rt.uniformOf(device, u)]; trash.push(res[1]);
        if (s.k) { res.push(rt.storageOf(device, Float32Array.from(s.k))); trash.push(res[2]); }
        await rt.draw(device, { pipeline, bindGroup: rt.bind(device, layout, res), target, width: tw, height: th, cost: s.cost || 1 });
        cur = target; w = tw; h = th;
      }
      return await rt.readImg(device, cur, w, h);
    } finally { for (const t of trash) t.destroy(); }
  });
}

const KERNELS = {
  gaussian(p) {
    const { radius, w } = gaussWeights(p.sigma); const cost = 2 * radius + 1;
    return [{ op: 'gaussian', u: [radius, 1, 0, 0], k: w, format: 'rgba32float', cost }, { op: 'gaussian', u: [radius, 0, 1, 1], k: w, cost }];
  },
  convolve: (p) => [{ op: 'convolve', u: [p.size, p.divisor, p.bias], k: p.kernel, cost: p.size * p.size }],
  sobel: () => [{ op: 'sobel', cost: 9 }],
  grayscale: () => [{ op: 'grayscale' }],
  invert: () => [{ op: 'invert' }],
  threshold: (p) => [{ op: 'threshold', u: [p.t * 10000] }],
  colorMatrix: (p) => [{ op: 'colorMatrix', u: p.matrix }],
  resize: (p, img) => [{ op: 'resize', u: [img.width, img.height, p.width, p.height, p.filter === 'bilinear' ? 1 : 0], width: p.width, height: p.height, cost: 4 }],
  morph: (p) => (p.radius === 0 ? [{ op: 'morph', u: [0, 1, 0, 0] }] : [
    { op: 'morph', u: [p.radius, 1, 0, p.op === 'dilate' ? 1 : 0], cost: 2 * p.radius + 1 },
    { op: 'morph', u: [p.radius, 0, 1, p.op === 'dilate' ? 1 : 0], cost: 2 * p.radius + 1 },
  ]),
  bayer: (p) => [{ op: 'bayer', u: [p.levels, p.size, p.mono ? 1 : 0], k: bayerMatrix(p.size) }],
  bilateral: (p) => { const r = Math.ceil(2 * p.sigmaSpace); return [{ op: 'bilateral', u: [r, 1 / (2 * p.sigmaSpace ** 2), 1 / (2 * p.sigmaColor ** 2)], cost: (2 * r + 1) ** 2 }]; },
};

async function kernel(op, img, params, device) {
  const p = normParams(op, params);
  if (op === 'resize') rt.checkSize(device, p.width, p.height, 'resize target');
  return runSteps(device, img, KERNELS[op](p, img));
}
for (const op of OP_NAMES) M.gpu.register(op, (img, params, device) => kernel(op, img, params, device));

async function needDevice(what) {
  const device = await rt.acquire(M.gpu);
  if (!device) throw new Error(`${what} needs WebGPU, which is not available in this browser (see gpu.info / sys.env) — use the CPU tools instead`);
  return device;
}
const lazyRef = () => import('../js/gpu/reference.js');

// ──────────────────────────────────────────────────────────── tools ──
register({
  name: 'gpu.info', readOnly: true,
  description: 'WebGPU status: whether a device is available, the adapter (vendor, architecture, software fallback or not), the limits that bound image work (max texture side, buffer sizes, compute workgroup sizes), enabled features, and the list of accelerated image ops with their parameters. Call this first to learn whether backend=gpu will work and how large an image the GPU accepts.',
  schema: { properties: {} },
  examples: ['gpu.info'],
  async run() {
    const device = await rt.acquire(M.gpu); const info = await M.gpu.info();
    const ops = Object.fromEntries(OP_NAMES.map((o) => [o, OPS[o].doc]));
    if (!device) return { available: false, reason: globalThis.navigator?.gpu ? 'navigator.gpu exists but no adapter/device could be acquired' : 'navigator.gpu is undefined in this browser', ops, note: 'All tools still work on CPU; gpu.run, gpu.shader need WebGPU.' };
    const L = device.limits; const pick = ['maxTextureDimension2D', 'maxBufferSize', 'maxStorageBufferBindingSize', 'maxUniformBufferBindingSize', 'maxBindGroups', 'maxColorAttachments', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupsPerDimension'];
    const { ops: _o, ...adapter } = info;
    return {
      ...adapter,
      limits: Object.fromEntries(pick.map((k) => [k, L[k]])),
      maxImage: `${L.maxTextureDimension2D}×${L.maxTextureDimension2D}`,
      features: [...device.features].sort(),
      wgslFeatures: navigator.gpu.wgslLanguageFeatures ? [...navigator.gpu.wgslLanguageFeatures].sort() : [],
      canvasFormat: navigator.gpu.getPreferredCanvasFormat?.() || null,
      ops,
    };
  },
});

register({
  name: 'gpu.run', gpu: true,
  description: `Apply one accelerated image kernel on the GPU, directly, and write the result as an image. WebGPU only (no CPU fallback — it fails with a clear error without a GPU; use the image.* tools for automatic fallback). Bytes are treated as linear values, edges clamp, alpha is kept unless the op says otherwise. Ops and their params: ${OP_NAMES.map((o) => `${o} ${OPS[o].doc}`).join(' · ')}. Returns the output file stat, the normalised params and the time spent.`,
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the source image' },
      op: { type: 'string', enum: OP_NAMES, description: 'Kernel to run' },
      params: { type: 'object', description: 'Parameters of the op as an object (a JSON string is accepted too), e.g. {"sigma":3} for gaussian. Missing optional params take the documented defaults.', default: {} },
      output: { type: 'string', description: 'VFS path to write (default: <input>.<op>.png)' },
    },
    required: ['input', 'op'],
  },
  examples: ['gpu.run input=cat.png op=gaussian params={"sigma":4}', 'gpu.run input=cat.png op=bayer params={"levels":2,"size":8,"mono":true} output=cat.1bit.png'],
  async run({ input, op, params, output }) {
    const p = normParams(op, params);                       // validate before touching the GPU
    const device = await needDevice('gpu.run');
    const img = await decode(input);
    const t0 = performance.now();
    const res = await kernel(op, img, p, device);
    const ms = +(performance.now() - t0).toFixed(1);
    return { output: await save(res, vfs.out(output, input, op, 'png')), op, params: p, backend: 'webgpu', ms };
  },
});

// ─────────────────────────────────────────────────────── gpu.shader ──
const SHADER_PRELUDE = /* wgsl */`struct Uniforms {
  resolution: vec2f,        // output size in pixels
  srcSize: vec2f,           // input image size in pixels (1,1 when there is no input)
  time: f32,                // the "time" argument
  frame: f32,               // index of the current pass, 0 .. frames-1
  frames: f32,              // the "passes" argument
  seed: f32,                // the "seed" argument
  params: array<vec4f, 2>,  // the "params" argument: 8 floats, read with param(i)
}
@group(0) @binding(0) var src: texture_2d<f32>;   // previous pass output (the input image on pass 0)
@group(0) @binding(1) var orig: texture_2d<f32>;  // always the input image
@group(0) @binding(2) var smp: sampler;           // linear, clamp-to-edge
@group(0) @binding(3) var<uniform> u: Uniforms;
fn load(p: vec2i) -> vec4f { return textureLoad(src, clamp(p, vec2i(0), vec2i(textureDimensions(src)) - 1), 0); }
fn loadOrig(p: vec2i) -> vec4f { return textureLoad(orig, clamp(p, vec2i(0), vec2i(textureDimensions(orig)) - 1), 0); }
fn tex(uv: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }
fn texOrig(uv: vec2f) -> vec4f { return textureSampleLevel(orig, smp, uv, 0.0); }
fn param(i: i32) -> f32 { return u.params[i / 4][i % 4]; }`;
const SHADER_FS = '@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f { return pixel(vec2i(pos.xy), pos.xy / u.resolution); }';
const SHADER_CS = `@group(0) @binding(4) var dst: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8) fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(u.resolution.x) || id.y >= u32(u.resolution.y)) { return; }
  let p = vec2i(id.xy);
  textureStore(dst, p, pixel(p, (vec2f(p) + 0.5) / u.resolution));
}`;

function assembleShader(code, stage) {
  const full = /\bfn\s+pixel\s*\(/.test(code);
  const head = SHADER_PRELUDE + '\n' + (full ? '' : 'fn pixel(p: vec2i, uv: vec2f) -> vec4f {\n');
  const offset = head.split('\n').length - 1;                 // module line of user line 1, minus 1
  const src = head + code + (full ? '\n' : '\n}\n') + (stage === 'compute' ? SHADER_CS : SHADER_FS) + '\n';
  return { src, offset, userLines: code.split('\n').length, full };
}
function describeMessages(messages, asm, code) {
  const lines = code.split('\n');
  return messages.map((m) => {
    const ul = m.lineNum - asm.offset;
    if (m.lineNum && ul === asm.userLines + 1) return `${m.type} at the end of your code (after line ${asm.userLines}): ${m.message}
    ${asm.userLines} | ${lines[asm.userLines - 1]}`;
    if (m.lineNum && ul >= 1 && ul <= asm.userLines) return `${m.type} at line ${ul}:${m.linePos}: ${m.message}\n    ${ul} | ${lines[ul - 1]}`;
    return `${m.type} (in the wrapper around your code, module line ${m.lineNum}:${m.linePos}): ${m.message}${/pixel/.test(m.message) ? ' — your code must define `fn pixel(p: vec2i, uv: vec2f) -> vec4f` or be the body of that function' : ''}`;
  });
}

register({
  name: 'gpu.shader', gpu: true,
  description: [
    'Run your own WGSL over an image on the GPU — the playground tool. You write one function (or just its body): `fn pixel(p: vec2i, uv: vec2f) -> vec4f`, called once per output pixel; p = integer pixel coordinate (0,0 top-left), uv = pixel centre in 0..1; return straight (non-premultiplied) RGBA in 0..1, written to an 8-bit linear image (no sRGB conversion).',
    'Available to your code: `load(p)` exact texel of the source with clamp-to-edge · `tex(uv)` bilinear sample · `loadOrig(p)` / `texOrig(uv)` the same on the untouched input · `param(i)` the i-th of 8 float params · `u.resolution` (output size, px) · `u.srcSize` (input size, px) · `u.time` · `u.seed` · `u.frame` / `u.frames` (pass index / count). Raw bindings if you prefer: `src`, `orig` (texture_2d<f32>), `smp` (sampler).',
    'With passes>1 the output of each pass becomes `src` of the next (feedback, still 8-bit) while `orig` stays the input — iterate blurs, cellular automata, erosion. stage=fragment (default) allows derivatives (dpdx, textureSample); stage=compute runs the same contract in a compute shader (workgroup 8×8, textureStore). You may define helper functions and consts before `fn pixel`; do not declare bindings in group 0.',
    'Without an input the source is one transparent pixel: set width/height and generate procedurally. On a WGSL error nothing is written and the error lists every compiler message verbatim with the line:column in YOUR code and the offending line, so you can fix and retry.',
    'Example (edge glow): code = "let c = load(p).rgb; let dx = load(p + vec2i(1, 0)).rgb - load(p - vec2i(1, 0)).rgb; let dy = load(p + vec2i(0, 1)).rgb - load(p - vec2i(0, 1)).rgb; let e = length(dx) + length(dy); return vec4f(mix(c * 0.3, vec3f(0.2, 1.0, 0.4), clamp(e * param(0), 0.0, 1.0)), 1.0);" with params=[2]. Returns the output stat, stage, size, passes, ms and any compiler warnings.',
  ].join(' '),
  schema: {
    properties: {
      code: { type: 'string', description: 'WGSL: either the body of `fn pixel(p: vec2i, uv: vec2f) -> vec4f` (must end with a return) or full source that defines that function plus any helpers' },
      codeFile: { type: 'string', description: 'Alternative to code: VFS path of a text file holding the WGSL' },
      input: { type: 'string', description: 'VFS path of the source image (optional — omit for a purely procedural shader)' },
      width: { type: 'integer', minimum: 1, maximum: 16384, description: 'Output width (default: input width, or 512 without input)' },
      height: { type: 'integer', minimum: 1, maximum: 16384, description: 'Output height (default: input height, or 512 without input)' },
      params: { type: 'array', items: { type: 'number' }, default: [], description: 'Up to 8 floats, read in WGSL with param(0)…param(7); missing ones are 0' },
      time: { type: 'number', default: 0, description: 'Value of u.time (call repeatedly with increasing time to render animation frames)' },
      seed: { type: 'number', default: 0, description: 'Value of u.seed' },
      passes: { type: 'integer', default: 1, minimum: 1, maximum: 2000, description: 'Number of times to run the shader, feeding each output back as src' },
      stage: { type: 'string', enum: ['fragment', 'compute'], default: 'fragment', description: 'Shader stage that runs pixel()' },
      output: { type: 'string', description: 'VFS path to write (default: <input>.shader.png or shader.png)' },
    },
  },
  examples: [
    'gpu.shader input=cat.png code="return vec4f(1.0 - load(p).rgb, 1.0);"',
    'gpu.shader width=512 height=512 params=[6] code="let d = length(uv - 0.5); return vec4f(vec3f(0.5 + 0.5 * cos(d * 40.0 * param(0) - u.time)), 1.0);"',
    'gpu.shader input=cat.png passes=8 stage=compute code="return (load(p + vec2i(1, 0)) + load(p - vec2i(1, 0)) + load(p + vec2i(0, 1)) + load(p - vec2i(0, 1))) * 0.25;"',
  ],
  async run(args) {
    let code = args.code;
    if (!code && args.codeFile) code = vfs.text(args.codeFile);
    if (!code || !code.trim()) throw new Error('give the WGSL in "code" (or "codeFile"): the body of fn pixel(p: vec2i, uv: vec2f) -> vec4f, e.g. "return vec4f(1.0 - load(p).rgb, 1.0);"');
    if (args.params.length > 8) throw new Error(`at most 8 params are available (got ${args.params.length})`);
    const device = await needDevice('gpu.shader');
    const img = args.input ? await decode(args.input) : { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    const W = args.width || (args.input ? img.width : 512), H = args.height || (args.input ? img.height : 512);
    rt.checkSize(device, W, H, 'output'); rt.checkSize(device, img.width, img.height, 'input');
    const compute = args.stage === 'compute';
    if (!/\bfn\s+pixel\s*\(/.test(code) && /(^|\n)\s*(fn|struct)\s/.test(code)) throw new Error('your WGSL declares functions or structs but no `fn pixel(p: vec2i, uv: vec2f) -> vec4f` — define that function (helpers may come before it), or pass only the body of pixel()');
    const asm = assembleShader(code, args.stage);

    // compile on its own so that diagnostics come back verbatim, mapped to the caller's line numbers
    const module = device.createShaderModule({ code: asm.src + (compute ? '' : rt.VS) });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`WGSL compile failed (${errors.length} error${errors.length > 1 ? 's' : ''}):\n${describeMessages(errors, asm, code).join('\n')}`);
    const warnings = describeMessages(info.messages.filter((m) => m.type !== 'error'), asm, code).slice(0, 20);

    const t0 = performance.now(); const trash = [];
    try {
      const out = await rt.scoped(device, async () => {
        const kinds = compute ? ['tex', 'tex', 'sampler', 'uniform', 'store8'] : ['tex', 'tex', 'sampler', 'uniform'];
        const layout = rt.layoutOf(device, kinds, args.stage);
        const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
        const pipeline = compute
          ? await device.createComputePipelineAsync({ layout: pl, compute: { module, entryPoint: 'cs_main' } })
          : await device.createRenderPipelineAsync({ layout: pl, vertex: { module, entryPoint: 'vs_main' }, fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] } });
        const orig = rt.uploadImg(device, img); trash.push(orig);
        const extra = compute ? GPUTextureUsage.STORAGE_BINDING : 0;
        const ping = [rt.makeTarget(device, W, H, 'rgba8unorm', extra)]; trash.push(ping[0]);
        if (args.passes > 1) { ping.push(rt.makeTarget(device, W, H, 'rgba8unorm', extra)); trash.push(ping[1]); }
        const ub = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); trash.push(ub);
        const uni = new Float32Array(16); uni.set([W, H, img.width, img.height, args.time, 0, args.passes, args.seed]); uni.set(args.params, 8);
        const smp = rt.samplerOf(device);
        // one uniform buffer per pass index would be wasteful; queue order guarantees each submit sees its own frame value
        let cur = orig, dst = ping[0];
        for (let i = 0; i < args.passes; i++) {
          dst = ping[i % ping.length]; uni[5] = i; device.queue.writeBuffer(ub, 0, uni);
          const res = [cur, orig, smp, ub]; if (compute) res.push(dst);
          const bg = rt.bind(device, layout, res); const enc = device.createCommandEncoder();
          if (compute) { const cp = enc.beginComputePass(); cp.setPipeline(pipeline); cp.setBindGroup(0, bg); cp.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); cp.end(); } else rt.pass(enc, pipeline, bg, dst.createView());
          device.queue.submit([enc.finish()]);
          if (i % 64 === 63) await device.queue.onSubmittedWorkDone();
          cur = dst;
        }
        return rt.readImg(device, dst, W, H);
      });
      const stat = await save(out, vfs.out(args.output, args.input || 'shader', args.input ? 'shader' : '', 'png'));
      return { output: stat, backend: 'webgpu', stage: args.stage, width: W, height: H, passes: args.passes, ms: +(performance.now() - t0).toFixed(1), ...(warnings.length ? { warnings } : {}) };
    } finally { for (const t of trash) t.destroy(); }
  },
});

// ──────────────────────────────────────────────── gpu.verify / bench ──
const TEST_PARAMS = {
  gaussian: [{ sigma: 0.6 }, { sigma: 2.5 }, { sigma: 7 }],
  convolve: [{ kernel: [0, -1, 0, -1, 5, -1, 0, -1, 0], size: 3 }, { kernel: [1, 4, 6, 4, 1, 4, 16, 24, 16, 4, 6, 24, 36, 24, 6, 4, 16, 24, 16, 4, 1, 4, 6, 4, 1], size: 5, divisor: 256 }, { kernel: [-2, -1, 0, -1, 1, 1, 0, 1, 2], size: 3, divisor: 1, bias: 64 }],
  sobel: [{}], grayscale: [{}], invert: [{}],
  threshold: [{ t: 128 }, { t: 60.5 }, { t: 0 }, { t: 255 }],
  colorMatrix: [{ matrix: OPS.colorMatrix.example.matrix }, { matrix: [1.4, -0.2, -0.2, 0, 0.05, -0.2, 1.4, -0.2, 0, -0.1, 0, 0, 1, 0, 0, 0.2, 0, 0, 0.7, 0.1] }],
  resize: [{ width: 97, height: 61, filter: 'nearest' }, { width: 97, height: 61, filter: 'bilinear' }, { width: 400, height: 333, filter: 'bilinear' }, { width: 514, height: 262, filter: 'nearest' }, { width: 1, height: 1, filter: 'bilinear' }],
  morph: [{ op: 'erode', radius: 1 }, { op: 'dilate', radius: 3 }, { op: 'erode', radius: 6 }],
  bayer: [{ levels: 2, size: 2 }, { levels: 2, size: 4, mono: true }, { levels: 4, size: 8 }, { levels: 256, size: 8 }, { levels: 7, size: 8, mono: true }, { levels: 3, size: 4 }],
  bilateral: [{ sigmaSpace: 1, sigmaColor: 20 }, { sigmaSpace: 3, sigmaColor: 60 }],
};

register({
  name: 'gpu.verify', gpu: true, readOnly: true,
  description: 'Self-test of the accelerated kernels on this machine: runs every GPU op (several parameter sets each) on a deterministic test image and compares the result with a plain-JS float64 reference, reporting the maximum absolute difference per channel for each op. The contract is max ≤ 1. Use it to check that this GPU/driver computes correctly before trusting backend=gpu, or after changing a kernel. Odd default size (257×131) exercises row padding. Returns {pass, worst, ops:{op:{max, cases}}}.',
  schema: {
    properties: {
      ops: { type: 'array', items: { type: 'string', enum: OP_NAMES }, description: 'Ops to test (default: all)' },
      width: { type: 'integer', default: 257, minimum: 2, maximum: 1024, description: 'Test image width' },
      height: { type: 'integer', default: 131, minimum: 2, maximum: 1024, description: 'Test image height' },
      seed: { type: 'integer', default: 1, description: 'Seed of the test image noise' },
    },
  },
  examples: ['gpu.verify', 'gpu.verify ops=gaussian,bilateral width=640 height=480'],
  async run({ ops, width, height, seed }, ctx) {
    const device = await needDevice('gpu.verify');
    const { reference, compare, testImage } = await lazyRef();
    const img = testImage(width, height, seed); const list = ops?.length ? ops : OP_NAMES;
    const report = {}; let worst = 0;
    for (let i = 0; i < list.length; i++) {
      const op = list[i]; const cases = [];
      for (const params of TEST_PARAMS[op]) {
        let c;
        try { c = compare(await kernel(op, img, params, device), reference(op, img, params)); } catch (e) { c = { max: Infinity, error: e.message }; }
        cases.push({ params: op === 'convolve' ? { size: params.size, divisor: params.divisor, bias: params.bias } : op === 'colorMatrix' ? {} : params, max: c.max === Infinity ? 'FAILED' : c.max, mean: c.mean, over1: c.over1, ...(c.error ? { error: c.error } : {}), ...(c.sizeMismatch ? { sizeMismatch: c.sizeMismatch } : {}) });
        if (c.max > worst) worst = c.max;
      }
      report[op] = { max: cases.some((c) => c.max === 'FAILED') ? 'FAILED' : Math.max(...cases.map((c) => c.max)), cases };
      ctx.progress((i + 1) / list.length, op);
    }
    return { pass: worst <= 1, worst: worst === Infinity ? 'FAILED' : worst, tolerance: 1, width, height, ops: report };
  },
});

// Public CPU tools to time against, tried in order; the first registered one wins. args(p, input) → tool args.
const CPU_TOOLS = {
  gaussian: [['image.blur', (p) => ({ sigma: p.sigma })]],
  convolve: [['image.convolve', (p) => ({ kernel: p.kernel, divisor: p.divisor, bias: p.bias })]],
  sobel: [['image.edges', () => ({ method: 'sobel' })], ['image.sobel', () => ({})]],
  grayscale: [['image.grayscale', () => ({})]],
  invert: [['image.invert', () => ({})]],
  threshold: [['image.threshold', (p) => ({ method: 'fixed', t: p.t })]],
  colorMatrix: [['image.colorMatrix', (p) => ({ matrix: p.matrix })]],
  resize: [['image.resize', (p) => ({ width: p.width, height: p.height, filter: p.filter, fit: 'fill' })]],
  morph: [['image.morph', (p) => ({ op: p.op, radius: p.radius })]],
  bayer: [['dither.bayer', (p) => ({ levels: p.levels, size: p.size, mono: p.mono })], ['dither.ordered', (p) => ({ levels: p.levels, size: p.size, mono: p.mono })]],
  bilateral: [['image.denoise', (p) => ({ method: 'bilateral', sigmaSpace: p.sigmaSpace, sigmaColor: p.sigmaColor })], ['image.bilateral', (p) => ({ sigmaSpace: p.sigmaSpace, sigmaColor: p.sigmaColor })]],
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const r1 = (x) => +x.toFixed(2);

register({
  name: 'gpu.bench', gpu: true, readOnly: true,
  description: 'Time one image op on the GPU against the CPU on a synthetic image of a chosen size, to decide which backend is worth using here. GPU time is the kernel alone (upload + compute + readback, pipelines warm). CPU time comes from the public tool for that op run with backend=cpu when one is registered (then it includes PNG decode/encode, reported as cpu.via = tool name), otherwise from the built-in plain-JS reference kernel (cpu.via = "js-reference", kernel only). Returns ms (median of `runs`) for each side, the speed-up, and megapixels/s. Works without WebGPU (GPU side reported as unavailable).',
  schema: {
    properties: {
      op: { type: 'string', enum: OP_NAMES, default: 'gaussian', description: 'Op to time' },
      params: { type: 'object', default: {}, description: 'Op params (default: a representative set for the op, e.g. sigma 4 for gaussian)' },
      width: { type: 'integer', default: 1024, minimum: 16, maximum: 8192, description: 'Synthetic image width' },
      height: { type: 'integer', default: 1024, minimum: 16, maximum: 8192, description: 'Synthetic image height' },
      runs: { type: 'integer', default: 3, minimum: 1, maximum: 20, description: 'Timed repetitions per side (median reported); one extra warm-up run is made on the GPU' },
      cpu: { type: 'string', enum: ['auto', 'tool', 'reference', 'skip'], default: 'auto', description: 'CPU side: auto = public tool if present else JS reference; tool = public tool only; reference = JS reference only; skip = GPU only' },
    },
  },
  examples: ['gpu.bench op=gaussian width=2048 height=2048', 'gpu.bench op=bilateral params={"sigmaSpace":4,"sigmaColor":40} width=512 height=512 runs=5'],
  async run({ op, params, width, height, runs, cpu: cpuMode }, ctx) {
    const BENCH_DEFAULT = { gaussian: { sigma: 4 }, resize: { width: Math.max(1, width >> 1), height: Math.max(1, height >> 1), filter: 'bilinear' }, threshold: { t: 128 }, morph: { op: 'dilate', radius: 3 }, bayer: { levels: 2, size: 8, mono: true }, bilateral: { sigmaSpace: 3, sigmaColor: 30 } };
    if (typeof params === 'string') { try { params = JSON.parse(params); } catch { throw new Error('params must be a JSON object'); } }
    const p = normParams(op, params && Object.keys(params).length ? params : BENCH_DEFAULT[op] || OPS[op].example);
    const ref = await lazyRef(); const img = ref.testImage(width, height, 7); const mp = (width * height) / 1e6;
    const result = { op, params: op === 'convolve' ? { size: p.size, divisor: p.divisor, bias: p.bias } : p, width, height, megapixels: r1(mp), runs };

    const device = await rt.acquire(M.gpu); let gpuOut = null;
    if (!device) result.gpu = { available: false };
    else {
      try {
        const t0 = performance.now(); gpuOut = await kernel(op, img, p, device); const first = performance.now() - t0; const times = [];
        for (let i = 0; i < runs; i++) { const t = performance.now(); gpuOut = await kernel(op, img, p, device); times.push(performance.now() - t); }
        result.gpu = { ms: r1(median(times)), firstRunMs: r1(first), mpPerSec: r1(mp / (median(times) / 1000)) };
      } catch (e) { result.gpu = { error: e.message }; }
    }
    ctx.progress(0.5, 'gpu done');

    if (cpuMode !== 'skip') {
      const hit = cpuMode === 'reference' ? null : (CPU_TOOLS[op] || []).find(([n]) => M.tools.has(n));
      if (hit) {
        const [name, mk] = hit; const tool = M.tools.get(name); const props = tool.schema.properties;
        const tmpIn = vfs.unique('.bench/in', 'png'); await save(img, tmpIn); const tmpOut = '.bench/out.png';
        try {
          const a = { ...mk(p), ...(props.input ? { input: tmpIn } : {}), ...(props.output ? { output: tmpOut } : {}), ...(props.backend ? { backend: 'cpu' } : {}) };
          for (const k of Object.keys(a)) if (!(k in props)) delete a[k];
          const times = []; let backend;
          for (let i = 0; i < runs; i++) { const t = performance.now(); const r = await M.run(name, a); times.push(performance.now() - t); backend = r?.backend; }
          result.cpu = { ms: r1(median(times)), via: name, backend: backend || 'unknown', includesCodec: true, mpPerSec: r1(mp / (median(times) / 1000)) };
        } catch (e) { result.cpu = { via: name, error: e.message }; } finally { vfs.rm(tmpIn); vfs.rm(tmpOut); }
      }
      if (!result.cpu || (result.cpu.error && cpuMode === 'auto')) {
        if (cpuMode === 'tool') result.cpu = result.cpu || { error: `no public CPU tool registered for "${op}" (looked for: ${(CPU_TOOLS[op] || []).map(([n]) => n).join(', ')})` };
        else {
          const toolError = result.cpu?.error ? { toolError: `${result.cpu.via}: ${result.cpu.error}` } : {};
          const cost = width * height * OPS[op].taps(p); const n = cost > 4e8 ? 1 : runs; const times = []; let out;
          for (let i = 0; i < n; i++) { const t = performance.now(); out = ref.reference(op, img, p); times.push(performance.now() - t); }
          result.cpu = { ms: r1(median(times)), via: 'js-reference', backend: 'js', runs: n, includesCodec: false, mpPerSec: r1(mp / (median(times) / 1000)), ...toolError };
          if (gpuOut) result.maxDiff = ref.compare(gpuOut, out).max;
        }
      }
    }
    if (result.gpu?.ms && result.cpu?.ms) result.speedup = r1(result.cpu.ms / result.gpu.ms);
    return result;
  },
});
