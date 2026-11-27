// μεταμόρφωσις :: geo/ops — geometry walking, bbox, measuring, simplify, clip, hull, centroid, filter expressions.
import { dist, haversine, lineLength, polygonArea, ringArea, toVec, fromVec, RAD } from './geodesy.js';

// ────────────────────────────────────────────────────────── walking ──
/** call cb(kind, coords) for every primitive: 'point' → position, 'line' → positions[], 'polygon' → rings[] */
export function eachPart(g, cb) {
  if (!g) return;
  switch (g.type) {
    case 'Point': cb('point', g.coordinates); break;
    case 'MultiPoint': g.coordinates.forEach((c) => cb('point', c)); break;
    case 'LineString': cb('line', g.coordinates); break;
    case 'MultiLineString': g.coordinates.forEach((c) => cb('line', c)); break;
    case 'Polygon': cb('polygon', g.coordinates); break;
    case 'MultiPolygon': g.coordinates.forEach((c) => cb('polygon', c)); break;
    case 'GeometryCollection': (g.geometries || []).forEach((x) => eachPart(x, cb)); break;
    default:
  }
}
export function eachPos(g, cb) { eachPart(g, (k, c) => { if (k === 'point') cb(c); else if (k === 'line') c.forEach(cb); else c.forEach((r) => r.forEach(cb)); }); }
/** new geometry with every position replaced by fn(position) */
export function mapPos(g, fn) {
  if (!g) return g;
  if (g.type === 'GeometryCollection') return { type: g.type, geometries: g.geometries.map((x) => mapPos(x, fn)) };
  const rec = (c) => (typeof c[0] === 'number' ? fn(c) : c.map(rec));
  return { type: g.type, coordinates: g.coordinates.length ? rec(g.coordinates) : [] };
}
/** new geometry with every line / ring replaced by fn(coords, isRing) (points untouched) */
export function mapLines(g, fn) {
  if (!g) return g;
  switch (g.type) {
    case 'LineString': return { type: g.type, coordinates: fn(g.coordinates, false) };
    case 'MultiLineString': return { type: g.type, coordinates: g.coordinates.map((l) => fn(l, false)) };
    case 'Polygon': return { type: g.type, coordinates: g.coordinates.map((r) => fn(r, true)) };
    case 'MultiPolygon': return { type: g.type, coordinates: g.coordinates.map((p) => p.map((r) => fn(r, true))) };
    case 'GeometryCollection': return { type: g.type, geometries: g.geometries.map((x) => mapLines(x, fn)) };
    default: return g;
  }
}
export const vertexCount = (fc) => { let n = 0; for (const f of fc.features) eachPos(f.geometry, () => n++); return n; };
export const geomVertices = (g) => { let n = 0; eachPos(g, () => n++); return n; };
export function typeCounts(fc) { const t = {}; for (const f of fc.features) { const k = f.geometry ? f.geometry.type : 'null'; t[k] = (t[k] || 0) + 1; } return t; }
export const dimOf = (g) => { let d = -1; eachPart(g, (k) => { d = Math.max(d, k === 'point' ? 0 : k === 'line' ? 1 : 2); }); return d; };

/** make longitudes continuous along a line (no ±360 jumps) */
export function unwrap(coords) {
  if (!coords.length) return coords;
  const out = [coords[0]]; let off = 0, prev = coords[0][0];
  for (let i = 1; i < coords.length; i++) {
    const c = coords[i]; const d = c[0] - prev;
    if (d > 180) off -= 360; else if (d < -180) off += 360;
    prev = c[0];
    out.push(off ? [c[0] + off, ...c.slice(1)] : c);
  }
  return out;
}

