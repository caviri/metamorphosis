// μεταμόρφωσις :: geo/render — draw a FeatureCollection as a map (canvas → PNG, or SVG) and elevation charts.
// No tiles, no network: context comes from the vendored Natural Earth 110m basemap.
import { RAD, DEG, haversine, wrapLon, MERC_MAX_LAT } from './geodesy.js';
import { eachPart, unwrap, bboxOf, bboxSpan, centroidOf } from './ops.js';
import { readTopo } from './formats.js';
import { canvasOf } from '../img.js';

export const PROJECTIONS = ['equirectangular', 'mercator', 'equalearth', 'orthographic', 'laea'];
const MONO = 'ui-monospace, "Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace';

export const THEMES = {
  dark: {
    ground: '#050806', ocean: '#07100b', land: '#0e2418', coast: '#2fa862', border: '#1d6039', grat: '#15402a', frame: '#2fa862',
    text: '#a8f5c8', dim: '#58a77c', halo: '#050806', data: '#ffb000', noData: '#3a4540', other: '#7d8a84',
    seq: ['#0e3d7e', '#1757ac', '#2370cd', '#338ced', '#6aabf1', '#9dc8f7', '#cce3fd'],
    cat: ['#338ced', '#e76624', '#00a888', '#d28e05', '#e24d8b', '#0aac23', '#9887ef', '#eb6263'],
  },
  light: {
    ground: '#ffffff', ocean: '#f3f6f9', land: '#e8e5da', coast: '#6f6e66', border: '#b9b5a8', grat: '#d3dae1', frame: '#444444',
    text: '#151515', dim: '#5d5d5d', halo: '#ffffff', data: '#c2410c', noData: '#d0d0d0', other: '#8c8c8c',
    seq: ['#cce3fd', '#9dc8f7', '#6aabf1', '#338ced', '#2370cd', '#1757ac', '#0e3d7e'],
    cat: ['#257de0', '#f47230', '#00b894', '#f2a600', '#ee7fac', '#008a17', '#6a4ce2', '#ec4647'],
  },
};

// ────────────────────────────────────────────────────────── basemap ──
let basemapP;
/** {countries: FeatureCollection, land: FeatureCollection} — fetched once, on first use */
export function loadBasemap() {
  return (basemapP ||= (async () => {
    const url = new URL('../../vendor/world-atlas/countries-110m.json', import.meta.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`basemap not found at ${url.pathname} (HTTP ${res.status})`);
    const topo = await res.json();
    return { countries: readTopo(topo, 'countries').fc, land: readTopo(topo, 'land').fc };
  })().catch((e) => { basemapP = null; throw e; }));
}

// ────────────────────────────────────────────────────── projections ──
const EE = { A1: 1.340264, A2: -0.081106, A3: 0.000893, A4: 0.003796, M: Math.sqrt(3) / 2 };
/**
 * projection(kind, lon0, lat0) → {cyl, R, fwd(lon, lat) → [X, Y], inv(X, Y) → [lon, lat] | null, hidden(lon, lat)}
 * Cylindrical kinds take longitudes that may run past ±180 (unwrapped lines); azimuthal kinds rotate the globe to (lon0, lat0).
 */
export function projection(kind, lon0 = 0, lat0 = 0) {
  if (kind === 'equirectangular') return { kind, cyl: true, lon0, lat0: 0, fwd: (l, p) => [(l - lon0) * RAD, p * RAD], inv: (x, y) => (Math.abs(y) > Math.PI / 2 + 1e-9 ? null : [x * DEG + lon0, y * DEG]), ymax: Math.PI / 2 };
  if (kind === 'mercator') {
    const ymax = Math.log(Math.tan(Math.PI / 4 + MERC_MAX_LAT * RAD / 2));
    return { kind, cyl: true, lon0, lat0: 0, ymax, fwd: (l, p) => [(l - lon0) * RAD, Math.log(Math.tan(Math.PI / 4 + Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, p)) * RAD / 2))], inv: (x, y) => (Math.abs(y) > ymax + 1e-9 ? null : [x * DEG + lon0, (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * DEG]) };
  }
  if (kind === 'equalearth') {
    const { A1, A2, A3, A4, M } = EE;
    const fy = (t) => t * (A1 + A2 * t * t + t ** 6 * (A3 + A4 * t * t)), dfy = (t) => A1 + 3 * A2 * t * t + t ** 6 * (7 * A3 + 9 * A4 * t * t);
    const ymax = fy(Math.asin(M));
    return { kind, cyl: true, lon0, lat0: 0, ymax,
      fwd: (l, p) => { const t = Math.asin(M * Math.sin(Math.max(-90, Math.min(90, p)) * RAD)); return [(l - lon0) * RAD * Math.cos(t) / (M * dfy(t)), fy(t)]; },
      inv: (x, y) => { if (Math.abs(y) > ymax + 1e-9) return null; let t = y; for (let i = 0; i < 12; i++) { const d = (fy(t) - y) / dfy(t); t -= d; if (Math.abs(d) < 1e-12) break; } const lam = M * x * dfy(t) / Math.cos(t); if (Math.abs(lam) > Math.PI + 1e-9) return null; return [lam * DEG + lon0, Math.asin(Math.max(-1, Math.min(1, Math.sin(t) / M))) * DEG]; } };
  }
  if (kind === 'orthographic' || kind === 'laea') {
    const ortho = kind === 'orthographic', p0 = lat0 * RAD, s0 = Math.sin(p0), c0 = Math.cos(p0), R = ortho ? 1 : 2;
    const fwd = (l, p) => {
      const dl = (l - lon0) * RAD, ph = p * RAD, cp = Math.cos(ph), sp = Math.sin(ph), cdl = Math.cos(dl);
      const cosc = s0 * sp + c0 * cp * cdl; let x = cp * Math.sin(dl), y = c0 * sp - s0 * cp * cdl;
      if (ortho) {
        if (cosc >= 0) return [x, y];
        // far side: push it outside the disc (continuous azimuthal extension) so paths stay connected and the disc clip hides it
        const h = Math.hypot(x, y), r = 1 + (Math.acos(Math.max(-1, cosc)) - Math.PI / 2);
        return h < 1e-12 ? [0, -r] : [x / h * r, y / h * r];
      }
      const k = Math.sqrt(2 / Math.max(1e-9, 1 + cosc)); if (1 + cosc < 1e-9) { const h = Math.hypot(x, y) || 1; return [x / h * 2, y / h * 2]; }
      return [x * k, y * k];
    };
    const inv = (x, y) => {
      const rho = Math.hypot(x, y); if (rho > R + 1e-9) return null; if (rho < 1e-12) return [lon0, lat0];
      const c = ortho ? Math.asin(Math.min(1, rho)) : 2 * Math.asin(Math.min(1, rho / 2)), sc = Math.sin(c), cc = Math.cos(c);
      return [wrapLon(lon0 + Math.atan2(x * sc, rho * c0 * cc - y * s0 * sc) * DEG), Math.asin(Math.max(-1, Math.min(1, cc * s0 + y * sc * c0 / rho))) * DEG];
    };
    const hidden = ortho ? (l, p) => s0 * Math.sin(p * RAD) + c0 * Math.cos(p * RAD) * Math.cos((l - lon0) * RAD) < 0 : () => false;
    return { kind, cyl: false, lon0, lat0, R, fwd, inv, hidden };
  }
  throw new Error(`unknown projection "${kind}" — accepted: ${PROJECTIONS.join(', ')}`);
}

