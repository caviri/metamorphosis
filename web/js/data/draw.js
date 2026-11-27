// data/draw — canvas charts in a dark terminal style, for vision models: plain marks, readable axes, values in text ink.
import { canvasOf } from '../img.js';

export const THEME = {
  bg: '#0b0b0b', panel: '#111311', ink: '#efefef', dim: '#9c9c9c', grid: '#262a26', axis: '#474747',
  // categorical order (fixed, never cycled): blue, orange, aqua, yellow, magenta, green, violet, red
  series: ['#338ced', '#e76624', '#00a888', '#d28e05', '#e24d8b', '#0aac23', '#9887ef', '#eb6263'],
  font: (px, bold) => `${bold ? '600 ' : ''}${px}px ui-monospace, "Cascadia Mono", Consolas, "DejaVu Sans Mono", Menlo, monospace`,
};

export function fmtNum(v, step) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e12 || a < 1e-4) return v.toExponential(2).replace(/\.?0+e/, 'e');
  for (const [k, s] of [[1e9, 'G'], [1e6, 'M'], [1e3, 'k']]) if (a >= k * 10 || (a >= k && k >= 1e6)) { const x = v / k; return `${Number(x.toPrecision(3))}${s}`; }
  if (step !== undefined && step > 0) { const d = Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9))); return v.toFixed(d).replace(/^-0(\.0+)?$/, '0'); }
  return String(Number(v.toPrecision(4)));
}
export function niceTicks(min, max, n = 6) {
  if (!(max > min)) { const p = Math.abs(min) || 1; min -= p * 0.5; max += p * 0.5; }
  const raw = (max - min) / Math.max(1, n - 1); const mag = 10 ** Math.floor(Math.log10(raw)); const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step + 1e-9) * step; const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks = []; for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  return { ticks, lo, hi, step };
}
const fmtTime = (ms, span) => { const s = new Date(ms).toISOString(); return span > 2 * 365 * 864e5 ? s.slice(0, 7) : span > 3 * 864e5 ? s.slice(0, 10) : span > 864e5 ? s.slice(5, 16).replace('T', ' ') : s.slice(11, 19); };
const clip = (g, text, maxW) => { if (g.measureText(text).width <= maxW) return text; let t = text; while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; };

function frame(width, height, { title, subtitle, legend }) {
  const c = canvasOf(width, height); const g = c.getContext('2d');
  g.fillStyle = THEME.bg; g.fillRect(0, 0, width, height);
  let y = 14;
  if (title) { g.font = THEME.font(16, true); g.fillStyle = THEME.ink; g.textBaseline = 'top'; g.textAlign = 'left'; g.fillText(clip(g, title, width - 32), 16, y); y += 24; }
  if (subtitle) { g.font = THEME.font(12); g.fillStyle = THEME.dim; g.textBaseline = 'top'; g.textAlign = 'left'; g.fillText(clip(g, subtitle, width - 32), 16, y); y += 18; }
  if (legend && legend.length > 1) {
    g.font = THEME.font(12); g.textBaseline = 'middle'; let x = 16; y += 4;
    for (const [i, name] of legend.entries()) {
      const label = clip(g, String(name), 220); const w = 18 + g.measureText(label).width + 18;
      if (x + w > width - 16) { x = 16; y += 18; }
      g.fillStyle = THEME.series[i]; g.fillRect(x, y + 2, 12, 12); g.fillStyle = THEME.dim; g.textAlign = 'left'; g.fillText(label, x + 18, y + 9); x += w;
    }
    y += 22;
  }
  return { c, g, top: y + 8 };
}