// ───────────────────────────────────────────────────────────── bbox ──
/** {bbox:[w,s,e,n], crossesAntimeridian, count}. When the data straddles ±180 the bbox has west > east (RFC 7946 §5.2). */
export function bboxOf(fcOrGeom) {
  const lons = []; let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  const add = (c) => { const x = c[0], y = c[1]; if (!Number.isFinite(x) || !Number.isFinite(y)) return; lons.push(x); if (y < s) s = y; if (y > n) n = y; if (x < w) w = x; if (x > e) e = x; };
  if (fcOrGeom && fcOrGeom.type === 'FeatureCollection') for (const f of fcOrGeom.features) eachPos(f.geometry, add); else eachPos(fcOrGeom, add);
  if (!lons.length) return { bbox: null, crossesAntimeridian: false, count: 0 };
  let crosses = false;
  if (e - w > 180 && w >= -180 && e <= 180) {
    const a = Float64Array.from(lons).sort(); let gap = 0, gi = -1;
    for (let i = 1; i < a.length; i++) if (a[i] - a[i - 1] > gap) { gap = a[i] - a[i - 1]; gi = i; }
    if (gi > 0 && 360 - gap < (e - w) * 0.75) { w = a[gi]; e = a[gi - 1]; crosses = true; }
  }
  return { bbox: [w, s, e, n], crossesAntimeridian: crosses, count: lons.length };
}
export const bboxSpan = (b) => [b[2] >= b[0] ? b[2] - b[0] : b[2] + 360 - b[0], b[3] - b[1]];
export const inBbox = (c, b) => c[1] >= b[1] && c[1] <= b[3] && (b[0] <= b[2] ? c[0] >= b[0] && c[0] <= b[2] : c[0] >= b[0] || c[0] <= b[2]);
export function bboxIntersects(a, b) {
  if (a[3] < b[1] || a[1] > b[3]) return false;
  const iv = (x) => (x[0] <= x[2] ? [[x[0], x[2]]] : [[x[0], 180], [-180, x[2]]]);
  return iv(a).some((p) => iv(b).some((q) => p[0] <= q[1] && q[0] <= p[1]));
}

// ────────────────────────────────────────────────────────── measure ──
/** {length (m, lines), area (m², polygons), perimeter (m, polygons), vertices} for one geometry */
export function measureGeom(g, method = 'vincenty') {
  const m = { length: 0, area: 0, perimeter: 0, vertices: 0 };
  eachPart(g, (k, c) => {
    if (k === 'point') m.vertices++;
    else if (k === 'line') { m.vertices += c.length; m.length += lineLength(c, method); }
    else { for (const r of c) { m.vertices += r.length; m.perimeter += lineLength(r, method); } m.area += polygonArea(c); }
  });
  return m;
}

// ─────────────────────────────────────────────────────────── points ──
function pipRing(x, y, ring) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }
/** planar lon/lat point-in-polygon (rings unwrapped, the point tried at lon and lon±360) */
export function pointInPolygon(pt, rings) {
  const us = rings.map(unwrap);
  for (const dx of [0, -360, 360]) {
    const x = pt[0] + dx;
    if (us.length && pipRing(x, pt[1], us[0])) { let hole = false; for (let i = 1; i < us.length; i++) if (pipRing(x, pt[1], us[i])) { hole = true; break; } if (!hole) return true; }
  }
  return false;
}
export function geomContains(g, pt) { let hit = false; eachPart(g, (k, c) => { if (!hit && k === 'polygon' && pointInPolygon(pt, c)) hit = true; }); return hit; }
/** shortest distance (m) from pt to a geometry's vertices and edges (edges sampled as local planar segments) */
export function distanceToGeom(g, pt) {
  let best = Infinity;
  const seg = (a, b) => {
    const k = Math.cos(pt[1] * RAD); let ax = (a[0] - pt[0]), bx = (b[0] - pt[0]);
    if (ax > 180) ax -= 360; if (ax < -180) ax += 360; if (bx > 180) bx -= 360; if (bx < -180) bx += 360;
    ax *= k; bx *= k; const ay = a[1] - pt[1], by = b[1] - pt[1];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy; let t = L ? -(ax * dx + ay * dy) / L : 0; t = Math.max(0, Math.min(1, t));
    const q = [a[0] + (b[0] - a[0] + (b[0] - a[0] > 180 ? -360 : b[0] - a[0] < -180 ? 360 : 0)) * t, a[1] + (b[1] - a[1]) * t];
    const d = haversine(pt, q); if (d < best) best = d;
  };
  eachPart(g, (kind, c) => {
    if (kind === 'point') { const d = haversine(pt, c); if (d < best) best = d; }
    else if (kind === 'line') { if (c.length === 1) seg(c[0], c[0]); for (let i = 1; i < c.length; i++) seg(c[i - 1], c[i]); }
    else { if (pointInPolygon(pt, c)) { best = 0; return; } for (const r of c) for (let i = 1; i < r.length; i++) seg(r[i - 1], r[i]); }
  });
  return best;
}

