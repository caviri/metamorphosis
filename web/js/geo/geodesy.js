// μεταμόρφωσις :: geo/geodesy — distances, areas, projections of single points, tiles, geohash. Pure math, no DOM.
// Coordinates are GeoJSON order: [lon, lat] in degrees, WGS84.

export const WGS84 = { a: 6378137, f: 1 / 298.257223563 };
WGS84.b = WGS84.a * (1 - WGS84.f);
WGS84.e2 = WGS84.f * (2 - WGS84.f);
WGS84.e = Math.sqrt(WGS84.e2);
export const R_MEAN = 6371008.8;        // IUGG mean radius (haversine)
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
export { RAD, DEG };
export const wrapLon = (l) => { l = ((l + 180) % 360 + 360) % 360 - 180; return l === -180 ? 180 : l; };
const wrap360 = (a) => ((a % 360) + 360) % 360;

// ── great circle (sphere) ──
export function haversine(a, b, R = R_MEAN) {
  const p1 = a[1] * RAD, p2 = b[1] * RAD, dp = p2 - p1, dl = (b[0] - a[0]) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function sphBearing(a, b) {
  const p1 = a[1] * RAD, p2 = b[1] * RAD, dl = (b[0] - a[0]) * RAD;
  return wrap360(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * DEG);
}
export function sphDestination(p, bearing, dist, R = R_MEAN) {
  const d = dist / R, t = bearing * RAD, p1 = p[1] * RAD, l1 = p[0] * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [wrapLon(l2 * DEG), p2 * DEG];
}
/** point at fraction t along the great circle a→b */
export function sphInterpolate(a, b, t) {
  const va = toVec(a), vb = toVec(b);
  const w = Math.acos(Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])));
  if (w < 1e-12) return a.slice(0, 2);
  const s = Math.sin(w), A = Math.sin((1 - t) * w) / s, B = Math.sin(t * w) / s;
  return fromVec([A * va[0] + B * vb[0], A * va[1] + B * vb[1], A * va[2] + B * vb[2]]);
}
export const toVec = (p) => { const l = p[0] * RAD, f = p[1] * RAD, c = Math.cos(f); return [c * Math.cos(l), c * Math.sin(l), Math.sin(f)]; };
export const fromVec = (v) => [Math.atan2(v[1], v[0]) * DEG, Math.atan2(v[2], Math.hypot(v[0], v[1])) * DEG];