/** draws y grid + labels, returns the pixel mapper */
function yAxis(g, plot, yt, label) {
  g.font = THEME.font(12); g.textBaseline = 'middle'; g.textAlign = 'right';
  const map = (v) => plot.y + plot.h - ((v - yt.lo) / (yt.hi - yt.lo)) * plot.h;
  for (const t of yt.ticks) { const y = Math.round(map(t)) + 0.5; g.strokeStyle = t === 0 ? THEME.axis : THEME.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(plot.x, y); g.lineTo(plot.x + plot.w, y); g.stroke(); g.fillStyle = THEME.dim; g.fillText(fmtNum(t, yt.step), plot.x - 8, y); }
  if (label) { g.save(); g.translate(14, plot.y + plot.h / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'top'; g.fillStyle = THEME.dim; g.fillText(clip(g, label, plot.h), 0, 0); g.restore(); }
  return map;
}
function xAxisNumeric(g, plot, xt, label, fmt) {
  g.font = THEME.font(12); g.textBaseline = 'top'; g.textAlign = 'center';
  const map = (v) => plot.x + ((v - xt.lo) / (xt.hi - xt.lo)) * plot.w;
  for (const t of xt.ticks) { const x = Math.round(map(t)) + 0.5; g.strokeStyle = THEME.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(x, plot.y); g.lineTo(x, plot.y + plot.h); g.stroke(); g.fillStyle = THEME.dim; g.fillText(fmt ? fmt(t) : fmtNum(t, xt.step), x, plot.y + plot.h + 8); }
  g.strokeStyle = THEME.axis; g.beginPath(); g.moveTo(plot.x, plot.y + plot.h + 0.5); g.lineTo(plot.x + plot.w, plot.y + plot.h + 0.5); g.stroke();
  if (label) { g.fillStyle = THEME.dim; g.textAlign = 'center'; g.fillText(clip(g, label, plot.w), plot.x + plot.w / 2, plot.y + plot.h + 28); }
  return map;
}
const yLabelWidth = (g, yt) => { g.font = THEME.font(12); return Math.max(...yt.ticks.map((t) => g.measureText(fmtNum(t, yt.step)).width)); };
const extent = (arrs, zero) => { let lo = Infinity; let hi = -Infinity; for (const a of arrs) for (const v of a) if (typeof v === 'number' && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } if (lo === Infinity) { lo = 0; hi = 1; } if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); } return [lo, hi]; };