// ───────────────────────────────────────────────────────── centroid ──
/** centroid of one geometry: polygons by area, else lines by length, else mean of points. Computed on the sphere (antimeridian-safe). */
export function centroidOf(g) {
  const acc = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]; // per dimension: x,y,z,weight
  const add = (d, p, w) => { const v = toVec(p); acc[d][0] += v[0] * w; acc[d][1] += v[1] * w; acc[d][2] += v[2] * w; acc[d][3] += w; };
  eachPart(g, (k, c) => {
    if (k === 'point') add(0, c, 1);
    else if (k === 'line') { if (c.length === 1) add(1, c[0], 1e-9); for (let i = 1; i < c.length; i++) { const u = unwrap([c[i - 1], c[i]]); add(1, [(u[0][0] + u[1][0]) / 2, (u[0][1] + u[1][1]) / 2], Math.max(1e-9, haversine(c[i - 1], c[i]))); } }
    else if (c.length && c[0].length >= 3) {
      // planar centroid of the unwrapped ring set (outer minus holes), weighted by geodesic area
      let A = 0, cx = 0, cy = 0;
      c.forEach((ring, ri) => {
        const r = unwrap(ring); if (r.length < 3) return;
        const shift = ri === 0 ? 0 : Math.round((c[0][0][0] - r[0][0]) / 360) * 360;
        let a = 0, x = 0, y = 0;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i][0] + shift, xj = r[j][0] + shift, f = xj * r[i][1] - xi * r[j][1]; a += f; x += (xi + xj) * f; y += (r[i][1] + r[j][1]) * f; }
        if (!a) return;
        const w = Math.abs(a / 2) * (ri === 0 ? 1 : -1); A += w; cx += x / (3 * a) * w; cy += y / (3 * a) * w;
      });
      if (A > 0) add(2, [cx / A, cy / A], Math.max(1e-9, polygonArea(c))); else add(2, c[0][0], 1e-9);
    }
  });
  for (let d = 2; d >= 0; d--) if (acc[d][3] > 0) { const p = fromVec(acc[d]); return Math.hypot(acc[d][0], acc[d][1], acc[d][2]) < 1e-12 ? null : p; }
  return null;
}
// ───────────────────────────────────────────────────────── simplify ──
const MX = 111319.49, MY = 110574;
function planar(coords) {
  const u = unwrap(coords); let lat = 0; for (const c of u) lat += c[1]; const k = Math.cos((lat / Math.max(1, u.length)) * RAD) * MX;
  const xs = new Float64Array(u.length), ys = new Float64Array(u.length);
  for (let i = 0; i < u.length; i++) { xs[i] = u[i][0] * k; ys[i] = u[i][1] * MY; }
  return [xs, ys];
}
/** Douglas-Peucker significance of each vertex in metres (distance at which it would still be kept) */
function dpWeights(coords) {
  const n = coords.length, w = new Float64Array(n); if (n === 0) return w;
  const [xs, ys] = planar(coords); w[0] = w[n - 1] = Infinity;
  const stack = [[0, n - 1, Infinity]];
  while (stack.length) {
    const [a, b, cap] = stack.pop(); if (b - a < 2) continue;
    const ax = xs[a], ay = ys[a], dx = xs[b] - ax, dy = ys[b] - ay, L = dx * dx + dy * dy; let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = xs[i] - ax, py = ys[i] - ay; let d;
      if (!L) d = px * px + py * py; else { let t = (px * dx + py * dy) / L; t = t < 0 ? 0 : t > 1 ? 1 : t; const ex = px - t * dx, ey = py - t * dy; d = ex * ex + ey * ey; }
      if (d > best) { best = d; bi = i; }
    }
    const v = Math.min(cap, Math.sqrt(best)); w[bi] = v;
    stack.push([a, bi, v], [bi, b, v]);
  }
  return w;
}
/** Visvalingam-Whyatt effective area of each vertex, returned as sqrt(area) in metres so one tolerance fits both methods */
function vwWeights(coords) {
  const n = coords.length, w = new Float64Array(n); if (n === 0) return w;
  const [xs, ys] = planar(coords); w[0] = w[n - 1] = Infinity; if (n < 3) return w;
  const prev = new Int32Array(n), next = new Int32Array(n), ver = new Int32Array(n);
  for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1; }
  const area = (i) => Math.abs((xs[prev[i]] - xs[i]) * (ys[next[i]] - ys[i]) - (xs[next[i]] - xs[i]) * (ys[prev[i]] - ys[i])) / 2;
  const heap = []; // [area, index, version]
  const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  for (let i = 1; i < n - 1; i++) push([area(i), i, 0]);
  let floor = 0;
  while (heap.length) {
    const [a, i, v] = pop(); if (v !== ver[i]) continue;
    floor = Math.max(floor, a); w[i] = Math.sqrt(floor); ver[i] = -1;
    const p = prev[i], q = next[i]; next[p] = q; prev[q] = p;
    if (p > 0) { ver[p]++; push([area(p), p, ver[p]]); }
    if (q < n - 1) { ver[q]++; push([area(q), q, ver[q]]); }
  }
  return w;
}
/**
 * simplify(fc, {method:'dp'|'visvalingam', tolerance (m) | target (vertex count)}) → {fc, before, after, tolerance}
 * Line ends are always kept; rings never drop below 4 positions. Each line is simplified on its own (shared borders may drift apart).
 */