// ── Vincenty (WGS84 ellipsoid) ──
/** inverse: {distance (m), initialBearing, finalBearing (deg), converged, iterations} */
export function vincentyInverse(p1, p2) {
  const { a, b, f } = WGS84;
  const L = wrapLon(p2[0] - p1[0]) * RAD;
  const U1 = Math.atan((1 - f) * Math.tan(p1[1] * RAD)), U2 = Math.atan((1 - f) * Math.tan(p2[1] * RAD));
  const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
  if (Math.abs(L) < 1e-15 && Math.abs(p1[1] - p2[1]) < 1e-13) return { distance: 0, initialBearing: 0, finalBearing: 0, converged: true, iterations: 0 };
  let lam = L, lamP, it = 0, sS, cS, sigma, sA, c2A, c2SM, sL, cL;
  do {
    sL = Math.sin(lam); cL = Math.cos(lam);
    sS = Math.hypot(cU2 * sL, cU1 * sU2 - sU1 * cU2 * cL);
    if (sS === 0) return { distance: 0, initialBearing: 0, finalBearing: 0, converged: true, iterations: it };
    cS = sU1 * sU2 + cU1 * cU2 * cL;
    sigma = Math.atan2(sS, cS);
    sA = cU1 * cU2 * sL / sS; c2A = 1 - sA * sA;
    c2SM = c2A ? cS - 2 * sU1 * sU2 / c2A : 0;
    const C = f / 16 * c2A * (4 + f * (4 - 3 * c2A));
    lamP = lam;
    lam = L + (1 - C) * f * sA * (sigma + C * sS * (c2SM + C * cS * (-1 + 2 * c2SM * c2SM)));
  } while (Math.abs(lam - lamP) > 1e-12 && ++it < 200);
  const converged = it < 200;
  if (!converged) {
    // nearly antipodal: Vincenty does not converge. Fall back to the great circle on the mean sphere and say so.
    return { distance: haversine(p1, p2), initialBearing: sphBearing(p1, p2), finalBearing: wrap360(sphBearing(p2, p1) + 180), converged: false, iterations: it };
  }
  const u2 = c2A * (a * a - b * b) / (b * b);
  const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dS = B * sS * (c2SM + B / 4 * (cS * (-1 + 2 * c2SM * c2SM) - B / 6 * c2SM * (-3 + 4 * sS * sS) * (-3 + 4 * c2SM * c2SM)));
  const s = b * A * (sigma - dS);
  const a1 = Math.atan2(cU2 * sL, cU1 * sU2 - sU1 * cU2 * cL), a2 = Math.atan2(cU1 * sL, -sU1 * cU2 + cU1 * sU2 * cL);
  return { distance: s, initialBearing: wrap360(a1 * DEG), finalBearing: wrap360(a2 * DEG), converged: true, iterations: it };
}
/** direct: point reached from p travelling `dist` metres on initial bearing (deg) → {point:[lon,lat], finalBearing} */
export function vincentyDirect(p, bearing, dist) {
  const { a, b, f } = WGS84;
  const a1 = bearing * RAD, sA1 = Math.sin(a1), cA1 = Math.cos(a1);
  const tU1 = (1 - f) * Math.tan(p[1] * RAD), cU1 = 1 / Math.sqrt(1 + tU1 * tU1), sU1 = tU1 * cU1;
  const s1 = Math.atan2(tU1, cA1), sA = cU1 * sA1, c2A = 1 - sA * sA;
  const u2 = c2A * (a * a - b * b) / (b * b);
  const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  let sigma = dist / (b * A), sP, c2SM, sS, cS, it = 0;
  do {
    c2SM = Math.cos(2 * s1 + sigma); sS = Math.sin(sigma); cS = Math.cos(sigma);
    const dS = B * sS * (c2SM + B / 4 * (cS * (-1 + 2 * c2SM * c2SM) - B / 6 * c2SM * (-3 + 4 * sS * sS) * (-3 + 4 * c2SM * c2SM)));
    sP = sigma; sigma = dist / (b * A) + dS;
  } while (Math.abs(sigma - sP) > 1e-12 && ++it < 100);
  c2SM = Math.cos(2 * s1 + sigma); sS = Math.sin(sigma); cS = Math.cos(sigma);
  const tmp = sU1 * sS - cU1 * cS * cA1;
  const lat = Math.atan2(sU1 * cS + cU1 * sS * cA1, (1 - f) * Math.hypot(sA, tmp));
  const lam = Math.atan2(sS * sA1, cU1 * cS - sU1 * sS * cA1);
  const C = f / 16 * c2A * (4 + f * (4 - 3 * c2A));
  const L = lam - (1 - C) * f * sA * (sigma + C * sS * (c2SM + C * cS * (-1 + 2 * c2SM * c2SM)));
  return { point: [wrapLon(p[0] + L * DEG), lat * DEG], finalBearing: wrap360(Math.atan2(sA, -tmp) * DEG) };
}
/** ellipsoidal distance in metres (Vincenty; great-circle fallback when nearly antipodal) */
export const dist = (a, b) => vincentyInverse(a, b).distance;

/** length of a coordinate list in metres. method: 'vincenty' | 'haversine' */
export function lineLength(coords, method = 'vincenty') {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += method === 'haversine' ? haversine(coords[i - 1], coords[i]) : dist(coords[i - 1], coords[i]);
  return s;
}

