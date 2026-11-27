// μεταμόρφωσις :: gpu/reference — plain-JS (float64) reference implementations of the accelerated kernels.
// Written straight from the op definitions in ops.js, deliberately naive. Used by gpu.verify (GPU vs reference, max abs
// difference per channel) and as the CPU side of gpu.bench when no public CPU tool exists for an op. Loaded lazily.
import { normParams, gaussWeights, bayerMatrix } from './ops.js';

const rb = (v) => { v = v < 0 ? 0 : v > 255 ? 255 : v; return Math.floor(v + 0.5); };
const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const out = (img, w = img.width, h = img.height) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const lumaOf = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
// the same luma evaluated without representation error (integer numerator over 10000)
const luma1e4 = (d, i) => 2126 * d[i] + 7152 * d[i + 1] + 722 * d[i + 2];

const impl = {
  gaussian(img, { sigma }) {
    const { width: w, height: h, data: d } = img; const { radius: r, w: k } = gaussWeights(sigma);
    const tmp = new Float64Array(w * h * 3); const o = out(img);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a0 = 0, a1 = 0, a2 = 0;
      for (let i = -r; i <= r; i++) { const j = (y * w + cl(x + i, 0, w - 1)) * 4; const kw = k[Math.abs(i)]; a0 += kw * d[j]; a1 += kw * d[j + 1]; a2 += kw * d[j + 2]; }
      const t = (y * w + x) * 3; tmp[t] = a0; tmp[t + 1] = a1; tmp[t + 2] = a2;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a0 = 0, a1 = 0, a2 = 0;
      for (let i = -r; i <= r; i++) { const j = (cl(y + i, 0, h - 1) * w + x) * 3; const kw = k[Math.abs(i)]; a0 += kw * tmp[j]; a1 += kw * tmp[j + 1]; a2 += kw * tmp[j + 2]; }
      const q = (y * w + x) * 4; o.data[q] = rb(a0); o.data[q + 1] = rb(a1); o.data[q + 2] = rb(a2); o.data[q + 3] = d[q + 3];
    }
    return o;
  },
  convolve(img, { kernel, size, divisor, bias }) {
    const { width: w, height: h, data: d } = img; const o = out(img); const hf = size >> 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a0 = 0, a1 = 0, a2 = 0;
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
        const s = (cl(y + j - hf, 0, h - 1) * w + cl(x + i - hf, 0, w - 1)) * 4; const kw = kernel[j * size + i];
        a0 += kw * d[s]; a1 += kw * d[s + 1]; a2 += kw * d[s + 2];
      }
      const q = (y * w + x) * 4; o.data[q] = rb(a0 / divisor + bias); o.data[q + 1] = rb(a1 / divisor + bias); o.data[q + 2] = rb(a2 / divisor + bias); o.data[q + 3] = d[q + 3];
    }
    return o;
  },
  sobel(img) {
    const { width: w, height: h, data: d } = img; const o = out(img);
    const L = new Float64Array(w * h); for (let i = 0; i < w * h; i++) L[i] = lumaOf(d, i * 4);
    const l = (x, y) => L[cl(y, 0, h - 1) * w + cl(x, 0, w - 1)];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const gx = (l(x + 1, y - 1) + 2 * l(x + 1, y) + l(x + 1, y + 1)) - (l(x - 1, y - 1) + 2 * l(x - 1, y) + l(x - 1, y + 1));
      const gy = (l(x - 1, y + 1) + 2 * l(x, y + 1) + l(x + 1, y + 1)) - (l(x - 1, y - 1) + 2 * l(x, y - 1) + l(x + 1, y - 1));
      const m = rb(Math.min(255, Math.sqrt(gx * gx + gy * gy))); const q = (y * w + x) * 4;
      o.data[q] = o.data[q + 1] = o.data[q + 2] = m; o.data[q + 3] = 255;
    }
    return o;
  },
  grayscale(img) {
    const d = img.data; const o = out(img);
    for (let q = 0; q < d.length; q += 4) { const g = rb(luma1e4(d, q) / 10000); o.data[q] = o.data[q + 1] = o.data[q + 2] = g; o.data[q + 3] = d[q + 3]; }
    return o;
  },
  invert(img) {
    const d = img.data; const o = out(img);
    for (let q = 0; q < d.length; q += 4) { o.data[q] = 255 - d[q]; o.data[q + 1] = 255 - d[q + 1]; o.data[q + 2] = 255 - d[q + 2]; o.data[q + 3] = d[q + 3]; }
    return o;
  },
  threshold(img, { t }) {
    const d = img.data; const o = out(img);
    for (let q = 0; q < d.length; q += 4) { const v = luma1e4(d, q) >= t * 10000 ? 255 : 0; o.data[q] = o.data[q + 1] = o.data[q + 2] = v; o.data[q + 3] = 255; }
    return o;
  },
  colorMatrix(img, { matrix: m }) {
    const d = img.data; const o = out(img);
    for (let q = 0; q < d.length; q += 4) {
      const r = d[q] / 255, g = d[q + 1] / 255, b = d[q + 2] / 255, a = d[q + 3] / 255;
      for (let c = 0; c < 4; c++) o.data[q + c] = rb(255 * cl(m[c * 5] * r + m[c * 5 + 1] * g + m[c * 5 + 2] * b + m[c * 5 + 3] * a + m[c * 5 + 4], 0, 1));
    }
    return o;
  },
  resize(img, { width: dw, height: dh, filter }) {
    const { width: sw, height: sh, data: d } = img; const o = out(img, dw, dh);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const q = (y * dw + x) * 4;
      if (filter === 'nearest') {
        // (x+0.5)·sw/dw evaluated on integers, so exact pixel-boundary cases do not depend on float rounding
        const sx = Math.min(sw - 1, Math.floor(((2 * x + 1) * sw) / (2 * dw))), sy = Math.min(sh - 1, Math.floor(((2 * y + 1) * sh) / (2 * dh)));
        const s = (sy * sw + sx) * 4; for (let c = 0; c < 4; c++) o.data[q + c] = d[s + c];
      } else {
        const fx = ((x + 0.5) * sw) / dw - 0.5, fy = ((y + 0.5) * sh) / dh - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const xa = cl(x0, 0, sw - 1), xb = cl(x0 + 1, 0, sw - 1), ya = cl(y0, 0, sh - 1), yb = cl(y0 + 1, 0, sh - 1);
        for (let c = 0; c < 4; c++) {
          const top = d[(ya * sw + xa) * 4 + c] * (1 - tx) + d[(ya * sw + xb) * 4 + c] * tx;
          const bot = d[(yb * sw + xa) * 4 + c] * (1 - tx) + d[(yb * sw + xb) * 4 + c] * tx;
          o.data[q + c] = rb(top * (1 - ty) + bot * ty);
        }
      }
    }
    return o;
  },
  morph(img, { op, radius: r }) {
    const { width: w, height: h, data: d } = img; const o = out(img); const f = op === 'erode' ? Math.min : Math.max;
    const tmp = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      let v = op === 'erode' ? 255 : 0;
      for (let i = -r; i <= r; i++) v = f(v, d[(y * w + cl(x + i, 0, w - 1)) * 4 + c]);
      tmp[(y * w + x) * 3 + c] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = op === 'erode' ? 255 : 0;
        for (let i = -r; i <= r; i++) v = f(v, tmp[(cl(y + i, 0, h - 1) * w + x) * 3 + c]);
        o.data[q + c] = v;
      }
      o.data[q + 3] = d[q + 3];
    }
    return o;
  },
  bayer(img, { levels, size: n, mono }) {
    const { width: w, height: h, data: d } = img; const o = out(img); const B = bayerMatrix(n); const L = levels - 1;
    const dz = (v, thr) => (Math.round(cl(v / 255 + thr / L, 0, 1) * L) / L) * 255;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4; const thr = (B[(y % n) * n + (x % n)] + 0.5) / (n * n) - 0.5;
      if (mono) o.data[q] = o.data[q + 1] = o.data[q + 2] = rb(dz(lumaOf(d, q), thr));
      else for (let c = 0; c < 3; c++) o.data[q + c] = rb(dz(d[q + c], thr));
      o.data[q + 3] = d[q + 3];
    }
    return o;
  },
  bilateral(img, { sigmaSpace, sigmaColor }) {
    const { width: w, height: h, data: d } = img; const o = out(img); const r = Math.ceil(2 * sigmaSpace);
    const ks = 1 / (2 * sigmaSpace * sigmaSpace), kc = 1 / (2 * sigmaColor * sigmaColor);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4; const r0 = d[q], g0 = d[q + 1], b0 = d[q + 2];
      let a0 = 0, a1 = 0, a2 = 0, ws = 0;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const s = (cl(y + j, 0, h - 1) * w + cl(x + i, 0, w - 1)) * 4;
        const dr = d[s] - r0, dg = d[s + 1] - g0, db = d[s + 2] - b0;
        const wt = Math.exp(-(i * i + j * j) * ks - (dr * dr + dg * dg + db * db) * kc);
        a0 += wt * d[s]; a1 += wt * d[s + 1]; a2 += wt * d[s + 2]; ws += wt;
      }
      o.data[q] = rb(a0 / ws); o.data[q + 1] = rb(a1 / ws); o.data[q + 2] = rb(a2 / ws); o.data[q + 3] = d[q + 3];
    }
    return o;
  },
};