export function simplify(fc, { method = 'dp', tolerance, target }) {
  const parts = []; let fixed = 0, before = 0;
  for (const f of fc.features) {
    eachPart(f.geometry, (k, c) => {
      if (k === 'point') { fixed++; before++; return; }
      for (const line of k === 'line' ? [c] : c) {
        const w = method === 'dp' ? dpWeights(line) : vwWeights(line);
        if (k === 'polygon' && line.length > 4) { // keep the two most significant interior vertices so the ring stays a ring
          let i1 = -1, i2 = -1; for (let i = 1; i < line.length - 1; i++) { if (i1 < 0 || w[i] > w[i1]) { i2 = i1; i1 = i; } else if (i2 < 0 || w[i] > w[i2]) i2 = i; }
          w[i1] = Infinity; w[i2] = Infinity;
        } else if (k === 'polygon') w.fill(Infinity);
        parts.push(w); before += line.length;
      }
    });
  }
  let thr = tolerance ?? 0;
  if (target !== undefined) {
    const finite = []; let must = fixed;
    for (const w of parts) for (let i = 0; i < w.length; i++) { if (w[i] === Infinity) must++; else finite.push(w[i]); }
    const k = Math.max(0, Math.min(finite.length, Math.round(target) - must));
    if (k >= finite.length) thr = 0; else { const s = Float64Array.from(finite).sort(); // keep the k largest
      thr = k === 0 ? Infinity : s[s.length - k];
      // ties at the threshold: allow exactly as many as fit
      let above = 0; for (const v of s) if (v > thr) above++;
      let budget = k - above;
      for (const w of parts) for (let i = 0; i < w.length; i++) if (w[i] === thr && thr !== Infinity) { if (budget > 0) { budget--; w[i] = Infinity; } else w[i] = -1; }
    }
  }
  let pi = 0, after = fixed;
  const features = fc.features.map((f) => ({ ...f, geometry: mapLines(f.geometry, (line) => { const w = parts[pi++]; const out = []; for (let i = 0; i < line.length; i++) if (w[i] === Infinity || (w[i] >= thr && w[i] > 0) || (thr === 0 && w[i] >= 0)) out.push(line[i]); after += out.length; return out; }) }));
  return { fc: { ...fc, features }, before, after, tolerance: thr === Infinity ? null : thr };
}