// ── area: authalic sphere ──
// The authalic latitude maps the WGS84 ellipsoid onto a sphere of equal total area, preserving area everywhere.
// Ring area = spherical excess on that sphere (edges taken as great circles there).
const QP = (() => { const { e, e2 } = WGS84; return 1 - (1 - e2) / (2 * e) * Math.log((1 - e) / (1 + e)); })();
export const R_AUTHALIC = WGS84.a * Math.sqrt(QP / 2);   // 6371007.18 m
function authalicLat(latDeg) {
  const { e, e2 } = WGS84, s = Math.sin(latDeg * RAD);
  const q = (1 - e2) * (s / (1 - e2 * s * s) - Math.log((1 - e * s) / (1 + e * s)) / (2 * e));
  return Math.asin(Math.max(-1, Math.min(1, q / QP)));
}
/** unsigned area of one closed ring in m² (the smaller of the two regions the ring bounds) */
export function ringArea(ring) {
  const n = ring.length; if (n < 3) return 0;
  let sum = 0;
  let l0 = ring[n - 1][0] * RAD, p0 = authalicLat(ring[n - 1][1]) / 2 + Math.PI / 4, c0 = Math.cos(p0), s0 = Math.sin(p0);
  for (let i = 0; i < n; i++) {
    const l = ring[i][0] * RAD, p = authalicLat(ring[i][1]) / 2 + Math.PI / 4;
    let dl = l - l0; const sd = dl >= 0 ? 1 : -1; dl *= sd;
    const c = Math.cos(p), s = Math.sin(p), k = s0 * s;
    sum += Math.atan2(k * sd * Math.sin(dl), c0 * c + k * Math.cos(dl));
    l0 = l; c0 = c; s0 = s;
  }
  let A = Math.abs(sum * 2);
  if (A > 2 * Math.PI) A = 4 * Math.PI - A;
  return A * R_AUTHALIC * R_AUTHALIC;
}
/** polygon area m²: outer ring minus holes */
export function polygonArea(rings) {
  if (!rings.length) return 0;
  let a = ringArea(rings[0]);
  for (let i = 1; i < rings.length; i++) a -= ringArea(rings[i]);
  return Math.max(0, a);
}

// ── Web Mercator (EPSG:3857) ──
export const MERC_MAX_LAT = 85.0511287798066;
export function toMercator(p) {
  const lat = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, p[1]));
  return [WGS84.a * p[0] * RAD, WGS84.a * Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2))];
}
export function fromMercator(p) { return [p[0] / WGS84.a * DEG, (2 * Math.atan(Math.exp(p[1] / WGS84.a)) - Math.PI / 2) * DEG]; }