// ───────────────────────────────────────────────────── svg recorder ──
// The subset of CanvasRenderingContext2D the painters use, emitting SVG text instead of pixels.
class SvgCtx {
  constructor(w, h) { this.w = w; this.h = h; this.out = []; this.d = ''; this.stack = []; this.open = 0; this.clipN = 0; this.fillStyle = '#000'; this.strokeStyle = '#000'; this.lineWidth = 1; this.font = `12px ${MONO}`; this.textAlign = 'left'; this.textBaseline = 'alphabetic'; this.globalAlpha = 1; this.lineJoin = 'miter'; this.lineCap = 'butt'; this.dash = []; }
  n(v) { return +v.toFixed(2); }
  save() { this.stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline, globalAlpha: this.globalAlpha, lineJoin: this.lineJoin, lineCap: this.lineCap, dash: this.dash, open: this.open }); }
  restore() { const s = this.stack.pop(); if (!s) return; while (this.open > s.open) { this.out.push('</g>'); this.open--; } Object.assign(this, s); }
  beginPath() { this.d = ''; }
  moveTo(x, y) { this.d += `M${this.n(x)} ${this.n(y)}`; }
  lineTo(x, y) { this.d += `L${this.n(x)} ${this.n(y)}`; }
  closePath() { this.d += 'Z'; }
  rect(x, y, w, h) { this.d += `M${this.n(x)} ${this.n(y)}h${this.n(w)}v${this.n(h)}h${this.n(-w)}Z`; }
  arc(x, y, r) { this.d += `M${this.n(x + r)} ${this.n(y)}A${this.n(r)} ${this.n(r)} 0 1 0 ${this.n(x - r)} ${this.n(y)}A${this.n(r)} ${this.n(r)} 0 1 0 ${this.n(x + r)} ${this.n(y)}Z`; }
  setLineDash(a) { this.dash = a; }
  op() { return this.globalAlpha < 1 ? ` opacity="${this.globalAlpha}"` : ''; }
  fill(rule) { if (this.d) this.out.push(`<path d="${this.d}" fill="${this.fillStyle}"${rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${this.op()}/>`); }
  stroke() { if (this.d) this.out.push(`<path d="${this.d}" fill="none" stroke="${this.strokeStyle}" stroke-width="${this.n(this.lineWidth)}" stroke-linejoin="${this.lineJoin}" stroke-linecap="${this.lineCap}"${this.dash.length ? ` stroke-dasharray="${this.dash.join(' ')}"` : ''}${this.op()}/>`); }
  clip(rule) { const id = `c${++this.clipN}`; this.out.push(`<clipPath id="${id}"><path d="${this.d}"${rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath><g clip-path="url(#${id})">`); this.open++; }
  fillRect(x, y, w, h) { this.out.push(`<rect x="${this.n(x)}" y="${this.n(y)}" width="${this.n(w)}" height="${this.n(h)}" fill="${this.fillStyle}"${this.op()}/>`); }
  strokeRect(x, y, w, h) { this.out.push(`<rect x="${this.n(x)}" y="${this.n(y)}" width="${this.n(w)}" height="${this.n(h)}" fill="none" stroke="${this.strokeStyle}" stroke-width="${this.n(this.lineWidth)}"/>`); }
  fontParts() { const m = /(bold\s+)?(\d+(?:\.\d+)?)px\s+(.*)$/.exec(this.font) || [0, '', '12', MONO]; return { bold: !!m[1], size: Number(m[2]), family: m[3] }; }
  measureText(s) { return { width: String(s).length * this.fontParts().size * 0.6 }; }
  text(s, x, y, attrs) {
    const f = this.fontParts(); const anchor = { left: 'start', start: 'start', center: 'middle', right: 'end', end: 'end' }[this.textAlign] || 'start';
    const dy = { top: f.size * 0.8, middle: f.size * 0.32, bottom: -f.size * 0.2, alphabetic: 0 }[this.textBaseline] || 0;
    const e = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    this.out.push(`<text x="${this.n(x)}" y="${this.n(y + dy)}" font-family='${f.family.replace(/'/g, '')}' font-size="${f.size}"${f.bold ? ' font-weight="bold"' : ''} text-anchor="${anchor}" ${attrs}${this.op()}>${e}</text>`);
  }
  fillText(s, x, y) { this.text(s, x, y, `fill="${this.fillStyle}"`); }
  strokeText(s, x, y) { this.text(s, x, y, `fill="none" stroke="${this.strokeStyle}" stroke-width="${this.n(this.lineWidth)}" stroke-linejoin="round"`); }
  toString() { while (this.open > 0) { this.out.push('</g>'); this.open--; } return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}">\n${this.out.join('\n')}\n</svg>\n`; }
}
export function surface(w, h, format) {
  if (format === 'svg') { const g = new SvgCtx(w, h); return { g, finish: () => g.toString() }; }
  const c = canvasOf(w, h); const g = c.getContext('2d'); return { g, finish: () => c };
}