// ───────────────────────────────────────────────────────────── clip ──
function clipLine(coords, b) {
  const out = []; let cur = null;
  const lerp = (p, q, t) => { const r = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; if (p.length > 2 && q.length > 2) r.push(p[2] + (q[2] - p[2]) * t); return r; };
  for (let i = 1; i < coords.length; i++) {
    const p = coords[i - 1], q = coords[i]; let t0 = 0, t1 = 1; const dx = q[0] - p[0], dy = q[1] - p[1]; let ok = true;
    for (const [pp, qq] of [[-dx, p[0] - b[0]], [dx, b[2] - p[0]], [-dy, p[1] - b[1]], [dy, b[3] - p[1]]]) {
      if (pp === 0) { if (qq < 0) { ok = false; break; } } else { const r = qq / pp; if (pp < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; } }
    }
    if (!ok) { cur = null; continue; }
    const a = t0 > 0 ? lerp(p, q, t0) : p, z = t1 < 1 ? lerp(p, q, t1) : q;
    if (!cur || t0 > 0) { cur = [a]; out.push(cur); }
    cur.push(z);
    if (t1 < 1) cur = null;
  }
  return out.filter((l) => l.length >= 2);
}
function clipRing(ring, b) {
  let pts = ring.slice(0, -1);
  const edges = [[0, b[0], 1], [0, b[2], -1], [1, b[1], 1], [1, b[3], -1]]; // axis, value, sign (inside when sign*(c-value) >= 0)
  for (const [ax, v, s] of edges) {
    const out = []; const inside = (c) => s * (c[ax] - v) >= 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length]; const pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) { const t = (v - p[ax]) / (q[ax] - p[ax]); const r = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; r[ax] = v; if (p.length > 2 && q.length > 2) r.push(p[2] + (q[2] - p[2]) * t); out.push(r); }
    }
    pts = out; if (pts.length < 3) return null;
  }
  pts.push(pts[0].slice());
  return pts.length >= 4 ? pts : null;
}
function clipGeom(g, b) {
  if (!g) return null;
  if (g.type === 'GeometryCollection') { const gs = g.geometries.map((x) => clipGeom(x, b)).filter(Boolean); return gs.length ? { type: g.type, geometries: gs } : null; }
  const pts = [], lines = [], polys = [];
  eachPart(g, (k, c) => {
    if (k === 'point') { if (c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3]) pts.push(c); }
    else if (k === 'line') lines.push(...clipLine(c, b));
    else { const outer = c.length ? clipRing(c[0], b) : null; if (outer) polys.push([outer, ...c.slice(1).map((r) => clipRing(r, b)).filter(Boolean)]); }
  });
  if (pts.length) return g.type === 'Point' ? { type: 'Point', coordinates: pts[0] } : { type: 'MultiPoint', coordinates: pts };
  if (lines.length) return lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines };
  if (polys.length) return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  return null;
}
/** clip every feature to bbox [w,s,e,n]; a bbox with west > east crosses the antimeridian and is clipped as two boxes */
export function clip(fc, b) {
  const boxes = b[0] <= b[2] ? [b] : [[b[0], b[1], 180, b[3]], [-180, b[1], b[2], b[3]]];
  const features = [];
  for (const f of fc.features) {
    const gs = boxes.map((bx) => clipGeom(f.geometry, bx)).filter(Boolean);
    if (!gs.length) continue;
    let g = gs[0];
    if (gs.length > 1) {
      if (gs.every((x) => /Point$/.test(x.type))) g = { type: 'MultiPoint', coordinates: gs.flatMap((x) => (x.type === 'Point' ? [x.coordinates] : x.coordinates)) };
      else if (gs.every((x) => /LineString$/.test(x.type))) g = { type: 'MultiLineString', coordinates: gs.flatMap((x) => (x.type === 'LineString' ? [x.coordinates] : x.coordinates)) };
      else if (gs.every((x) => /Polygon$/.test(x.type))) g = { type: 'MultiPolygon', coordinates: gs.flatMap((x) => (x.type === 'Polygon' ? [x.coordinates] : x.coordinates)) };
      else g = { type: 'GeometryCollection', geometries: gs };
    }
    features.push({ ...f, geometry: g });
  }
  return { ...fc, features };
}

