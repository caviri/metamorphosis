// μεταμόρφωσις :: audio/plot — colour maps, tick maths and axis drawing for spectrograms and waveforms.

const MAPS = {
  magma: [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]],
  inferno: [[0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85], [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164]],
  viridis: [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]],
  phosphor: [[0, 0, 0], [0, 28, 9], [0, 62, 20], [2, 104, 36], [12, 156, 56], [51, 255, 102], [214, 255, 224]],
  amber: [[0, 0, 0], [40, 18, 0], [92, 44, 0], [158, 84, 0], [226, 132, 0], [255, 176, 0], [255, 236, 190]],
  gray: [[0, 0, 0], [255, 255, 255]],
  ink: [[255, 255, 255], [0, 0, 0]],
};
export const COLORMAPS = Object.keys(MAPS);
const luts = new Map();
/** 256-entry RGB lookup table (Uint8Array(768)) */
export function lut(name) {
  if (luts.has(name)) return luts.get(name);
  const pts = MAPS[name]; if (!pts) throw new Error(`unknown colormap "${name}" — one of ${COLORMAPS.join(' | ')}`);
  const t = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const x = i / 255 * (pts.length - 1), k = Math.min(pts.length - 2, Math.floor(x)), f = x - k;
    for (let c = 0; c < 3; c++) t[i * 3 + c] = Math.round(pts[k][c] + (pts[k + 1][c] - pts[k][c]) * f);
  }
  luts.set(name, t);
  return t;
}
/** page colours that go with a colour map */
export function theme(name) {
  if (name === 'phosphor') return { bg: '#000000', fg: '#33ff66', dim: '#1c8f3c', grid: 'rgba(51,255,102,0.22)', wave: '#33ff66', rms: '#d6ffe0', zero: 'rgba(51,255,102,0.45)' };
  if (name === 'amber') return { bg: '#000000', fg: '#ffb000', dim: '#9e5400', grid: 'rgba(255,176,0,0.22)', wave: '#ffb000', rms: '#ffecbe', zero: 'rgba(255,176,0,0.45)' };
  if (name === 'ink' || name === 'light') return { bg: '#ffffff', fg: '#111111', dim: '#666666', grid: 'rgba(0,0,0,0.16)', wave: '#1f4fa8', rms: '#e2792b', zero: 'rgba(0,0,0,0.4)' };
  return { bg: '#0b0b10', fg: '#e8e8ee', dim: '#9a9aa6', grid: 'rgba(255,255,255,0.16)', wave: '#5ab0ff', rms: '#ffd166', zero: 'rgba(255,255,255,0.4)' };
}

/** "nice" tick step (1/2/5 × 10^k) giving about `target` ticks over `range` */
export function niceStep(range, target = 8) {
  const raw = range / Math.max(1, target), p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
export function linTicks(lo, hi, target) {
  const step = niceStep(hi - lo, target), out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { step, ticks: out };
}
export const fmtHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f % 1000 === 0 ? 0 : f >= 10000 ? 1 : 2)}k` : `${+f.toFixed(f < 10 ? 1 : 0)}`);
export function fmtTime(t, step) {
  if (step >= 60 || t >= 600) { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${(step < 1 ? s.toFixed(1) : String(Math.round(s))).padStart(step < 1 ? 4 : 2, '0')}`; }
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4;
  return t.toFixed(d);
}

// frequency-axis scales: map Hz ↔ a linear "position" unit
export const SCALES = {
  linear: { f: (hz) => hz, inv: (u) => u },
  log: { f: (hz) => Math.log(hz), inv: (u) => Math.exp(u) },
  mel: { f: (hz) => 2595 * Math.log10(1 + hz / 700), inv: (u) => 700 * (10 ** (u / 2595) - 1) },
};
export function freqTicks(scale, fmin, fmax, plotH) {
  const n = Math.max(3, Math.floor(plotH / 34));
  if (scale === 'linear') return linTicks(fmin, fmax, n).ticks.filter((f) => f >= fmin && f <= fmax);
  const cands = [];
  for (let d = 1; d <= 100000; d *= 10) for (const m of scale === 'log' ? [1, 2, 5] : [1, 1.5, 2, 3, 4, 5, 6, 8]) cands.push(m * d);
  let ticks = cands.filter((f) => f >= fmin && f <= fmax);
  if (scale === 'mel' && fmin <= 0) ticks.unshift(0);
  // thin out labels that would collide (keep ≥ 15 px apart)
  const S = SCALES[scale], u0 = S.f(Math.max(fmin, scale === 'log' ? 1e-6 : 0)), u1 = S.f(fmax);
  const y = (f) => (1 - (S.f(f) - u0) / (u1 - u0)) * plotH;
  const out = []; let last = Infinity;
  for (const f of ticks) { const py = y(f); if (last - py >= 15) { out.push(f); last = py; } }
  return out;
}

export const FONT = (px, bold) => `${bold ? 'bold ' : ''}${px}px ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace`;

/** time axis (ticks + labels below a plot rect) */
export function drawTimeAxis(g, th, rect, t0, t1, { labels = true, grid = false, fontPx = 12 } = {}) {
  const { step, ticks } = linTicks(t0, t1, Math.max(2, Math.floor(rect.w / 90)));
  g.font = FONT(fontPx); g.textBaseline = 'top'; g.textAlign = 'center'; g.lineWidth = 1;
  for (const t of ticks) {
    const x = Math.round(rect.x + (t - t0) / (t1 - t0) * rect.w) + 0.5;
    if (x < rect.x - 1 || x > rect.x + rect.w + 1) continue;
    if (grid) { g.strokeStyle = th.grid; g.beginPath(); g.moveTo(x, rect.y); g.lineTo(x, rect.y + rect.h); g.stroke(); }
    g.strokeStyle = th.fg; g.beginPath(); g.moveTo(x, rect.y + rect.h); g.lineTo(x, rect.y + rect.h + 5); g.stroke();
    if (labels) { const txt = fmtTime(t, step), hw = g.measureText(txt).width / 2 + 2, cw = g.canvas.width; g.fillStyle = th.fg; g.fillText(txt, Math.min(cw - hw, Math.max(hw, x)), rect.y + rect.h + 7); }
  }
  return { step, unit: step >= 60 || t1 >= 600 ? 'm:ss' : 's' };
}
export function frame(g, th, rect) { g.strokeStyle = th.fg; g.lineWidth = 1; g.strokeRect(rect.x - 0.5, rect.y - 0.5, rect.w + 1, rect.h + 1); }
