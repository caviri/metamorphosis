// mind :: capability probes shared by the page and the inference worker. No imports, no side effects.

let gpuProbe;
/**
 * What WebGPU offers in THIS context (window or worker). Never throws.
 * → { api, available, reason?, context, vendor, architecture, description, fallbackAdapter, shaderF16, maxBufferSize, maxStorageBufferBindingSize }
 */
export function probeGpu() {
  return (gpuProbe ||= (async () => {
    const context = typeof document === 'undefined' ? 'worker' : 'window';
    const out = { api: false, available: false, context, shaderF16: false, fallbackAdapter: false };
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) {
      out.reason = `navigator.gpu does not exist in this ${context} (browser without WebGPU, WebGPU disabled, or an insecure origin)`;
      return out;
    }
    out.api = true;
    let adapter = null;
    try { adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch (e) { out.reason = `navigator.gpu.requestAdapter() threw: ${e?.message || e}`; return out; }
    if (!adapter) { out.reason = 'navigator.gpu.requestAdapter() returned no adapter (GPU blocklisted, driver missing, or hardware acceleration turned off)'; return out; }
    const i = adapter.info || {};
    out.available = true;
    out.vendor = i.vendor || ''; out.architecture = i.architecture || ''; out.description = i.description || i.device || '';
    out.fallbackAdapter = !!(i.isFallbackAdapter ?? adapter.isFallbackAdapter) || /swiftshader|llvmpipe|software|basic render/i.test(`${i.vendor} ${i.architecture} ${i.description} ${i.device}`);
    try { out.shaderF16 = adapter.features.has('shader-f16'); } catch { /* keep false */ }
    out.maxBufferSize = Number(adapter.limits?.maxBufferSize) || null;
    out.maxStorageBufferBindingSize = Number(adapter.limits?.maxStorageBufferBindingSize) || null;
    return out;
  })());
}

/** WebAssembly facts that decide how slow the CPU path is. */
export function probeWasm() {
  let simd = false;
  try { simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { /* no wasm */ }
  return {
    supported: typeof WebAssembly === 'object', simd,
    threads: typeof SharedArrayBuffer !== 'undefined' && !!globalThis.crossOriginIsolated,   // false on GitHub Pages (no COOP/COEP) → single-threaded
    cores: globalThis.navigator?.hardwareConcurrency || null,
    deviceMemoryGB: globalThis.navigator?.deviceMemory || null,
  };
}

export const human = (n) => {
  if (n == null || Number.isNaN(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let x = n;
  while (x >= 1000 && i < 3) { x /= 1000; i++; }
  return `${i ? x.toFixed(x >= 100 ? 0 : 1) : x} ${u[i]}`;
};
