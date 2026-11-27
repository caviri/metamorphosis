// μεταμόρφωσις :: gpu/rt — the small WebGPU runtime shared by tools/gpu.js and tools/synth.js.
// Importing this file touches no WebGPU API; everything happens when a function is called with a device.
// All caches are keyed on the GPUDevice (WeakMap), so a lost device simply takes its pipelines with it.

const caches = new WeakMap();
export function cacheOf(device) {
  let c = caches.get(device);
  if (!c) { c = { modules: new Map(), layouts: new Map(), pipelines: new Map(), samplers: new Map() }; caches.set(device, c); }
  return c;
}

/** Fullscreen triangle. Fragment @builtin(position).xy is then (x+0.5, y+0.5) with row 0 at the top, like an img. */
export const VS = /* wgsl */`
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export function checkSize(device, w, h, what = 'image') {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error(`${what}: bad size ${w}×${h}`);
  const max = device.limits.maxTextureDimension2D;
  if (w > max || h > max) throw new Error(`${what} ${w}×${h} exceeds this GPU's maxTextureDimension2D (${max}) — use backend=cpu or downscale first`);
}

// binding kinds → layout entries. 'utex' = texture read with textureLoad only (works for rgba8unorm and the 32-bit float formats).
const KIND = {
  tex: () => ({ texture: { sampleType: 'float' } }),
  utex: () => ({ texture: { sampleType: 'unfilterable-float' } }),
  uniform: () => ({ buffer: { type: 'uniform' } }),
  storage: () => ({ buffer: { type: 'read-only-storage' } }),
  sampler: () => ({ sampler: { type: 'filtering' } }),
  store8: () => ({ storageTexture: { access: 'write-only', format: 'rgba8unorm' } }),
};
export function layoutOf(device, kinds, stage = 'fragment') {
  const c = cacheOf(device); const key = stage + ':' + kinds.join(',');
  let l = c.layouts.get(key);
  if (!l) {
    const visibility = stage === 'compute' ? GPUShaderStage.COMPUTE : GPUShaderStage.FRAGMENT;
    l = device.createBindGroupLayout({ entries: kinds.map((k, binding) => ({ binding, visibility, ...KIND[k]() })) });
    c.layouts.set(key, l);
  }
  return l;
}
export function moduleOf(device, code, cache = true) {
  const c = cacheOf(device);
  let m = cache ? c.modules.get(code) : null;
  if (!m) { m = device.createShaderModule({ code }); if (cache) c.modules.set(code, m); }
  return m;
}
/** Render pipeline for a fragment shader `code` (must define fs_main; VS is appended). Cached per device. → {pipeline, layout} */
export function renderPipeline(device, { code, kinds, format = 'rgba8unorm', cache = true }) {
  const c = cacheOf(device); const key = `r|${format}|${kinds.join(',')}|${code}`;
  let p = cache ? c.pipelines.get(key) : null;
  if (!p) {
    const layout = layoutOf(device, kinds, 'fragment');
    const module = moduleOf(device, code + VS, cache);
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    p = { pipeline, layout, module };
    if (cache) c.pipelines.set(key, p);
  }
  return p;
}
export function computePipeline(device, { code, kinds, cache = true }) {
  const c = cacheOf(device); const key = `c|${kinds.join(',')}|${code}`;
  let p = cache ? c.pipelines.get(key) : null;
  if (!p) {
    const layout = layoutOf(device, kinds, 'compute');
    const module = moduleOf(device, code, cache);
    const pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint: 'cs_main' } });
    p = { pipeline, layout, module };
    if (cache) c.pipelines.set(key, p);
  }
  return p;
}
export function samplerOf(device, filter = 'linear', address = 'clamp-to-edge') {
  const c = cacheOf(device); const key = filter + address;
  let s = c.samplers.get(key);
  if (!s) { s = device.createSampler({ magFilter: filter, minFilter: filter, addressModeU: address, addressModeV: address }); c.samplers.set(key, s); }
  return s;
}

/** img {width,height,data RGBA8} → rgba8unorm texture (no sRGB conversion). Caller destroys it. */
export function uploadImg(device, img, extraUsage = 0) {
  checkSize(device, img.width, img.height);
  if (img.data.length !== img.width * img.height * 4) throw new Error(`image data length ${img.data.length} does not match ${img.width}×${img.height}×4`);
  const tex = device.createTexture({ size: [img.width, img.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | extraUsage });
  device.queue.writeTexture({ texture: tex }, img.data, { bytesPerRow: img.width * 4, rowsPerImage: img.height }, [img.width, img.height]);
  return tex;
}
export function makeTarget(device, w, h, format = 'rgba8unorm', extraUsage = 0) {
  checkSize(device, w, h, 'output');
  return device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | extraUsage });
}
/** typed array → GPU buffer (padded to a multiple of 4, at least 16 bytes). Caller destroys it. */
export function bufferOf(device, data, usage) {
  const size = Math.max(16, Math.ceil(data.byteLength / 4) * 4);
  const buf = device.createBuffer({ size, usage, mappedAtCreation: true });
  new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  buf.unmap();
  return buf;
}
export const uniformOf = (device, floats) => bufferOf(device, floats instanceof Float32Array ? floats : new Float32Array(floats), GPUBufferUsage.UNIFORM);
export const storageOf = (device, floats) => bufferOf(device, floats instanceof Float32Array || floats instanceof Uint32Array ? floats : new Float32Array(floats), GPUBufferUsage.STORAGE);