// ── UTM (transverse Mercator, Krüger n-series to n³ — sub-millimetre inside a zone) ──
const TM = (() => {
  const n = WGS84.f / (2 - WGS84.f), n2 = n * n, n3 = n2 * n;
  return {
    n, A: WGS84.a / (1 + n) * (1 + n2 / 4 + n2 * n2 / 64),
    al: [n / 2 - 2 * n2 / 3 + 5 * n3 / 16, 13 * n2 / 48 - 3 * n3 / 5, 61 * n3 / 240],
    be: [n / 2 - 2 * n2 / 3 + 37 * n3 / 96, n2 / 48 + n3 / 15, 17 * n3 / 480],
    de: [2 * n - 2 * n2 / 3 - 2 * n3, 7 * n2 / 3 - 8 * n3 / 5, 56 * n3 / 15],
  };
})();
export const utmZoneOf = (lon, lat) => {
  let z = Math.floor((wrapLon(lon) + 180) / 6) + 1; if (z > 60) z = 60;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) z = 32;                       // Norway
  if (lat >= 72 && lat < 84) { if (lon >= 0 && lon < 9) z = 31; else if (lon >= 9 && lon < 21) z = 33; else if (lon >= 21 && lon < 33) z = 35; else if (lon >= 33 && lon < 42) z = 37; } // Svalbard
  return z;
};
export function toUTM(p, zone, south) {
  const k0 = 0.9996, lon0 = (zone * 6 - 183) * RAD, phi = p[1] * RAD, dl = wrapLon(p[0] - (zone * 6 - 183)) * RAD;
  const c = 2 * Math.sqrt(TM.n) / (1 + TM.n), sp = Math.sin(phi);
  const t = Math.sinh(Math.atanh(sp) - c * Math.atanh(c * sp));
  const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let x = eta, y = xi;
  for (let j = 1; j <= 3; j++) { y += TM.al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); x += TM.al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
  void lon0;
  return [500000 + k0 * TM.A * x, (south ? 10000000 : 0) + k0 * TM.A * y];
}
export function fromUTM(p, zone, south) {
  const k0 = 0.9996, xi = (p[1] - (south ? 10000000 : 0)) / (k0 * TM.A), eta = (p[0] - 500000) / (k0 * TM.A);
  let x = xi, e = eta;
  for (let j = 1; j <= 3; j++) { x -= TM.be[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); e -= TM.be[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
  const chi = Math.asin(Math.sin(x) / Math.cosh(e));
  let phi = chi; for (let j = 1; j <= 3; j++) phi += TM.de[j - 1] * Math.sin(2 * j * chi);
  return [wrapLon(zone * 6 - 183 + Math.atan2(Math.sinh(e), Math.cos(x)) * DEG), phi * DEG];
}

// ── XYZ tiles / quadkeys ──
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z, la = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat)) * RAD;
  const fx = ((lon < -180 || lon > 180 ? wrapLon(lon) : lon) + 180) / 360 * n, fy = (1 - Math.asinh(Math.tan(la)) / Math.PI) / 2 * n;
  return { x: Math.min(n - 1, Math.max(0, Math.floor(fx))), y: Math.min(n - 1, Math.max(0, Math.floor(fy))), z, fx, fy };
}
export function tileBounds(x, y, z) {
  const n = 2 ** z, lat = (yy) => Math.atan(Math.sinh(Math.PI * (1 - 2 * yy / n))) * DEG;
  return [x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)];
}
export function tileToQuadkey(x, y, z) { let q = ''; for (let i = z; i > 0; i--) { const m = 1 << (i - 1); q += ((x & m) ? 1 : 0) + ((y & m) ? 2 : 0); } return q; }
export function quadkeyToTile(q) {
  if (!/^[0-3]*$/.test(q)) throw new Error(`quadkey must contain only digits 0-3 (got "${q}")`);
  let x = 0, y = 0; const z = q.length;
  for (let i = z; i > 0; i--) { const m = 1 << (i - 1), d = +q[z - i]; if (d & 1) x |= m; if (d & 2) y |= m; }
  return { x, y, z };
}

// ── geohash ──
const GH = '0123456789bcdefghjkmnpqrstuvwxyz';
export function geohashEncode(lon, lat, precision = 9) {
  let lo = [-180, 180], la = [-90, 90], even = true, bit = 0, ch = 0, out = '';
  while (out.length < precision) {
    const r = even ? lo : la, v = even ? lon : lat, mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = ch * 2 + 1; r[0] = mid; } else { ch *= 2; r[1] = mid; }
    even = !even;
    if (++bit === 5) { out += GH[ch]; bit = 0; ch = 0; }
  }
  return out;
}
export function geohashDecode(hash) {
  const lo = [-180, 180], la = [-90, 90]; let even = true;
  for (const c of String(hash).toLowerCase()) {
    const i = GH.indexOf(c); if (i < 0) throw new Error(`invalid geohash character "${c}" — alphabet is ${GH}`);
    for (let b = 4; b >= 0; b--) { const r = even ? lo : la, mid = (r[0] + r[1]) / 2; if ((i >> b) & 1) r[0] = mid; else r[1] = mid; even = !even; }
  }
  return { lon: (lo[0] + lo[1]) / 2, lat: (la[0] + la[1]) / 2, bbox: [lo[0], la[0], lo[1], la[1]], lonError: (lo[1] - lo[0]) / 2, latError: (la[1] - la[0]) / 2 };
}
export function geohashNeighbors(hash) {
  const d = geohashDecode(hash), p = hash.length, out = {};
  const dirs = { n: [0, 1], ne: [1, 1], e: [1, 0], se: [1, -1], s: [0, -1], sw: [-1, -1], w: [-1, 0], nw: [-1, 1] };
  for (const [k, [dx, dy]] of Object.entries(dirs)) {
    const lat = d.lat + dy * d.latError * 2; if (lat > 90 || lat < -90) { out[k] = null; continue; }
    out[k] = geohashEncode(wrapLon(d.lon + dx * d.lonError * 2), lat, p);
  }
  return out;
}

export const compass = (deg) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(wrap360(deg) / 22.5) % 16];