// ─────────────────────────────────────────────────────────── helpers ──
const fmtDeg = (v, pos, neg, step) => { const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3; const a = Math.abs(v); return `${a.toFixed(d)}°${a < 1e-9 ? '' : v > 0 ? pos : neg}`; };
export const fmtLon = (v, step = 1) => { const w = wrapLon(v); return Math.abs(Math.abs(w) - 180) < 1e-9 ? '180°' : fmtDeg(w, 'E', 'W', step); };
export const fmtLat = (v, step = 1) => fmtDeg(v, 'N', 'S', step);
export function fmtNum(v) { if (!Number.isFinite(v)) return String(v); const a = Math.abs(v); if (a >= 1e9) return `${+(v / 1e9).toPrecision(3)}G`; if (a >= 1e6) return `${+(v / 1e6).toPrecision(3)}M`; if (a >= 1e4) return `${+(v / 1e3).toPrecision(3)}k`; if (a >= 100 || Number.isInteger(v)) return String(Math.round(v)); return String(+v.toPrecision(3)); }
function niceStep(span, minLines = 6) { for (const s of [30, 15, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001]) if (span / s >= minLines) return s; return 0.0005; }
function niceDistance(m) { const p = 10 ** Math.floor(Math.log10(m)); const f = m / p; return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p; }
function densify(coords, maxStep) {
  if (!maxStep) return coords; const out = [];
  for (let i = 0; i < coords.length; i++) {
    if (i) { const a = coords[i - 1], b = coords[i], d = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); if (d > maxStep) { const n = Math.min(720, Math.ceil(d / maxStep)); for (let k = 1; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); } }
    out.push(coords[i]);
  }
  return out;
}
/** rings → continuous-longitude rings: unwrapped, closed over the pole when they circle it, holes shifted next to the outer ring */
function prepRings(rings, maxStep) {
  const out = []; let ref = null;
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue;
    let r = unwrap(ring);
    const gap = r[r.length - 1][0] - r[0][0];
    if (Math.abs(gap) > 180) { let m = 0; for (const c of r) m += c[1]; const pole = m >= 0 ? 90 : -90; r = r.concat([[r[r.length - 1][0], pole], [r[0][0], pole], [r[0][0], r[0][1]]]); }
    if (ref === null) ref = r[0][0]; else { const sh = Math.round((ref - r[0][0]) / 360) * 360; if (sh) r = r.map((c) => [c[0] + sh, c[1]]); }
    out.push(densify(r, maxStep));
  }
  return out;
}
const pipRing = (x, y, ring) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; };
function prepContains(rings, pt) { for (const dx of [0, -360, 360]) { if (rings.length && pipRing(pt[0] + dx, pt[1], rings[0])) { let hole = false; for (let i = 1; i < rings.length; i++) if (pipRing(pt[0] + dx, pt[1], rings[i])) hole = true; if (!hole) return true; } } return false; }
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
function lerpHex(a, b, t) { const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16); const c = (s) => Math.round(((x >> s) & 255) + (((y >> s) & 255) - ((x >> s) & 255)) * t); return `#${((1 << 24) | (c(16) << 16) | (c(8) << 8) | c(0)).toString(16).slice(1)}`; }
function ramp(stops, n) { if (n === 1) return [stops[Math.floor(stops.length / 2)]]; return Array.from({ length: n }, (_, i) => { const t = i / (n - 1) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)); return lerpHex(stops[k], stops[k + 1], t - k); }); }
function halo(g, th, s, x, y, color) { g.lineWidth = 3; g.strokeStyle = th.halo; g.lineJoin = 'round'; g.strokeText(s, x, y); g.fillStyle = color; g.fillText(s, x, y); }

// ───────────────────────────────────────────────────────────── view ──
/** decide projection centre, visible extent, canvas size and the pixel transform */
function planView(fc, o) {
  const kind = o.projection || 'equirectangular';
  const azi = kind === 'orthographic' || kind === 'laea';
  const bb = fc ? bboxOf(fc) : { bbox: null, count: 0 };
  let box = o.bbox || bb.bbox; let global = !box;
  if (o.bbox && (o.bbox.length !== 4 || o.bbox.some((v) => !Number.isFinite(v)))) throw new Error('bbox must be four numbers: [west, south, east, north]');
  if (o.bbox && o.bbox[1] >= o.bbox[3]) throw new Error('bbox south must be less than north: [west, south, east, north]');
  let lon0, lat0;
  if (o.center) {
    if (o.center.length !== 2 || o.center.some((v) => !Number.isFinite(v))) throw new Error('center must be [lon, lat]');
    [lon0, lat0] = o.center;
    if (!o.bbox) { if (o.span) { const h = o.span / 2, kx = Math.max(0.05, Math.cos(lat0 * RAD)); box = [lon0 - Math.min(180, h / kx), Math.max(-90, lat0 - h), lon0 + Math.min(180, h / kx), Math.min(90, lat0 + h)]; global = o.span >= 180; } else { box = null; global = true; } }
  }
  if (box) {
    let [w, s, e, n] = box; if (e < w) e += 360;
    if (!o.bbox && !(o.center && o.span)) {
      if (bb.count === 1 || (e - w < 1e-9 && n - s < 1e-9)) { w -= 10; e += 10; s -= 7; n += 7; } // a lone point gets regional context
      const px = Math.max((e - w) * 0.06, (n - s) * 0.02, 0.0005), py = Math.max((n - s) * 0.06, (e - w) * 0.02, 0.0005);
      w -= px; e += px; s -= py; n += py;
    }
    s = Math.max(-90, s); n = Math.min(90, n);
    if (e - w >= 300 && !azi) global = true;
    if (azi && (e - w > 170 || n - s > 110)) global = true;
    box = [w, s, e, n];
    if (lon0 === undefined) { lon0 = global && !azi ? 0 : wrapLon((w + e) / 2); lat0 = (s + n) / 2; if (global && azi && e - w > 300) { lon0 = 0; lat0 = Math.abs(lat0) > 45 ? Math.sign(lat0) * 90 : 0; } }
  }
  if (lon0 === undefined) { lon0 = 0; lat0 = 0; }
  const P = projection(kind, lon0, lat0);
  // world outline in plane coordinates
  let world; const outline = [];
  if (P.cyl) {
    for (let p = -90; p <= 90; p += 2) outline.push(P.fwd(lon0 - 180, p));
    for (let p = 90; p >= -90; p -= 2) outline.push(P.fwd(lon0 + 180, p));
    world = [-Math.PI, -P.ymax, Math.PI, P.ymax]; if (kind === 'equalearth') { let mx = 0; for (const q of outline) mx = Math.max(mx, Math.abs(q[0])); world = [-mx, -P.ymax, mx, P.ymax]; }
  } else world = [-P.R, -P.R, P.R, P.R];
  let ext = world.slice();
  if (!global && box) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const [w, s, e, n] = box;
    const add = (l, p) => { if (!P.cyl && P.hidden(l, p)) return; const q = P.fwd(P.cyl ? lon0 + wrapRel(l - lon0) : l, p); if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; };
    for (let i = 0; i <= 24; i++) { const t = i / 24; add(w + (e - w) * t, s); add(w + (e - w) * t, n); add(w, s + (n - s) * t); add(e, s + (n - s) * t); }
    if (P.cyl) { const a = P.fwd(lon0 - (e - w) / 2, s), b = P.fwd(lon0 + (e - w) / 2, n), a2 = P.fwd(lon0 - (e - w) / 2, n), b2 = P.fwd(lon0 + (e - w) / 2, s); x0 = Math.min(a[0], a2[0]); x1 = Math.max(b[0], b2[0]); y0 = Math.min(a[1], b2[1]); y1 = Math.max(b[1], a2[1]); }
    if (Number.isFinite(x0) && x1 > x0 && y1 > y0) ext = [Math.max(world[0], x0), Math.max(world[1], y0), Math.min(world[2], x1), Math.min(world[3], y1)];
  }
  const legendW = o.legend ? 210 : 0;
  const m = { l: 64, r: 18 + legendW, t: 40, b: 62 };
  const W = o.width; const availW = W - m.l - m.r;
  const ew = ext[2] - ext[0], eh = ext[3] - ext[1];
  let H = o.height; let availH;
  if (!H) { availH = Math.round(Math.max(availW * 0.38, Math.min(availW * 1.05, availW * eh / ew))); H = availH + m.t + m.b; } else availH = H - m.t - m.b;
  if (availW < 120 || availH < 80) throw new Error(`canvas too small for a map: ${W}x${H} (need at least ~${m.l + m.r + 120}x${m.t + m.b + 80})`);
  const k = Math.min(availW / ew, availH / eh);
  const cx = (ext[0] + ext[2]) / 2, cy = (ext[1] + ext[3]) / 2;
  // grow the visible window to fill the available area, but never past the world outline
  const vis = [Math.max(world[0], cx - availW / 2 / k), Math.max(world[1], cy - availH / 2 / k), Math.min(world[2], cx + availW / 2 / k), Math.min(world[3], cy + availH / 2 / k)];
  const fw = (vis[2] - vis[0]) * k, fh = (vis[3] - vis[1]) * k;
  const frame = { x: Math.round(m.l + (availW - fw) / 2), y: Math.round(m.t + (availH - fh) / 2), w: Math.round(fw), h: Math.round(fh) };
  const px = (q) => [frame.x + (q[0] - vis[0]) * k, frame.y + (vis[3] - q[1]) * k];
  const unpx = (x, y) => P.inv(vis[0] + (x - frame.x) / k, vis[3] - (y - frame.y) / k);
  // visible geographic range, by inverting a grid of frame pixels
  let la0 = 90, la1 = -90, r0 = 180, r1 = -180, miss = false;
  for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) { const ll = unpx(frame.x + frame.w * i / 16, frame.y + frame.h * j / 16); if (!ll) { miss = true; continue; } la0 = Math.min(la0, ll[1]); la1 = Math.max(la1, ll[1]); const r = P.cyl ? ll[0] - lon0 : wrapRel(ll[0] - lon0); r0 = Math.min(r0, r); r1 = Math.max(r1, r); }
  if (la0 > la1) { la0 = -90; la1 = 90; r0 = -180; r1 = 180; }
  if (!P.cyl) { for (const pole of [90, -90]) { if (P.hidden(lon0, pole)) continue; const q = px(P.fwd(lon0, pole)); if (q[0] >= frame.x && q[0] <= frame.x + frame.w && q[1] >= frame.y && q[1] <= frame.y + frame.h) { r0 = -180; r1 = 180; if (pole > 0) la1 = 90; else la0 = -90; } } if (miss && global) { r0 = -180; r1 = 180; if (kind === 'laea') { la0 = -90; la1 = 90; } else { la0 = Math.max(-90, lat0 - 90); la1 = Math.min(90, lat0 + 90); } } }
  r0 = Math.max(-180, r0); r1 = Math.min(180, r1);
  return { kind, P, lon0, lat0, W, H, m, frame, k, vis, world, outline, px, unpx, global, range: { lat: [la0, la1], rel: [r0, r1] }, dataBbox: bb.bbox, crosses: bb.crossesAntimeridian, legendW };
}
const wrapRel = (d) => { d = ((d + 180) % 360 + 360) % 360 - 180; return d; };