export function bind(device, layout, resources) {
  return device.createBindGroup({ layout, entries: resources.map((r, binding) => ({ binding, resource: typeof GPUBuffer !== 'undefined' && r instanceof GPUBuffer ? { buffer: r } : typeof GPUTexture !== 'undefined' && r instanceof GPUTexture ? r.createView() : r })) });
}
/** one fullscreen pass into `view` on an existing encoder; scissor = [x, y, w, h] keeps what is outside it. */
export function pass(encoder, pipeline, bindGroup, view, scissor, load = false) {
  const rp = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
  rp.setPipeline(pipeline); rp.setBindGroup(0, bindGroup);
  if (scissor) rp.setScissorRect(...scissor);
  rp.draw(3); rp.end();
}
/**
 * Draw one fullscreen pass into `target` and submit. `cost` = approximate texture reads per pixel; heavy passes are
 * split into horizontal bands submitted one by one, so a huge kernel on a huge image cannot trip the GPU watchdog.
 */
export async function draw(device, { pipeline, bindGroup, target, width, height, cost = 1 }) {
  const view = target.createView();
  const bands = Math.min(height, Math.max(1, Math.ceil((width * height * cost) / 1.5e9)));
  const rows = Math.ceil(height / bands);
  for (let b = 0, y = 0; y < height; b++, y += rows) {
    const enc = device.createCommandEncoder();
    pass(enc, pipeline, bindGroup, view, bands > 1 ? [0, y, width, Math.min(rows, height - y)] : null, b > 0);
    device.queue.submit([enc.finish()]);
    if (bands > 1) await device.queue.onSubmittedWorkDone();
  }
}

/** Read a texture back as tightly packed bytes (handles the 256-byte row alignment of copyTextureToBuffer). */
export async function readBytes(device, tex, w, h, bytesPerPixel = 4) {
  const rowBytes = w * bytesPerPixel; const bpr = Math.ceil(rowBytes / 256) * 256; const size = bpr * h;
  if (size > device.limits.maxBufferSize) throw new Error(`readback of ${w}×${h} needs a ${size}-byte buffer, above this GPU's maxBufferSize (${device.limits.maxBufferSize}) — use backend=cpu`);
  const buf = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: h }, [w, h]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const m = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(rowBytes * h);
    if (bpr === rowBytes) out.set(m.subarray(0, out.length));
    else for (let y = 0; y < h; y++) out.set(m.subarray(y * bpr, y * bpr + rowBytes), y * rowBytes);
    buf.unmap();
    return out;
  } finally { buf.destroy(); }
}
export async function readImg(device, tex, w, h) {
  const b = await readBytes(device, tex, w, h, 4);
  return { width: w, height: h, data: new Uint8ClampedArray(b.buffer, b.byteOffset, b.byteLength) };
}
export async function readFloats(device, tex, w, h, channels = 1) {
  const b = await readBytes(device, tex, w, h, 4 * channels);
  return new Float32Array(b.buffer, b.byteOffset, w * h * channels);
}

/** Run fn inside validation / out-of-memory / internal error scopes and turn any captured GPU error into a thrown Error. */
export async function scoped(device, fn) {
  device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory'); device.pushErrorScope('internal');
  let result, err;
  try { result = await fn(); } catch (e) { err = e; }
  let errs = [];
  try { errs = await Promise.all([device.popErrorScope(), device.popErrorScope(), device.popErrorScope()]); } catch { /* device lost: err below says so */ }
  const g = errs.find(Boolean);
  if (g) throw new Error(`WebGPU ${g.constructor?.name || 'error'}: ${g.message}`);
  if (err) throw err;
  return result;
}

/**
 * The core device, robust against the boot race: core's gpu.device() answers null to a caller that arrives while its
 * first probe is still in flight. If the browser does have an adapter, wait (bounded) for that probe to land.
 */
let settling, gaveUp = false;
export async function acquire(gpu) {
  const d = await gpu.device();
  if (d || gaveUp || !globalThis.navigator?.gpu) return d;
  settling ||= (async () => {
    let adapter = null;
    try { adapter = await navigator.gpu.requestAdapter(); } catch { /* none */ }
    if (!adapter) { gaveUp = true; return; }
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 50)); if (await gpu.device()) return; }
    gaveUp = true;
  })();
  await settling; settling = null;
  return gpu.device();
}