// ───────────────────────────────────────────────────────────── hull ──
/** convex hull in the lon/lat plane (Andrew monotone chain). Returns a Polygon, LineString or Point geometry, or null. */
export function convexHull(fc) {
  const bb = bboxOf(fc); if (!bb.count) return { geometry: null, shifted: false };
  const pts = [];
  for (const f of fc.features) eachPos(f.geometry, (c) => { if (Number.isFinite(c[0]) && Number.isFinite(c[1])) pts.push([bb.crossesAntimeridian && c[0] < 0 ? c[0] + 360 : c[0], c[1]]); });
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const uniq = pts.filter((p, i) => !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  if (uniq.length === 1) return { geometry: { type: 'Point', coordinates: uniq[0] }, shifted: false };
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = []; for (const p of uniq) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = []; for (let i = uniq.length - 1; i >= 0; i--) { const p = uniq[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) return { geometry: { type: 'LineString', coordinates: hull }, shifted: bb.crossesAntimeridian };
  hull.push(hull[0].slice());
  return { geometry: { type: 'Polygon', coordinates: [hull] }, shifted: bb.crossesAntimeridian };
}

// ─────────────────────────────────────────────────────── properties ──
/** per-key summary of feature properties: types, filled count, numeric range, distinct count, most common sample values */
export function propertyStats(fc, { maxKeys = 40, samples = 5 } = {}) {
  const keys = new Map();
  for (const f of fc.features) {
    for (const [k, v] of Object.entries(f.properties || {})) {
      let s = keys.get(k); if (!s) { s = { key: k, types: {}, count: 0, nulls: 0, min: Infinity, max: -Infinity, sum: 0, nums: 0, values: new Map(), overflow: false }; keys.set(k, s); }
      if (v === null || v === undefined || v === '') { s.nulls++; continue; }
      s.count++;
      const t = Array.isArray(v) ? 'array' : typeof v; s.types[t] = (s.types[t] || 0) + 1;
      if (t === 'number' && Number.isFinite(v)) { s.nums++; s.sum += v; if (v < s.min) s.min = v; if (v > s.max) s.max = v; }
      if (t !== 'object' && t !== 'array') { if (s.values.size < 2000 || s.values.has(v)) s.values.set(v, (s.values.get(v) || 0) + 1); else s.overflow = true; }
    }
  }
  const out = [];
  for (const s of keys.values()) {
    const types = Object.keys(s.types);
    const o = { key: s.key, type: types.length === 1 ? types[0] : types.length ? types.join('|') : 'null', filled: s.count };
    if (s.nulls) o.empty = s.nulls;
    if (s.nums) { o.min = s.min; o.max = s.max; o.mean = +(s.sum / s.nums).toPrecision(6); }
    if (s.values.size) { o.distinct = s.overflow ? `>${s.values.size}` : s.values.size; o.samples = [...s.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, samples).map(([v]) => (typeof v === 'string' && v.length > 60 ? v.slice(0, 57) + '…' : v)); }
    out.push(o);
  }
  return { keys: out.slice(0, maxKeys), total: out.length, truncated: out.length > maxKeys };
}

// ───────────────────────────────────────── filter expression language ──
// Grammar (no eval): or → and → not → comparison → sum → product → unary → primary
//   literals: 12, 3.5, "text", 'text', true, false, null     names: pop, `odd name`, properties["odd name"]
//   specials: $type $id $index $length $area $vertices $lon $lat
//   operators: || or, && and, ! not, == = != <> < <= > >=, + - * / %, in [a, b], ~ "regex" (case-insensitive), contains, startswith, endswith
//   functions: lower(x) upper(x) len(x) abs(x) round(x) number(x) string(x) exists(name) coalesce(a, b, …)
export function compileExpr(src) {
  const toks = []; let i = 0; const s = String(src);
  const err = (msg, at = i) => new Error(`filter expression: ${msg} at character ${at} in ${JSON.stringify(s)}. Example: pop > 1e6 && continent == "Asia"`);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/\d/.test(c) || (c === '.' && /\d/.test(s[i + 1] || ''))) { const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(s.slice(i)); toks.push({ t: 'num', v: Number(m[0]), at: i }); i += m[0].length; continue; }
    if (c === '"' || c === "'") { let j = i + 1, v = ''; while (j < s.length && s[j] !== c) { if (s[j] === '\\' && j + 1 < s.length) j++; v += s[j++]; } if (j >= s.length) throw err('unterminated string'); toks.push({ t: 'str', v, at: i }); i = j + 1; continue; }
    if (c === '`') { const j = s.indexOf('`', i + 1); if (j < 0) throw err('unterminated `name`'); toks.push({ t: 'id', v: s.slice(i + 1, j), at: i }); i = j + 1; continue; }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) { const m = /^[A-Za-z_$\u0080-￿][\w$.:\u0080-￿]*/.exec(s.slice(i)); const v = m[0].replace(/[.:]+$/, ''); toks.push({ t: 'id', v, at: i }); i += v.length; continue; }
    const two = s.slice(i, i + 2);
    if (['||', '&&', '==', '!=', '<=', '>=', '<>'].includes(two)) { toks.push({ t: 'op', v: two, at: i }); i += 2; continue; }
    if ('!<>=+-*/%()[],~'.includes(c)) { toks.push({ t: 'op', v: c, at: i }); i++; continue; }
    throw err(`unexpected character "${c}"`);
  }
  let p = 0;
  const peek = () => toks[p], isOp = (v) => toks[p] && toks[p].t === 'op' && toks[p].v === v, isWord = (v) => toks[p] && toks[p].t === 'id' && toks[p].v.toLowerCase() === v;
  const need = (v) => { if (!isOp(v)) throw err(`expected "${v}"`, toks[p] ? toks[p].at : s.length); p++; };
  const cmp = (a, b) => { if (a === null || a === undefined || b === null || b === undefined) return NaN; if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b))) b = Number(b); else if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && !Number.isNaN(Number(a))) a = Number(a); return a < b ? -1 : a > b ? 1 : a === b ? 0 : NaN; };
  const eq = (a, b) => { if (a === undefined) a = null; if (b === undefined) b = null; return a === b || cmp(a, b) === 0; };
  const FUN = {
    lower: (x) => (x == null ? x : String(x).toLowerCase()), upper: (x) => (x == null ? x : String(x).toUpperCase()), len: (x) => (x == null ? 0 : typeof x === 'object' ? Object.keys(x).length : String(x).length),
    abs: (x) => Math.abs(x), round: (x, d = 0) => { const k = 10 ** d; return Math.round(x * k) / k; }, floor: (x) => Math.floor(x), ceil: (x) => Math.ceil(x), sqrt: (x) => Math.sqrt(x),
    number: (x) => (x == null || x === '' ? null : Number(x)), string: (x) => (x == null ? '' : String(x)), coalesce: (...a) => a.find((x) => x !== null && x !== undefined) ?? null, min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
  };
  const parseOr = () => { let l = parseAnd(); while (isOp('||') || isWord('or')) { p++; const a = l, r = parseAnd(); l = (c) => !!(a(c)) || !!(r(c)); } return l; };
  const parseAnd = () => { let l = parseNot(); while (isOp('&&') || isWord('and')) { p++; const a = l, r = parseNot(); l = (c) => !!(a(c)) && !!(r(c)); } return l; };
  const parseNot = () => { if (isOp('!') || isWord('not')) { p++; const a = parseNot(); return (c) => !a(c); } return parseCmp(); };
  const parseCmp = () => {
    const l = parseSum(); const t = peek(); if (!t) return l;
    if (t.t === 'op' && ['==', '=', '!=', '<>', '<', '<=', '>', '>='].includes(t.v)) {
      p++; const r = parseSum(); const o = t.v;
      if (o === '==' || o === '=') return (c) => eq(l(c), r(c));
      if (o === '!=' || o === '<>') return (c) => !eq(l(c), r(c));
      if (o === '<') return (c) => cmp(l(c), r(c)) < 0; if (o === '<=') return (c) => cmp(l(c), r(c)) <= 0;
      if (o === '>') return (c) => cmp(l(c), r(c)) > 0; return (c) => cmp(l(c), r(c)) >= 0;
    }
    if (t.t === 'op' && t.v === '~') { p++; const r = parseSum(); return (c) => { const v = l(c); if (v == null) return false; let re; try { re = new RegExp(String(r(c)), 'i'); } catch (e) { throw new Error(`filter expression: bad regular expression — ${e.message}`); } return re.test(String(v)); }; }
    if (t.t === 'id' && ['contains', 'startswith', 'endswith'].includes(t.v.toLowerCase())) { p++; const r = parseSum(); const k = t.v.toLowerCase(); return (c) => { const v = l(c); if (v == null) return false; const a = String(v).toLowerCase(), b = String(r(c)).toLowerCase(); return k === 'contains' ? a.includes(b) : k === 'startswith' ? a.startsWith(b) : a.endsWith(b); }; }
    let neg = false; if (isWord('not') && toks[p + 1] && toks[p + 1].t === 'id' && toks[p + 1].v.toLowerCase() === 'in') { neg = true; p++; }
    if (isWord('in')) { p++; need('['); const items = []; if (!isOp(']')) { items.push(parseOr()); while (isOp(',')) { p++; items.push(parseOr()); } } need(']'); return (c) => { const v = l(c); const hit = items.some((it) => eq(v, it(c))); return neg ? !hit : hit; }; }
    return l;
  };
  const parseSum = () => { let l = parseMul(); while (isOp('+') || isOp('-')) { const o = toks[p++].v, a = l, r = parseMul(); l = o === '+' ? (c) => { const x = a(c), y = r(c); return typeof x === 'string' || typeof y === 'string' ? String(x ?? '') + String(y ?? '') : x + y; } : (c) => a(c) - r(c); } return l; };
  const parseMul = () => { let l = parseUnary(); while (isOp('*') || isOp('/') || isOp('%')) { const o = toks[p++].v, a = l, r = parseUnary(); l = o === '*' ? (c) => a(c) * r(c) : o === '/' ? (c) => a(c) / r(c) : (c) => a(c) % r(c); } return l; };
  const parseUnary = () => { if (isOp('-')) { p++; const a = parseUnary(); return (c) => -a(c); } if (isOp('+')) { p++; return parseUnary(); } return parsePrimary(); };
  const parsePrimary = () => {
    const t = toks[p]; if (!t) throw err('unexpected end', s.length);
    if (t.t === 'num' || t.t === 'str') { p++; return () => t.v; }
    if (t.t === 'op' && t.v === '(') { p++; const e = parseOr(); need(')'); return e; }
    if (t.t === 'id') {
      p++; const low = t.v.toLowerCase();
      if (low === 'true') return () => true; if (low === 'false') return () => false; if (low === 'null') return () => null;
      if (isOp('(')) {
        p++; const args = []; if (!isOp(')')) { args.push(parseOr()); while (isOp(',')) { p++; args.push(parseOr()); } } need(')');
        if (low === 'exists') { const nameTok = toks[p - 2]; if (args.length !== 1 || !nameTok || (nameTok.t !== 'id' && nameTok.t !== 'str')) throw err('exists(name) takes one property name', t.at); const key = nameTok.v; return (c) => c.props[key] !== undefined && c.props[key] !== null && c.props[key] !== ''; }
        const fn = FUN[low]; if (!fn) throw err(`unknown function "${t.v}" — have: exists, ${Object.keys(FUN).join(', ')}`, t.at);
        return (c) => fn(...args.map((a) => a(c)));
      }
      if (low === 'properties' && isOp('[')) { p++; const k = toks[p]; if (!k || k.t !== 'str') throw err('properties["name"] needs a quoted name'); p++; need(']'); return (c) => c.props[k.v] ?? null; }
      if (t.v[0] === '$') { const k = low.slice(1); if (!['type', 'id', 'index', 'length', 'area', 'vertices', 'lon', 'lat'].includes(k)) throw err(`unknown special "${t.v}" — have: $type $id $index $length $area $vertices $lon $lat`, t.at); return (c) => c.special(k); }
      const key = t.v; return (c) => { const v = c.props[key]; return v === undefined ? null : v; };
    }
    throw err(`unexpected "${t.v}"`, t.at);
  };
  const root = parseOr();
  if (p < toks.length) throw err(`unexpected "${toks[p].v}"`, toks[p].at);
  return (feature, index) => {
    let m, cen;
    return root({
      props: feature.properties || {},
      special(k) {
        const g = feature.geometry;
        if (k === 'type') return g ? g.type : null; if (k === 'id') return feature.id ?? null; if (k === 'index') return index;
        if (k === 'lon' || k === 'lat') { cen ||= (g && centroidOf(g)) || [null, null]; return cen[k === 'lon' ? 0 : 1]; }
        m ||= measureGeom(g, 'haversine'); return k === 'length' ? m.length : k === 'area' ? m.area : m.vertices;
      },
    });
  };
}

export { dist, ringArea };