// ───────────────────────────────────────────────────────── geometry ──
function makePen(g, v) {
  const { P, px, frame, lon0 } = v;
  const step = v.kind === 'equirectangular' ? 0 : P.cyl ? 3 : 2;
  const fx0 = frame.x - 2, fx1 = frame.x + frame.w + 2, fy0 = frame.y - 2, fy1 = frame.y + frame.h + 2;
  // trace one continuous-longitude coordinate list; returns false if it never touches the frame
  const trace = (coords, off, close) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; const pts = new Array(coords.length);
    for (let i = 0; i < coords.length; i++) { const q = px(P.fwd(coords[i][0] + off, coords[i][1])); pts[i] = q; if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
    if (x1 < fx0 || x0 > fx1 || y1 < fy0 || y0 > fy1) return false;
    g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    if (close) g.closePath();
    return true;
  };
  // longitude offsets that bring an unwrapped range into the visible window (cylindrical only)
  const offsets = (coords) => {
    if (!P.cyl) return [0];
    let a = Infinity, b = -Infinity; for (const c of coords) { if (c[0] < a) a = c[0]; if (c[0] > b) b = c[0]; }
    const lo = lon0 + v.range.rel[0] - 1e-9, hi = lon0 + v.range.rel[1] + 1e-9, out = [];
    for (let kk = Math.ceil((lo - b) / 360); kk <= Math.floor((hi - a) / 360); kk++) out.push(kk * 360);
    return out;
  };
  return {
    /** add a line to the current path */
    line(coords) { if (coords.length < 2) return false; const u = densify(unwrap(coords), step); if (!P.cyl && coords.length < 2000 && u.every((c) => P.hidden(c[0], c[1]))) return false; let any = false; for (const off of offsets(u)) any = trace(u, off, false) || any; return any; },
    /** add a polygon (all rings) to the current path; fill it with 'evenodd' */
    polygon(rings) {
      const rs = prepRings(rings, step); if (!rs.length) return false; let any = false;
      for (const off of offsets(rs[0])) for (const r of rs) any = trace(r, off, true) || any;
      if (!P.cyl && any) { const anti = [wrapLon(lon0 + 180), -v.lat0]; if (prepContains(rs, anti)) { const c = px([0, 0]), R = (P.R + 2) * v.k; g.rect(c[0] - R, c[1] - R, 2 * R, 2 * R); } }
      return any;
    },
    /** pixel position of a point, or null when hidden / outside the frame */
    point(c) {
      if (!P.cyl && P.hidden(c[0], c[1])) return null;
      const q = px(P.fwd(P.cyl ? lon0 + wrapRel(c[0] - lon0) : c[0], c[1]));
      return q[0] < fx0 || q[0] > fx1 || q[1] < fy0 || q[1] > fy1 ? null : q;
    },
    /** pixel polylines of a line, cut to the frame (for placing tick labels) */
    pixels(coords) { const u = densify(coords, step || 3); const out = []; for (const c of u) { if (!P.cyl && P.hidden(c[0], c[1])) continue; out.push(px(P.fwd(c[0], c[1]))); } return out; },
  };
}
function outlinePath(g, v) {
  g.beginPath();
  if (v.P.cyl) { v.outline.forEach((q, i) => { const p = v.px(q); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.closePath(); } else { const c = v.px([0, 0]); g.arc(c[0], c[1], v.P.R * v.k, 0, Math.PI * 2); }
}

// ───────────────────────────────────────────────────────── classing ──
/** build the colour function + legend for a property. Numeric → sequential classes; text → categorical (top 8, rest "other"). */
export function classify(fc, key, th, { classes = 5, method = 'quantile' } = {}) {
  const vals = []; let nonNull = 0, numeric = 0;
  for (const f of fc.features) { const v = (f.properties || {})[key]; if (v === null || v === undefined || v === '') continue; nonNull++; const nv = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : NaN; if (Number.isFinite(nv)) { numeric++; vals.push(nv); } }
  if (!nonNull) throw new Error(`no feature has a value for property "${key}" — properties present: ${[...new Set(fc.features.flatMap((f) => Object.keys(f.properties || {})))].slice(0, 20).join(', ') || '(none)'}`);
  if (numeric >= nonNull * 0.8) {
    vals.sort((a, b) => a - b); const lo = vals[0], hi = vals[vals.length - 1];
    let n = Math.max(2, Math.min(7, classes)); const distinct = new Set(vals).size; if (distinct < n) n = Math.max(1, distinct);
    let breaks = [];
    if (lo === hi) n = 1;
    else if (method === 'equal') for (let i = 1; i < n; i++) breaks.push(lo + (hi - lo) * i / n);
    else { for (let i = 1; i < n; i++) breaks.push(vals[Math.min(vals.length - 1, Math.floor(vals.length * i / n))]); breaks = [...new Set(breaks)].filter((b) => b > lo); n = breaks.length + 1; }
    const colors = ramp(th.seq, n);
    const idx = (x) => { let i = 0; while (i < breaks.length && x >= breaks[i]) i++; return i; };
    const counts = new Array(n).fill(0); vals.forEach((x) => counts[idx(x)]++);
    const edges = [lo, ...breaks, hi];
    return {
      kind: 'sequential', key, method: lo === hi ? 'single' : method, min: lo, max: hi, breaks,
      colorOf: (v) => { const x = typeof v === 'number' ? v : v === null || v === undefined || v === '' ? NaN : Number(v); return Number.isFinite(x) ? colors[idx(x)] : th.noData; },
      legend: colors.map((c, i) => ({ color: c, label: n === 1 ? fmtNum(lo) : `${fmtNum(edges[i])} – ${fmtNum(edges[i + 1])}`, count: counts[i] })).reverse(),
      missing: fc.features.length - vals.length,
    };
  }
  const freq = new Map(); for (const f of fc.features) { const v = (f.properties || {})[key]; if (v === null || v === undefined || v === '') continue; const s = String(v); freq.set(s, (freq.get(s) || 0) + 1); }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]); const shown = top.slice(0, th.cat.length); const map = new Map(shown.map(([s], i) => [s, th.cat[i]]));
  const legend = shown.map(([s, c], i) => ({ color: th.cat[i], label: s.length > 20 ? s.slice(0, 19) + '…' : s, count: c }));
  const rest = top.slice(th.cat.length).reduce((a, b) => a + b[1], 0); if (rest) legend.push({ color: th.other, label: `other (${top.length - shown.length})`, count: rest });
  return { kind: 'categorical', key, categories: top.length, colorOf: (v) => (v === null || v === undefined || v === '' ? th.noData : map.get(String(v)) || th.other), legend, missing: fc.features.length - [...freq.values()].reduce((a, b) => a + b, 0) };
}