/** reference(op, img, params) → img (params validated exactly like the GPU kernels) */
export function reference(op, img, params) { return impl[op](img, normParams(op, params)); }

/** per-channel comparison of two imgs → {max, mean, over1 (pixels·channels differing by more than 1)} */
export function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { max: Infinity, mean: Infinity, over1: -1, sizeMismatch: `${a.width}×${a.height} vs ${b.width}×${b.height}` };
  let max = 0, sum = 0, over1 = 0; const maxCh = [0, 0, 0, 0];
  for (let i = 0; i < a.data.length; i++) { const e = Math.abs(a.data[i] - b.data[i]); if (e > max) max = e; if (e > maxCh[i & 3]) maxCh[i & 3] = e; if (e > 1) over1++; sum += e; }
  return { max, maxPerChannel: maxCh, mean: +(sum / a.data.length).toFixed(5), over1 };
}

/** deterministic test image: gradients, hard edges, texture, varying alpha — exercises every kernel. */
export function testImage(w, h, seed = 1) {
  const data = new Uint8ClampedArray(w * h * 4); let s = seed >>> 0 || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const q = (y * w + x) * 4; const u = x / Math.max(1, w - 1), v = y / Math.max(1, h - 1);
    let r = 255 * u, g = 255 * v, b = 127.5 + 127.5 * Math.sin((x * 0.37 + y * 0.21));
    if (((x >> 4) + (y >> 4)) & 1) { r = 255 - r; b *= 0.5; }               // checker → hard edges
    let n = (rnd() - 0.5) * 40;
    const dx = x - w * 0.5, dy = y - h * 0.5; if (dx * dx + dy * dy < (Math.min(w, h) * 0.2) ** 2) { r = g = b = (x + y) & 1 ? 128 : 127; n = 0; } // exact grays either side of t=128
    data[q] = r + n; data[q + 1] = g + n * 0.5; data[q + 2] = b - n; data[q + 3] = x < w / 8 ? 255 * v : 255;
  }
  return { width: w, height: h, data };
}