/** horizontal bars: labels[], series [{name, values[]}] */
export function barChart({ labels, series, title, subtitle, xLabel, yLabel, width = 1000, height }) {
  const n = labels.length; const k = series.length;
  const rowH = Math.max(18, Math.min(34, k * 14 + 8));
  const { c: probe } = { c: canvasOf(1, 1) }; const pg = probe.getContext('2d'); pg.font = THEME.font(12);
  const labW = Math.min(width * 0.32, Math.max(40, ...labels.map((l) => pg.measureText(String(l)).width)) + 4);
  const legendRows = k > 1 ? 1 : 0; const head = (title ? 24 : 0) + (subtitle ? 18 : 0) + legendRows * 26 + 22;
  height = height || Math.min(2400, head + n * rowH + 64);
  const { c, g, top } = frame(width, height, { title, subtitle, legend: series.map((s) => s.name) });
  const plot = { x: 16 + labW + 10 + (yLabel ? 18 : 0), y: top, w: 0, h: 0 }; plot.w = width - plot.x - 70; plot.h = height - top - (xLabel ? 52 : 34);
  const [lo, hi] = extent(series.map((s) => s.values), true); const xt = niceTicks(lo, hi, Math.max(3, Math.floor(plot.w / 110)));
  const map = xAxisNumeric(g, plot, xt, xLabel);
  const band = plot.h / Math.max(1, n); const barH = Math.max(2, Math.min(22, (band - 6) / k - (k > 1 ? 2 : 0)));
  g.font = THEME.font(12);
  for (let i = 0; i < n; i++) {
    const cy = plot.y + band * i + band / 2;
    g.fillStyle = THEME.ink; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(clip(g, String(labels[i]), labW), plot.x - 10, cy);
    for (let s = 0; s < k; s++) {
      const v = series[s].values[i]; if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const y = cy - (k * (barH + 2) - 2) / 2 + s * (barH + 2); const x0 = map(0); const x1 = map(v);
      g.fillStyle = THEME.series[s]; const r = Math.min(3, barH / 2); const w = x1 - x0;
      g.beginPath(); if (g.roundRect && Math.abs(w) > r) g.roundRect(Math.min(x0, x1), y, Math.abs(w), barH, w >= 0 ? [0, r, r, 0] : [r, 0, 0, r]); else g.rect(Math.min(x0, x1), y, Math.max(1, Math.abs(w)), barH); g.fill();
      if (barH >= 9) { g.fillStyle = THEME.dim; g.textAlign = w >= 0 ? 'left' : 'right'; g.font = THEME.font(11); g.fillText(fmtNum(v), x1 + (w >= 0 ? 5 : -5), y + barH / 2 + 0.5); g.font = THEME.font(12); }
    }
  }
  g.strokeStyle = THEME.axis; g.lineWidth = 1; const zx = Math.round(map(0)) + 0.5; g.beginPath(); g.moveTo(zx, plot.y); g.lineTo(zx, plot.y + plot.h); g.stroke();
  if (yLabel) { g.save(); g.translate(14, plot.y + plot.h / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'top'; g.fillStyle = THEME.dim; g.fillText(clip(g, yLabel, plot.h), 0, 0); g.restore(); }
  return c;
}

/** line / scatter: x {kind:'number'|'time'|'category', values[], labels?}, series [{name, values[]}] */
export function xyChart({ kind, x, series, title, subtitle, xLabel, yLabel, width = 1000, height = 600 }) {
  const { c, g, top } = frame(width, height, { title, subtitle, legend: series.map((s) => s.name) });
  const [ylo, yhi] = extent(series.map((s) => s.values), false);
  const pad = (yhi - ylo) * 0.04; const yt = niceTicks(ylo - (ylo >= 0 && ylo - pad < 0 ? 0 : pad), yhi + pad, Math.max(3, Math.floor((height - top) / 70)));
  const plot = { x: 16 + (yLabel ? 20 : 0) + yLabelWidth(g, yt) + 12, y: top, w: 0, h: height - top - (xLabel ? 56 : 38) }; plot.w = width - plot.x - 28;
  const my = yAxis(g, plot, yt, yLabel);
  let mx;
  if (x.kind === 'category') {
    const n = x.values.length; const stepPx = plot.w / Math.max(1, n - 1 || 1);
    mx = (i) => (n === 1 ? plot.x + plot.w / 2 : plot.x + i * stepPx);
    g.font = THEME.font(12); g.textBaseline = 'top'; g.textAlign = 'center';
    const maxLab = Math.max(1, Math.floor(plot.w / 90)); const every = Math.max(1, Math.ceil(n / maxLab));
    for (let i = 0; i < n; i += every) { const px = Math.round(mx(i)) + 0.5; g.strokeStyle = THEME.grid; g.beginPath(); g.moveTo(px, plot.y); g.lineTo(px, plot.y + plot.h); g.stroke(); g.fillStyle = THEME.dim; g.fillText(clip(g, String(x.labels[i]), 84), px, plot.y + plot.h + 8); }
    g.strokeStyle = THEME.axis; g.beginPath(); g.moveTo(plot.x, plot.y + plot.h + 0.5); g.lineTo(plot.x + plot.w, plot.y + plot.h + 0.5); g.stroke();
    if (xLabel) { g.fillStyle = THEME.dim; g.fillText(clip(g, xLabel, plot.w), plot.x + plot.w / 2, plot.y + plot.h + 28); }
  } else {
    const [xlo, xhi] = extent([x.values], false);
    let xt;
    if (x.kind === 'time') { const span = xhi - xlo || 864e5; const n = Math.max(2, Math.floor(plot.w / 130)); const ticks = Array.from({ length: n + 1 }, (_, i) => xlo + (span * i) / n); xt = { ticks, lo: xlo, hi: xlo + span, step: span / n }; mx = xAxisNumeric(g, plot, xt, xLabel, (t) => fmtTime(t, span)); } else { const xp = (xhi - xlo) * 0.02; xt = niceTicks(xlo - xp, xhi + xp, Math.max(3, Math.floor(plot.w / 110))); mx = xAxisNumeric(g, plot, xt, xLabel); }
    const base = mx; mx = (i) => base(x.values[i]);
  }
  g.save(); g.beginPath(); g.rect(plot.x - 6, plot.y - 6, plot.w + 12, plot.h + 12); g.clip();
  const n = x.values.length;
  series.forEach((s, si) => {
    const col = THEME.series[si];
    if (kind === 'line') {
      g.strokeStyle = col; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath(); let pen = false;
      for (let i = 0; i < n; i++) { const v = s.values[i]; const xv = x.kind === 'category' ? i : x.values[i]; if (typeof v !== 'number' || !Number.isFinite(v) || xv === null || Number.isNaN(xv)) { pen = false; continue; } const px = mx(i); const py = my(v); if (pen) g.lineTo(px, py); else { g.moveTo(px, py); pen = true; } }
      g.stroke();
      if (n <= 60) { for (let i = 0; i < n; i++) { const v = s.values[i]; if (typeof v !== 'number' || !Number.isFinite(v)) continue; g.fillStyle = col; g.strokeStyle = THEME.bg; g.lineWidth = 2; g.beginPath(); g.arc(mx(i), my(v), 4, 0, 7); g.fill(); g.stroke(); } }
    } else {
      const r = n > 2000 ? 2 : n > 300 ? 3 : 4; g.fillStyle = col; g.globalAlpha = n > 2000 ? 0.45 : n > 300 ? 0.65 : 0.9;
      for (let i = 0; i < n; i++) { const v = s.values[i]; const xv = x.kind === 'category' ? i : x.values[i]; if (typeof v !== 'number' || !Number.isFinite(v) || xv === null || Number.isNaN(xv)) continue; g.beginPath(); g.arc(mx(i), my(v), r, 0, 7); g.fill(); }
      g.globalAlpha = 1;
    }
  });
  g.restore();
  return c;
}

/** histogram: edges[] (n+1), counts[] (n) */
export function histChart({ edges, counts, title, subtitle, xLabel, yLabel = 'count', width = 1000, height = 600, color = 0 }) {
  const { c, g, top } = frame(width, height, { title, subtitle });
  const yt = niceTicks(0, Math.max(1, ...counts), Math.max(3, Math.floor((height - top) / 70)));
  const plot = { x: 16 + (yLabel ? 20 : 0) + yLabelWidth(g, yt) + 12, y: top, w: 0, h: height - top - (xLabel ? 56 : 38) }; plot.w = width - plot.x - 28;
  const my = yAxis(g, plot, yt, yLabel);
  const lo = edges[0]; const hi = edges[edges.length - 1]; const xt = niceTicks(lo, hi, Math.max(3, Math.floor(plot.w / 110)));
  const xl = Math.min(xt.lo, lo); const xh = Math.max(xt.hi, hi); const scale = { ticks: xt.ticks, lo: xl, hi: xh, step: xt.step };
  const mx = xAxisNumeric(g, plot, scale, xLabel);
  g.fillStyle = THEME.series[color];
  for (let i = 0; i < counts.length; i++) { if (!counts[i]) continue; const x0 = mx(edges[i]); const x1 = mx(edges[i + 1]); const y = my(counts[i]); const gap = x1 - x0 > 4 ? 1 : 0; g.fillRect(x0 + gap, y, Math.max(1, x1 - x0 - gap * 2), plot.y + plot.h - y); }
  return c;
}

/** entropy strip: one bar per block, height and brightness = entropy (0..8 bits/byte), dashed line at the 7.5 "compressed/encrypted" level */
export function entropyStrip({ blocks, blockSize, total, title, width = 1024, height = 240 }) {
  const { c, g, top } = frame(width, height, { title, subtitle: `Shannon entropy per ${blockSize}-byte block · bits/byte · dashed line = 7.5 (compressed or encrypted above it)` });
  const yt = { ticks: [0, 2, 4, 6, 8], lo: 0, hi: 8, step: 2 };
  const plot = { x: 48, y: top, w: width - 48 - 20, h: height - top - 36 };
  const my = yAxis(g, plot, yt, null);
  const n = blocks.length; const bw = plot.w / n;
  // sequential single-hue ramp (dark → light blue) on the dark surface
  const ramp = (t) => { const a = [18, 52, 110]; const b = [142, 200, 255]; const k = Math.max(0, Math.min(1, t)); return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * k)).join(',')})`; };
  for (let px = 0; px < plot.w; px++) {
    const i0 = Math.floor(px / bw); const i1 = Math.max(i0 + 1, Math.floor((px + 1) / bw)); let m = 0; for (let i = i0; i < i1 && i < n; i++) if (blocks[i] > m) m = blocks[i];
    const y = my(m); g.fillStyle = ramp(m / 8); g.fillRect(plot.x + px, y, 1, plot.y + plot.h - y);
  }
  g.setLineDash([6, 4]); g.strokeStyle = THEME.dim; g.lineWidth = 1; const ty = Math.round(my(7.5)) + 0.5; g.beginPath(); g.moveTo(plot.x, ty); g.lineTo(plot.x + plot.w, ty); g.stroke(); g.setLineDash([]);
  g.font = THEME.font(12); g.textBaseline = 'top'; g.fillStyle = THEME.dim;
  for (let k = 0; k <= 4; k++) { const off = Math.round((total * k) / 4); const x = plot.x + (plot.w * k) / 4; g.textAlign = k === 0 ? 'left' : k === 4 ? 'right' : 'center'; g.fillText(`0x${off.toString(16)}`, x, plot.y + plot.h + 8); g.strokeStyle = THEME.axis; g.beginPath(); g.moveTo(Math.round(x) + 0.5, plot.y + plot.h); g.lineTo(Math.round(x) + 0.5, plot.y + plot.h + 5); g.stroke(); }
  return c;
}

/** 256-bar byte-value histogram */
export function byteHistChart({ counts, title, log = false, width = 1024, height = 420 }) {
  const { c, g, top } = frame(width, height, { title, subtitle: `occurrences of each byte value 0x00–0xFF${log ? ' · log scale' : ''}` });
  const max = Math.max(1, ...counts); const f = (v) => (log ? Math.log10(v + 1) : v); const top_ = f(max);
  const yt = log ? { ticks: Array.from({ length: Math.ceil(top_) + 1 }, (_, i) => i), lo: 0, hi: Math.max(1, Math.ceil(top_)), step: 1 } : niceTicks(0, max, 5);
  g.font = THEME.font(12); const lw = Math.max(...yt.ticks.map((t) => g.measureText(log ? fmtNum(10 ** t) : fmtNum(t, yt.step)).width));
  const plot = { x: 16 + lw + 12, y: top, w: 0, h: height - top - 40 }; plot.w = Math.floor((width - plot.x - 20) / 256) * 256;
  const map = (v) => plot.y + plot.h - ((v - yt.lo) / (yt.hi - yt.lo)) * plot.h;
  g.textBaseline = 'middle'; g.textAlign = 'right';
  for (const t of yt.ticks) { const y = Math.round(map(t)) + 0.5; g.strokeStyle = t === 0 ? THEME.axis : THEME.grid; g.beginPath(); g.moveTo(plot.x, y); g.lineTo(plot.x + plot.w, y); g.stroke(); g.fillStyle = THEME.dim; g.fillText(log ? (t === 0 ? '0' : fmtNum(10 ** t)) : fmtNum(t, yt.step), plot.x - 8, y); }
  const bw = plot.w / 256; g.fillStyle = THEME.series[0];
  for (let i = 0; i < 256; i++) { if (!counts[i]) continue; const y = map(f(counts[i])); g.fillRect(plot.x + i * bw, Math.min(y, plot.y + plot.h - 1), Math.max(1, bw - (bw >= 3 ? 1 : 0)), Math.max(1, plot.y + plot.h - y)); }
  g.textBaseline = 'top'; g.fillStyle = THEME.dim;
  for (const v of [0, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0, 0xff]) { const x = plot.x + (v + 0.5) * bw; g.textAlign = 'center'; g.fillText(`0x${v.toString(16).padStart(2, '0').toUpperCase()}`, x, plot.y + plot.h + 8); g.strokeStyle = THEME.axis; g.beginPath(); g.moveTo(Math.round(x) + 0.5, plot.y + plot.h); g.lineTo(Math.round(x) + 0.5, plot.y + plot.h + 5); g.stroke(); }
  return c;
}