// ──────────────────────────────────────────────────────────── paint ──
/**
 * renderMap(fc|null, opts) → {result: canvas | svg string, width, height, info}
 * opts: projection, width, height, bbox, center, span, theme, basemap ('countries'|'land'|'none'), graticule, label, maxLabels,
 *       choropleth, classes, method, color, lineWidth, pointRadius, fillOpacity, title, scaleBar, countryLabels, format ('png'|'svg')
 */
export async function renderMap(fc, o = {}) {
  const th = THEMES[o.theme || 'dark']; if (!th) throw new Error(`unknown theme "${o.theme}" — accepted: dark, light`);
  const cls = o.choropleth && fc ? classify(fc, o.choropleth, th, o) : null;
  const v = planView(fc, { ...o, legend: !!cls });
  const { W, H, frame, P } = v;
  const { g, finish } = surface(W, H, o.format);
  const fs = Math.max(11, Math.min(17, Math.round(W / 96)));
  const font = (size = fs, bold = false) => `${bold ? 'bold ' : ''}${size}px ${MONO}`;
  g.fillStyle = th.ground; g.fillRect(0, 0, W, H);
  const pen = makePen(g, v);
  const info = { projection: v.kind, center: [+v.lon0.toFixed(4), +v.lat0.toFixed(4)], frame, theme: o.theme || 'dark' };

  // ── clipped map body ──
  g.save();
  g.beginPath(); g.rect(frame.x, frame.y, frame.w, frame.h); g.clip();
  outlinePath(g, v); g.fillStyle = th.ocean; g.fill();
  g.save(); outlinePath(g, v); g.clip();
  g.lineJoin = 'round'; g.lineCap = 'round';
  let base = null;
  if (o.basemap !== 'none') {
    base = await loadBasemap();
    g.beginPath(); for (const f of base.land.features) eachPart(f.geometry, (k, c) => { if (k === 'polygon') pen.polygon(c); });
    g.fillStyle = th.land; g.fill('evenodd');
    if (o.basemap !== 'land') { g.beginPath(); for (const f of base.countries.features) eachPart(f.geometry, (k, c) => { if (k === 'polygon') pen.polygon(c); }); g.strokeStyle = th.border; g.lineWidth = 0.8; g.stroke(); }
    g.beginPath(); for (const f of base.land.features) eachPart(f.geometry, (k, c) => { if (k === 'polygon') pen.polygon(c); });
    g.strokeStyle = th.coast; g.lineWidth = 1.15; g.stroke();
  }
  // graticule
  const lonSpan = v.range.rel[1] - v.range.rel[0], latSpan = v.range.lat[1] - v.range.lat[0];
  const sLon = niceStep(lonSpan), sLat = niceStep(latSpan, 5);
  const meridians = [], parallels = [];
  if (o.graticule !== false) {
    const full = lonSpan >= 359.9;
    const a0 = full ? -180 : Math.ceil((v.lon0 + v.range.rel[0]) / sLon - 1e-9) * sLon, a1 = full ? 180 - sLon / 2 : v.lon0 + v.range.rel[1];
    const lo = Math.max(-90, v.range.lat[0] - sLat), hi = Math.min(90, v.range.lat[1] + sLat);
    const capLat = v.kind === 'mercator' ? MERC_MAX_LAT : 90;
    for (let l = a0; l <= a1 + 1e-9; l += sLon) { const L = +l.toFixed(6); if (P.cyl && full && Math.abs(wrapRel(L - v.lon0)) > 180 - 1e-6) continue; meridians.push({ v: L, c: [[P.cyl ? v.lon0 + wrapRel(L - v.lon0) : L, Math.max(-capLat, lo)], [P.cyl ? v.lon0 + wrapRel(L - v.lon0) : L, Math.min(capLat, hi)]] }); }
    for (let p = Math.ceil(lo / sLat - 1e-9) * sLat; p <= hi + 1e-9; p += sLat) { const Pv = +p.toFixed(6); if (Math.abs(Pv) > capLat - 1e-9 || Math.abs(Pv) >= 90) continue; const w0 = full || !P.cyl ? v.lon0 - 180 : v.lon0 + v.range.rel[0] - sLon, w1 = full || !P.cyl ? v.lon0 + 180 : v.lon0 + v.range.rel[1] + sLon; const n = Math.max(2, Math.ceil((w1 - w0) / 2)); parallels.push({ v: Pv, c: Array.from({ length: n + 1 }, (_, i) => [w0 + (w1 - w0) * i / n, Pv]) }); }
    g.beginPath();
    for (const mm of meridians) { const u = densify(mm.c, 2); const pts = u.map((c) => v.px(P.fwd(c[0], c[1]))); pts.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); }
    for (const pp of parallels) { const pts = pp.c.map((c) => v.px(P.fwd(c[0], c[1]))); pts.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); }
    g.strokeStyle = th.grat; g.lineWidth = 1; g.stroke();
  }
  // data
  const counts = { points: 0, lines: 0, polygons: 0, drawn: 0, hiddenPoints: 0 };
  const labels = [];
  if (fc) {
    const col = (f) => (cls ? cls.colorOf((f.properties || {})[cls.key]) : o.color || th.data);
    let nPts = 0; for (const f of fc.features) eachPart(f.geometry, (k) => { if (k === 'point') nPts++; });
    const pr = o.pointRadius || (nPts > 20000 ? 1.2 : nPts > 3000 ? 2 : nPts > 400 ? 3 : 4.5);
    const lw = o.lineWidth || 2;
    const fillA = o.fillOpacity ?? (cls ? 0.85 : 0.22);
    for (const f of fc.features) { // polygons first
      let has = false; g.beginPath(); eachPart(f.geometry, (k, c) => { if (k === 'polygon') { counts.polygons++; has = pen.polygon(c) || has; } });
      if (has) { const c = col(f); g.fillStyle = hexA(c, fillA); g.fill('evenodd'); g.strokeStyle = cls ? th.ground : c; g.lineWidth = cls ? 0.8 : 1.4; g.stroke(); counts.drawn++; }
    }
    for (const f of fc.features) {
      let has = false; g.beginPath(); eachPart(f.geometry, (k, c) => { if (k === 'line') { counts.lines++; has = pen.line(c) || has; } });
      if (has) { g.strokeStyle = col(f); g.lineWidth = lw; g.stroke(); counts.drawn++; }
    }
    for (const f of fc.features) {
      const c = col(f); let any = false;
      eachPart(f.geometry, (k, pt) => {
        if (k !== 'point') return; counts.points++; const q = pen.point(pt); if (!q) { counts.hiddenPoints++; return; } any = true;
        if (pr < 2.5) { g.fillStyle = c; g.fillRect(q[0] - pr, q[1] - pr, pr * 2, pr * 2); } else { g.beginPath(); g.arc(q[0], q[1], pr, 0, Math.PI * 2); g.fillStyle = c; g.fill(); g.strokeStyle = th.halo; g.lineWidth = 1.2; g.stroke(); }
      });
      if (any) counts.drawn++;
    }
    if (o.label) {
      for (const f of fc.features) {
        const t = (f.properties || {})[o.label]; if (t === null || t === undefined || t === '' || !f.geometry) continue;
        let at = null, dx = 0, w = 0; const gt = f.geometry.type;
        if (gt === 'Point') { at = f.geometry.coordinates; dx = pr + 4; w = 0; } else if (gt === 'LineString') { at = f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)]; dx = 5; } else { at = centroidOf(f.geometry); w = 1; }
        const q = at && pen.point(at); if (q) labels.push({ s: String(t).length > 28 ? String(t).slice(0, 27) + '…' : String(t), x: q[0], y: q[1], dx, center: w === 1 });
      }
    }
  }
  // country names from the basemap (context for a vision model)
  const placed = [];
  const tryPlace = (s, x, y, center, dx, color, size, bold) => {
    g.font = font(size, bold); const tw = g.measureText(s).width; const bx = center ? x - tw / 2 : x + dx; const box = [bx - 2, y - size * 0.7, bx + tw + 2, y + size * 0.7];
    if (box[0] < frame.x || box[2] > frame.x + frame.w || box[1] < frame.y || box[3] > frame.y + frame.h) return false;
    if (placed.some((b) => box[0] < b[2] && b[0] < box[2] && box[1] < b[3] && b[1] < box[3])) return false;
    placed.push(box); g.textAlign = 'left'; g.textBaseline = 'middle'; halo(g, th, s, bx, y, color); return true;
  };
  let nLabels = 0, skippedLabels = 0;
  for (const L of labels.slice(0, 5000)) { if (nLabels >= (o.maxLabels ?? 80)) { skippedLabels++; continue; } if (tryPlace(L.s, L.x, L.y, L.center, L.dx, th.text, fs, false)) nLabels++; else skippedLabels++; }
  if (o.countryLabels && base) {
    const cands = [];
    for (const f of base.countries.features) { const nm = f.properties && f.properties.name; if (!nm) continue; let best = null, ba = 0; eachPart(f.geometry, (k, c) => { if (k !== 'polygon') return; let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const p of unwrap(c[0])) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); } const a = (x1 - x0) * (y1 - y0); if (a > ba) { ba = a; best = c; } }); if (!best) continue; const cen = centroidOf({ type: 'Polygon', coordinates: best }); const q = cen && pen.point(cen); if (q) cands.push({ nm, q, a: ba }); }
    cands.sort((a, b) => b.a - a.a);
    for (const c of cands) tryPlace(c.nm, c.q[0], c.q[1], true, 0, th.dim, Math.max(10, fs - 2), false);
  }
  // in-map graticule labels for azimuthal views
  if (o.graticule !== false && !P.cyl) {
    g.font = font(Math.max(10, fs - 2)); g.textBaseline = 'middle';
    const refLat = Math.max(-80, Math.min(80, Math.round(((v.range.lat[0] + v.range.lat[1]) / 2) / sLat) * sLat));
    for (const pp of parallels) { if (pp.v === refLat) continue; const q = pen.point([v.lon0, pp.v]); if (!q) continue; g.textAlign = 'left'; halo(g, th, fmtLat(pp.v, sLat), q[0] + 4, q[1] - 7, th.dim); }
    for (const mm of meridians) { const q = pen.point([mm.v, refLat]); if (!q) continue; g.textAlign = 'center'; halo(g, th, fmtLon(mm.v, sLon), q[0], q[1] + 9, th.dim); }
  }
  g.restore();
  // frame / limb
  g.restore();
  g.save(); g.beginPath(); g.rect(frame.x - 1, frame.y - 1, frame.w + 2, frame.h + 2); g.clip();
  outlinePath(g, v); g.strokeStyle = th.frame; g.lineWidth = 1.2; g.stroke(); g.restore();
  if (P.cyl) { g.strokeStyle = th.frame; g.lineWidth = 1; if (v.kind !== 'equalearth' || !v.global) g.strokeRect(frame.x + 0.5, frame.y + 0.5, frame.w - 1, frame.h - 1); }

  // ── margin tick labels (cylindrical) ──
  if (o.graticule !== false && P.cyl) {
    g.font = font(Math.max(10, fs - 1)); g.fillStyle = th.dim;
    const inY = (y) => y >= frame.y - 0.5 && y <= frame.y + frame.h + 0.5, inX = (x) => x >= frame.x - 0.5 && x <= frame.x + frame.w + 0.5;
    let lastY = Infinity; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const pp of parallels.slice().reverse()) { // top to bottom
      const pts = pp.c.map((c) => v.px(P.fwd(c[0], c[1]))); const y = pts[0][1]; if (!inY(y)) continue;
      let x = Infinity; for (const q of pts) if (q[0] < x) x = q[0]; x = Math.max(frame.x, x);
      if (Math.abs(y - lastY) < fs + 2) continue; lastY = y; g.fillText(fmtLat(pp.v, sLat), x - 7, y);
    }
    let lastX = -Infinity; g.textAlign = 'center'; g.textBaseline = 'top';
    for (const mm of meridians.slice().sort((a, b) => wrapRel(a.v - v.lon0) - wrapRel(b.v - v.lon0))) {
      const u = densify(mm.c, 1).map((c) => v.px(P.fwd(c[0], c[1]))); let best = null;
      for (let i = 0; i < u.length; i++) { const q = u[i]; if (i && (u[i - 1][1] - (frame.y + frame.h)) * (q[1] - (frame.y + frame.h)) < 0) { const t = (frame.y + frame.h - u[i - 1][1]) / (q[1] - u[i - 1][1]); best = [u[i - 1][0] + (q[0] - u[i - 1][0]) * t, frame.y + frame.h]; break; } if (inY(q[1]) && (!best || q[1] > best[1])) best = q; }
      if (!best || !inX(best[0]) || best[1] < frame.y + frame.h - 3) continue;
      const s = fmtLon(mm.v, sLon), tw = g.measureText(s).width; if (best[0] - tw / 2 < lastX + 8) continue; lastX = best[0] + tw / 2; g.fillText(s, best[0], best[1] + 6);
    }
  }

  // ── title, footer, scale bar, legend ──
  g.textBaseline = 'middle'; g.textAlign = 'left';
  if (o.title) { g.font = font(fs + 3, true); g.fillStyle = th.text; g.fillText(String(o.title).slice(0, Math.floor((W - 40) / ((fs + 3) * 0.62))), 16, 21); }
  if (fc) { g.font = font(fs - 1); g.fillStyle = th.dim; g.textAlign = 'right'; const parts = []; if (counts.polygons) parts.push(`${counts.polygons} polygon${counts.polygons > 1 ? 's' : ''}`); if (counts.lines) parts.push(`${counts.lines} line${counts.lines > 1 ? 's' : ''}`); if (counts.points) parts.push(`${counts.points} point${counts.points > 1 ? 's' : ''}`); g.fillText(parts.join(' · ') || 'no geometry', W - 18, 21); }
  const fy = H - 20;
  let mpp = null;
  { // metres per pixel at the frame centre
    const cxp = frame.x + frame.w / 2, cyp = frame.y + frame.h / 2; const a = v.unpx(cxp - 20, cyp), b = v.unpx(cxp + 20, cyp);
    if (a && b) mpp = haversine(a, b) / 40;
    const cen = v.unpx(cxp, cyp);
    if (mpp && cen && o.scaleBar !== false) {
      const len = niceDistance(mpp * Math.min(220, frame.w * 0.3)), wpx = len / mpp; const x0 = frame.x, y0 = fy;
      g.strokeStyle = th.text; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x0, y0 - 5); g.lineTo(x0, y0 + 3); g.lineTo(x0 + wpx, y0 + 3); g.lineTo(x0 + wpx, y0 - 5); g.stroke();
      g.font = font(fs - 1); g.fillStyle = th.text; g.textAlign = 'left';
      const lab = len >= 1000 ? `${fmtNum(len / 1000)} km` : `${fmtNum(len)} m`;
      g.fillText(`${lab}${v.global || latSpan > 20 ? ` at ${fmtLat(cen[1], 1)}` : ''}`, x0 + wpx + 8, y0);
      info.scaleBar = { meters: len, pixels: +wpx.toFixed(1), atLat: +cen[1].toFixed(3) };
    }
    if (mpp) info.metersPerPixel = +mpp.toPrecision(5);
  }
  g.font = font(fs - 1); g.fillStyle = th.dim; g.textAlign = 'right';
  const pname = { equirectangular: 'equirectangular', mercator: 'web mercator', equalearth: 'equal earth (equal-area)', orthographic: 'orthographic', laea: 'lambert azimuthal equal-area' }[v.kind];
  g.fillText(`${pname} · centre ${fmtLon(v.lon0, 0.1)} ${fmtLat(v.lat0, 0.1)}${o.basemap !== 'none' ? ' · basemap Natural Earth 110m' : ''}`, W - 18, fy);
  if (cls) {
    const lx = W - v.legendW - 4, sw = 16; let ly = frame.y + 4;
    g.textAlign = 'left'; g.font = font(fs, true); g.fillStyle = th.text; g.fillText(cls.key.length > 20 ? cls.key.slice(0, 19) + '…' : cls.key, lx, ly + 6); ly += 26;
    g.font = font(fs - 1);
    const rows = cls.legend.slice(); if (cls.missing) rows.push({ color: th.noData, label: 'no data', count: cls.missing });
    for (const r of rows) { g.fillStyle = r.color; g.fillRect(lx, ly, sw, sw); g.strokeStyle = th.dim; g.lineWidth = 0.6; g.strokeRect(lx + 0.5, ly + 0.5, sw - 1, sw - 1); g.fillStyle = th.text; g.fillText(r.label, lx + sw + 8, ly + sw / 2); g.fillStyle = th.dim; g.textAlign = 'right'; g.fillText(`n=${r.count}`, W - 14, ly + sw / 2 + (g.measureText(r.label).width > v.legendW - sw - 70 ? 14 : 0)); g.textAlign = 'left'; ly += g.measureText(r.label).width > v.legendW - sw - 70 ? 36 : 24; }
    g.fillStyle = th.dim; g.fillText(cls.kind === 'sequential' ? `${cls.method} classes` : `${cls.categories} categories`, lx, ly + 10);
    info.legend = { property: cls.key, kind: cls.kind, method: cls.method, min: cls.min, max: cls.max, breaks: cls.breaks, classes: cls.legend.map((r) => ({ label: r.label, color: r.color, count: r.count })), missing: cls.missing };
  }
  const ll = (x, y) => { const p = v.unpx(x, y); return p ? [+wrapLon(p[0]).toFixed(5), +p[1].toFixed(5)] : null; };
  info.visible = { latRange: v.range.lat.map((x) => +x.toFixed(4)), lonRange: [+wrapLon(v.lon0 + v.range.rel[0]).toFixed(4), +wrapLon(v.lon0 + v.range.rel[1]).toFixed(4)], wholeWorld: v.global, corners: { topLeft: ll(frame.x, frame.y), bottomRight: ll(frame.x + frame.w, frame.y + frame.h) } };
  info.graticule = o.graticule !== false ? { lonStep: sLon, latStep: sLat } : null;
  info.drawn = { ...counts, labels: nLabels, labelsSkipped: skippedLabels };
  info.dataCrossesAntimeridian = !!v.crosses;
  return { result: finish(), width: W, height: H, info };
}

// ─────────────────────────────────────────────────── elevation chart ──
/** drawProfile({dist: m[], ele: m[]}, {width, height, theme, title, stats}) → canvas. One series: distance (x) against elevation (y). */
export function drawProfile(series, o = {}) {
  const th = THEMES[o.theme || 'dark']; const W = o.width || 1280, H = o.height || 480;
  const { g, finish } = surface(W, H, o.format);
  const fs = Math.max(11, Math.min(16, Math.round(W / 96))); const font = (s = fs, b = false) => `${b ? 'bold ' : ''}${s}px ${MONO}`;
  g.fillStyle = th.ground; g.fillRect(0, 0, W, H);
  const m = { l: 76, r: 26, t: o.title ? 64 : 40, b: 54 }; const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const D = series.dist, E = series.ele, n = D.length; const dmax = D[n - 1] || 1;
  let e0 = Infinity, e1 = -Infinity, i0 = 0, i1 = 0; for (let i = 0; i < n; i++) { if (E[i] < e0) { e0 = E[i]; i0 = i; } if (E[i] > e1) { e1 = E[i]; i1 = i; } }
  const ticks = (lo, hi, want) => { const raw = (hi - lo) / want || 1, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p, st = (f > 5 ? 10 : f > 2 ? 5 : f > 1 ? 2 : 1) * p; const out = []; for (let t = Math.ceil(lo / st - 1e-9) * st; t <= hi + st * 1e-6; t += st) out.push(+t.toPrecision(12)); return { st, out }; };
  const padE = Math.max(1, (e1 - e0) * 0.08); const ty = ticks(e0 - padE, e1 + padE, 5); const y0 = Math.min(e0 - padE, ty.out[0]), y1 = Math.max(e1 + padE, ty.out[ty.out.length - 1]);
  const km = dmax >= 2000; const ux = km ? 1000 : 1; const tx = ticks(0, dmax / ux, 8);
  const X = (d) => m.l + d / dmax * pw, Y = (e) => m.t + (y1 - e) / (y1 - y0) * ph;
  g.font = font(fs - 1); g.textBaseline = 'middle';
  g.strokeStyle = th.grat; g.lineWidth = 1; g.beginPath();
  for (const t of ty.out) { g.moveTo(m.l, Math.round(Y(t)) + 0.5); g.lineTo(m.l + pw, Math.round(Y(t)) + 0.5); }
  g.stroke();
  g.fillStyle = th.dim; g.textAlign = 'right'; for (const t of ty.out) g.fillText(fmtNum(t), m.l - 8, Y(t));
  g.textAlign = 'center'; g.textBaseline = 'top'; for (const t of tx.out) { const x = X(t * ux); if (x > m.l + pw + 1) continue; g.fillText(String(+t.toPrecision(6)), x, m.t + ph + 8); g.strokeStyle = th.dim; g.beginPath(); g.moveTo(Math.round(x) + 0.5, m.t + ph); g.lineTo(Math.round(x) + 0.5, m.t + ph + 4); g.stroke(); }
  g.fillText(`distance (${km ? 'km' : 'm'})`, m.l + pw / 2, m.t + ph + 28);
  g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('elevation (m)', 12, m.t - 16);
  // thin the series to ~2 samples per pixel (min/max kept by taking every k-th and the extremes)
  const stepI = Math.max(1, Math.floor(n / (pw * 2)));
  const idx = []; for (let i = 0; i < n; i += stepI) idx.push(i); if (idx[idx.length - 1] !== n - 1) idx.push(n - 1); for (const k of [i0, i1]) if (!idx.includes(k)) idx.push(k); idx.sort((a, b) => a - b);
  g.beginPath(); g.moveTo(X(D[idx[0]]), m.t + ph); for (const i of idx) g.lineTo(X(D[i]), Y(E[i])); g.lineTo(X(D[idx[idx.length - 1]]), m.t + ph); g.closePath(); g.fillStyle = hexA(th.data, 0.16); g.fill();
  g.beginPath(); idx.forEach((i, k) => (k ? g.lineTo(X(D[i]), Y(E[i])) : g.moveTo(X(D[i]), Y(E[i])))); g.strokeStyle = th.data; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
  g.strokeStyle = th.frame; g.lineWidth = 1; g.beginPath(); g.moveTo(m.l + 0.5, m.t); g.lineTo(m.l + 0.5, m.t + ph + 0.5); g.lineTo(m.l + pw, m.t + ph + 0.5); g.stroke();
  // direct labels on the extremes only
  g.font = font(fs - 1);
  for (const [i, lab, up] of [[i1, `max ${fmtNum(E[i1])} m`, true], [i0, `min ${fmtNum(E[i0])} m`, false]]) {
    const x = X(D[i]), y = Y(E[i]); g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fillStyle = th.data; g.fill(); g.strokeStyle = th.halo; g.lineWidth = 2; g.stroke();
    const tw = g.measureText(lab).width; g.textAlign = 'left'; g.textBaseline = 'middle'; const lx = Math.max(m.l + 4, Math.min(m.l + pw - tw - 4, x - tw / 2)); halo(g, th, lab, lx, up ? Math.max(m.t + 8, y - 14) : Math.min(m.t + ph - 8, y + 14), th.text);
  }
  g.textAlign = 'left'; g.textBaseline = 'middle';
  if (o.title) { g.font = font(fs + 3, true); g.fillStyle = th.text; g.fillText(String(o.title).slice(0, 90), 12, 20); }
  if (o.stats) { g.font = font(fs - 1); g.fillStyle = th.dim; g.textAlign = 'right'; g.fillText(o.stats, W - m.r, o.title ? 20 : m.t - 16); }
  return { result: finish(), width: W, height: H };
}
