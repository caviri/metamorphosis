// geo.* — maps for models: read any map-ish file, normalise it to GeoJSON, measure it, shrink it, describe it, draw it.
// Coordinates are always GeoJSON order [lon, lat] in degrees (WGS84) unless a tool says otherwise.
// Heavy code (parsers, geodesy, renderer, basemap) lives in ../js/geo/ and is loaded on first use.
import { M, vfs, register } from '../js/core.js';
import { saveCanvas } from '../js/img.js';

let libP;
const lib = () => (libP ||= Promise.all([import('../js/geo/geodesy.js'), import('../js/geo/formats.js'), import('../js/geo/ops.js'), import('../js/geo/render.js')])
  .then(([geo, fmt, ops, rnd]) => ({ geo, fmt, ops, rnd })).catch((e) => { libP = null; throw e; }));

const IN_FORMATS = ['auto', 'geojson', 'geojsonl', 'topojson', 'kml', 'kmz', 'gpx', 'wkt', 'csv', 'polyline', 'shapefile'];
const OUT_FORMATS = ['geojson', 'topojson', 'kml', 'kmz', 'gpx', 'wkt', 'csv', 'polyline'];
const IN = {
  input: { type: 'string', description: 'VFS path of the map file. Accepted: GeoJSON (also newline-delimited), TopoJSON, KML, KMZ, GPX, WKT, CSV with lat/lon or WKT columns, encoded polyline text, Shapefile (.shp with its .dbf/.prj beside it in the VFS, or a .zip of them)' },
  format: { type: 'string', enum: IN_FORMATS, default: 'auto', description: 'Input format. auto = sniff from the content (and extension)' },
  layer: { type: 'string', description: 'Only for multi-layer inputs: TopoJSON object name or shapefile name inside a zip (default: all layers; geo.info lists them)' },
};
const OUT = (what = 'GeoJSON') => ({ type: 'string', description: `VFS path to write (default: derived from the input). ${what} unless the extension says otherwise (.geojson .topojson .kml .kmz .gpx .wkt .csv .polyline)` });
const PT = (what) => ({ type: 'array', items: { type: 'number' }, description: `${what} as [lon, lat] in degrees — longitude first (GeoJSON order), e.g. [-0.1276, 51.5072] for London` });
const BBOX = (what) => ({ type: 'array', items: { type: 'number' }, description: `${what} as [west, south, east, north] in degrees. west > east means the box crosses the antimeridian` });

const r = (v, d = 3) => (Number.isFinite(v) ? +v.toFixed(d) : null);
const km = (m) => r(m / 1000, 3);
const km2 = (m2) => +(m2 / 1e6).toPrecision(7);
const ll = (p, d = 6) => (p ? [r(p[0], d), r(p[1], d)] : null);
const point = (v, name) => { if (!Array.isArray(v) || v.length < 2 || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) throw new Error(`"${name}" must be [lon, lat] (two numbers, longitude first)`); if (Math.abs(v[1]) > 90) throw new Error(`"${name}" latitude ${v[1]} is outside ±90 — order is [lon, lat]; did you pass [lat, lon]?`); return [v[0], v[1]]; };
const box = (v, name = 'bbox') => { if (!Array.isArray(v) || v.length !== 4 || v.some((x) => !Number.isFinite(x))) throw new Error(`"${name}" must be four numbers [west, south, east, north]`); if (v[1] > v[3]) throw new Error(`"${name}" has south > north — order is [west, south, east, north]`); return v; };

async function load(args, extra = {}) {
  const { fmt } = await lib();
  const path = args.input; const bytes = vfs.read(path);
  const stem = path.replace(/\.[A-Za-z0-9]+$/, '');
  const sibling = (ext) => { for (const e of [ext, ext.toUpperCase()]) if (vfs.exists(`${stem}.${e}`)) return vfs.read(`${stem}.${e}`); return null; };
  const res = await fmt.parse(bytes, { name: path, format: args.format, layer: args.layer, sibling, ...extra });
  res.bytes = bytes.length;
  return res;
}
/** refuse to treat projected metres as degrees */
async function needLonLat(fc, tool) {
  const { ops } = await lib(); const b = ops.bboxOf(fc).bbox; if (!b) return;
  if (b[1] < -90.0001 || b[3] > 90.0001 || b[0] < -540 || b[2] > 540) throw new Error(`${tool}: coordinates are not lon/lat degrees (x ${r(b[0], 1)}…${r(b[2], 1)}, y ${r(b[1], 1)}…${r(b[3], 1)}) — they look projected. Run geo.reproject from=<its CRS, e.g. EPSG:3857 or EPSG:32633> to=EPSG:4326 first`);
}
const formatOfPath = (p) => { const e = vfs.extOf(p || ''); return e === 'json' ? 'geojson' : OUT_FORMATS.includes(e) ? e : null; };
async function saveFC(fc, args, tag, opts = {}) {
  const { fmt, ops } = await lib();
  const format = opts.format || formatOfPath(args.output) || 'geojson';
  const w = await fmt.write(fc, format, { name: vfs.stemOf(args.output || args.input || tag), ...opts });
  const path = vfs.out(args.output, args.input || tag, args.input ? tag : '', w.ext);
  const stat = await vfs.write(path, w.data, { mime: w.mime, meta: { features: fc.features.length, vertices: ops.vertexCount(fc) } });
  return { stat, notes: w.notes, format };
}
const notesOf = (...lists) => { const n = lists.flat().filter(Boolean); return n.length ? { notes: n.slice(0, 12) } : {}; };

// ───────────────────────────────────────────────────────────── info ──
const CSV_ARGS = {
  lonColumn: { type: 'string', description: 'CSV only: name of the longitude column (default: auto-detect lon/lng/long/longitude/x)' },
  latColumn: { type: 'string', description: 'CSV only: name of the latitude column (default: auto-detect lat/latitude/y)' },
  wktColumn: { type: 'string', description: 'CSV only: name of a column holding WKT geometry (default: auto-detect wkt/geometry/geom/the_geom when no lat/lon pair is found)' },
  delimiter: { type: 'string', description: 'CSV only: field delimiter (default: sniffed from , ; tab |)' },
  polylinePrecision: { type: 'integer', default: 5, minimum: 1, maximum: 8, description: 'Encoded polyline only: decimal digits (5 = Google/OSRM default, 6 = Valhalla/OSRM polyline6)' },
};
const csvOpts = (a) => ({ csv: { lon: a.lonColumn, lat: a.latColumn, wkt: a.wktColumn, delimiter: a.delimiter === '\\t' || a.delimiter === 'tab' ? '\t' : a.delimiter }, polylinePrecision: a.polylinePrecision });

function crsHint(res, bbox) {
  const out = {};
  if (res.crs) Object.assign(out, res.crs);
  if (bbox) {
    const lonlat = bbox[1] >= -90.0001 && bbox[3] <= 90.0001 && bbox[0] >= -360.0001 && bbox[2] <= 360.0001;
    out.coordinates = lonlat ? 'within lon/lat range (assumed WGS84 degrees)' : 'outside lon/lat range — projected coordinates';
    if (!lonlat && !out.suggest) {
      const m = Math.max(Math.abs(bbox[0]), Math.abs(bbox[2]));
      if (bbox[0] >= 100000 && bbox[2] <= 900000 && bbox[1] >= 0 && bbox[3] <= 10000000) out.guess = 'x in 100 000…900 000 and y in 0…10 000 000 fits UTM (EPSG:326xx north / 327xx south — the zone is not recoverable from the numbers) and also Web Mercator';
      else if (m <= 20037508.35) out.guess = 'magnitudes fit Web Mercator (EPSG:3857)';
    }
  }
  return out;
}

register({
  name: 'geo.info', readOnly: true,
  description: 'Inspect a map file without converting it. Sniffs the format (GeoJSON, TopoJSON, KML/KMZ, GPX, WKT, CSV, encoded polyline, Shapefile) and returns: feature count, geometry types, vertex count, bounding box (antimeridian-aware), CRS hints, whether elevation/time are present, total geodesic length and area, and the property keys with their types, ranges and sample values (first 40 keys). Use it first on any unknown geo file.',
  schema: { properties: { ...IN, ...CSV_ARGS }, required: ['input'] },
  examples: ['geo.info input=countries.topojson', 'geo.info input=stops.csv lonColumn=stop_lon latColumn=stop_lat'],
  async run(args) {
    const { ops } = await lib();
    const res = await load(args, csvOpts(args)); const fc = res.fc;
    const bb = ops.bboxOf(fc); const crs = crsHint(res, bb.bbox); const lonlat = /^within/.test(crs.coordinates || '');
    let length = 0, area = 0, perimeter = 0, z = 0, times = 0, nulls = 0, vertices = 0;
    for (const f of fc.features) {
      if (!f.geometry) { nulls++; continue; }
      ops.eachPos(f.geometry, (c) => { vertices++; if (c.length > 2 && Number.isFinite(c[2])) z++; });
      if (f.properties && f.properties.coordinateProperties && f.properties.coordinateProperties.times) times++;
      if (lonlat) { const m = ops.measureGeom(f.geometry, vertices > 400000 ? 'haversine' : 'vincenty'); length += m.length; area += m.area; perimeter += m.perimeter; }
    }
    const span = bb.bbox ? ops.bboxSpan(bb.bbox) : null;
    const props = ops.propertyStats(fc);
    return {
      path: args.input, format: res.format, bytes: res.bytes, features: fc.features.length, geometryTypes: ops.typeCounts(fc), nullGeometries: nulls, vertices,
      bbox: bb.bbox ? bb.bbox.map((v) => r(v, 6)) : null, crossesAntimeridian: bb.crossesAntimeridian,
      center: bb.bbox && lonlat ? ll([bb.bbox[0] + span[0] / 2 > 180 ? bb.bbox[0] + span[0] / 2 - 360 : bb.bbox[0] + span[0] / 2, (bb.bbox[1] + bb.bbox[3]) / 2]) : null,
      spanDegrees: span ? span.map((v) => r(v, 6)) : null,
      crs,
      elevation: z ? { verticesWithZ: z } : false, timestamps: times ? { featuresWithTimes: times } : false,
      totals: lonlat ? { lengthKm: km(length), areaKm2: km2(area), perimeterKm: km(perimeter), method: 'lengths: Vincenty on WGS84; areas: authalic-sphere spherical excess' } : null,
      layers: res.layers, properties: props.keys, propertyKeys: props.total, propertiesTruncated: props.truncated || undefined,
      ...notesOf(res.notes),
    };
  },
});

// ────────────────────────────────────────────────────────── convert ──
register({
  name: 'geo.convert',
  description: 'Convert a map file between formats, normalising it on the way. Reads GeoJSON, newline-delimited GeoJSON, TopoJSON, KML, KMZ, GPX (tracks, routes, waypoints with elevation and time), WKT/EWKT, CSV (lat/lon columns or a WKT column, auto-detected), encoded polyline and Shapefile (.shp+.dbf+.prj, loose or zipped). Writes GeoJSON (default — a clean FeatureCollection that every other geo tool and any LLM can read), TopoJSON, KML, KMZ, GPX, WKT, CSV or encoded polyline. Shapefile cannot be written. Returns the output file plus notes on anything the target format could not hold.',
  schema: {
    properties: {
      ...IN,
      to: { type: 'string', enum: OUT_FORMATS, description: 'Output format (default: from the output extension, else geojson)' },
      output: { type: 'string', description: 'VFS path to write (default: <input stem>.<ext>)' },
      ...CSV_ARGS,
      precision: { type: 'integer', minimum: 0, maximum: 15, description: 'Round coordinates to this many decimals while converting (6 ≈ 0.11 m). Default: keep as read' },
      quantization: { type: 'integer', default: 1000000, minimum: 100, maximum: 100000000, description: 'TopoJSON output only: grid steps per axis' },
      pretty: { type: 'boolean', default: false, description: 'GeoJSON output only: indent for reading (larger file)' },
    },
    required: ['input'],
  },
  examples: ['geo.convert input=route.gpx', 'geo.convert input=parcels.zip to=kml', 'geo.convert input=cities.csv to=geojson lonColumn=x latColumn=y'],
  async run(args) {
    const { ops } = await lib();
    const res = await load(args, csvOpts(args)); let fc = res.fc;
    const to = args.to || formatOfPath(args.output) || 'geojson';
    if (args.precision !== undefined) { const d = args.precision; fc = { ...fc, features: fc.features.map((f) => ({ ...f, geometry: ops.mapPos(f.geometry, (c) => c.map((v, i) => (i < 2 ? +v.toFixed(d) : +v.toFixed(Math.min(d, 2))))) })) }; }
    const path = vfs.out(args.output, args.input, vfs.extOf(args.input) === to ? 'converted' : '', to);
    const out = await saveFC(fc, { ...args, output: path }, '', { format: to, quantization: args.quantization, pretty: args.pretty, polylinePrecision: args.polylinePrecision });
    return { output: out.stat, from: res.format, to, features: fc.features.length, geometryTypes: ops.typeCounts(fc), vertices: ops.vertexCount(fc), inputBytes: res.bytes, ...notesOf(res.notes, out.notes) };
  },
});

// ─────────────────────────────────────────────── simplify / precision ──
register({
  name: 'geo.simplify',
  description: 'Reduce the vertex count of lines and polygons so a dataset fits a model context or draws faster. Two algorithms: Douglas-Peucker ("dp", keeps points farther than the tolerance from the simplified line — best for tracks and roads) and Visvalingam-Whyatt ("visvalingam", removes the vertices spanning the smallest triangles — best for coastlines and borders). Give ONE of: tolerance (metres), targetVertices (absolute), ratio (fraction of vertices to keep). Line ends are always kept and rings never drop below 4 positions; each line is simplified on its own, so borders shared by neighbouring polygons may no longer match exactly. Returns vertices and bytes before/after.',
  schema: {
    properties: {
      ...IN,
      method: { type: 'string', enum: ['dp', 'visvalingam'], default: 'dp', description: 'dp = Douglas-Peucker, visvalingam = Visvalingam-Whyatt' },
      tolerance: { type: 'number', minimum: 0, description: 'Metres. dp: maximum sideways deviation. visvalingam: vertices whose triangle is smaller than tolerance² m² are removed' },
      targetVertices: { type: 'integer', minimum: 2, description: 'Keep (about) this many vertices in the whole file; the tolerance is solved for you' },
      ratio: { type: 'number', minimum: 0.0001, maximum: 1, description: 'Keep this fraction of the vertices, e.g. 0.1' },
      output: OUT(),
    },
    required: ['input'],
  },
  examples: ['geo.simplify input=coast.geojson ratio=0.05 method=visvalingam', 'geo.simplify input=ride.gpx tolerance=10 output=ride.small.gpx'],
  async run(args) {
    const { ops } = await lib();
    const given = ['tolerance', 'targetVertices', 'ratio'].filter((k) => args[k] !== undefined);
    if (given.length !== 1) throw new Error(`give exactly one of: tolerance (metres), targetVertices, ratio — got ${given.length ? given.join(' + ') : 'none'}`);
    const res = await load(args); await needLonLat(res.fc, 'geo.simplify');
    const total = ops.vertexCount(res.fc);
    const target = args.targetVertices ?? (args.ratio !== undefined ? Math.max(2, Math.round(total * args.ratio)) : undefined);
    const s = ops.simplify(res.fc, { method: args.method, tolerance: args.tolerance, target });
    const bytesBefore = JSON.stringify(res.fc).length;
    const out = await saveFC(s.fc, args, 'simplified');
    const bytesAfterGeoJSON = out.format === 'geojson' ? out.stat.bytes : JSON.stringify(s.fc).length;
    return {
      output: out.stat, method: args.method === 'dp' ? 'Douglas-Peucker' : 'Visvalingam-Whyatt',
      verticesBefore: s.before, verticesAfter: s.after, target: target ?? null, kept: r(s.after / Math.max(1, s.before), 4),
      toleranceMeters: s.tolerance === null ? null : +s.tolerance.toPrecision(5),
      bytesBefore, bytesAfter: bytesAfterGeoJSON, bytesNote: 'both measured as compact GeoJSON', inputBytes: res.bytes,
      ...notesOf(res.notes, out.notes, target !== undefined && s.after > target ? [`could not go below ${s.after} vertices: line ends and 4-position rings are always kept`] : []),
    };
  },
});

register({
  name: 'geo.precision',
  description: 'Round every coordinate to N decimals — the cheapest way to shrink map data for an LLM (15-digit floats are mostly noise: 6 decimals ≈ 0.11 m, 5 ≈ 1.1 m, 4 ≈ 11 m, 3 ≈ 111 m at the equator). Optionally drops elevation and removes consecutive duplicate vertices created by the rounding. Returns bytes before/after and the worst-case shift in metres.',
  schema: {
    properties: {
      ...IN,
      decimals: { type: 'integer', default: 6, minimum: 0, maximum: 15, description: 'Decimal places to keep for lon/lat' },
      dropZ: { type: 'boolean', default: false, description: 'Remove elevation (third coordinate)' },
      dedupe: { type: 'boolean', default: true, description: 'Drop vertices that become identical to their predecessor (lines keep ≥2, rings ≥4 positions)' },
      output: OUT(),
    },
    required: ['input'],
  },
  examples: ['geo.precision input=parcels.geojson decimals=5'],
  async run(args) {
    const { ops } = await lib();
    const res = await load(args); const d = args.decimals;
    const rnd = (c) => { const o = [+c[0].toFixed(d), +c[1].toFixed(d)]; if (!args.dropZ && c.length > 2 && Number.isFinite(c[2])) o.push(+c[2].toFixed(1)); return o; };
    const before = ops.vertexCount(res.fc);
    const features = res.fc.features.map((f) => {
      let g = ops.mapPos(f.geometry, rnd);
      const masks = [];
      if (args.dedupe) g = ops.mapLines(g, (line, ring) => { const o = [], keep = []; line.forEach((c, i) => { const p = o[o.length - 1]; if (!p || p[0] !== c[0] || p[1] !== c[1]) { o.push(c); keep.push(i); } }); const ok = o.length >= (ring ? 4 : 2); masks.push(ok ? keep : line.map((_, i) => i)); return ok ? o : line; });
      return { ...f, geometry: g, properties: args.dedupe ? ops.syncCoordProps({ ...f, geometry: g }, masks) : f.properties };
    });
    const fc = { ...res.fc, features };
    const bytesBefore = JSON.stringify(res.fc).length;
    const out = await saveFC(fc, args, `p${d}`);
    const bytesAfter = out.format === 'geojson' ? out.stat.bytes : JSON.stringify(fc).length;
    return { output: out.stat, decimals: d, maxShiftMeters: +(0.5 * 10 ** -d * 111320 * Math.SQRT2).toPrecision(3), verticesBefore: before, verticesAfter: ops.vertexCount(fc), bytesBefore, bytesAfter, saved: r(1 - bytesAfter / bytesBefore, 4), bytesNote: 'both measured as compact GeoJSON', ...notesOf(res.notes, out.notes) };
  },
});

// ────────────────────────────────────────────────────────── measure ──
const nameOf = (f, key) => { const p = f.properties || {}; const v = key ? p[key] : p.name ?? p.NAME ?? p.Name ?? p.title ?? p.id ?? f.id; return v === undefined || v === null ? undefined : String(v).slice(0, 60); };
register({
  name: 'geo.measure', readOnly: true,
  description: 'Geodesic size of every feature and of the whole file: line length, polygon area and perimeter, vertex count. Lengths use Vincenty\'s inverse formula on the WGS84 ellipsoid (or haversine on a 6371.0088 km sphere with method=haversine). Areas use the spherical-excess formula on the WGS84 authalic sphere (R = 6371.0072 km) with authalic latitudes — equal-area with the ellipsoid, holes subtracted, valid across the antimeridian and at the poles. Returns totals plus a per-feature table (largest first, capped by limit).',
  schema: {
    properties: {
      ...IN,
      method: { type: 'string', enum: ['vincenty', 'haversine'], default: 'vincenty', description: 'Formula for lengths and perimeters' },
      nameProperty: { type: 'string', description: 'Property used to name features in the table (default: name/title/id)' },
      sort: { type: 'string', enum: ['size', 'file'], default: 'size', description: 'size = largest area/length first, file = original order' },
      limit: { type: 'integer', default: 50, minimum: 0, maximum: 500, description: 'Maximum rows in the per-feature table' },
    },
    required: ['input'],
  },
  examples: ['geo.measure input=countries.geojson nameProperty=name limit=10'],
  async run(args) {
    const { ops } = await lib();
    const res = await load(args); await needLonLat(res.fc, 'geo.measure');
    const rows = []; const tot = { length: 0, area: 0, perimeter: 0, vertices: 0 };
    res.fc.features.forEach((f, i) => { if (!f.geometry) return; const m = ops.measureGeom(f.geometry, args.method); tot.length += m.length; tot.area += m.area; tot.perimeter += m.perimeter; tot.vertices += m.vertices; rows.push({ i, f, m }); });
    if (args.sort === 'size') rows.sort((a, b) => b.m.area - a.m.area || b.m.length - a.m.length);
    return {
      features: res.fc.features.length,
      totals: { lengthM: r(tot.length, 2), lengthKm: km(tot.length), areaM2: r(tot.area, 1), areaKm2: km2(tot.area), perimeterKm: km(tot.perimeter), vertices: tot.vertices },
      method: { length: args.method === 'vincenty' ? 'Vincenty inverse, WGS84 ellipsoid (a=6378137 m, 1/f=298.257223563)' : 'haversine, sphere R=6371008.8 m', area: 'spherical excess on the WGS84 authalic sphere (R=6371007.18 m), authalic latitudes; edges are great-circle arcs' },
      perFeature: rows.slice(0, args.limit).map(({ i, f, m }) => ({ index: i, name: nameOf(f, args.nameProperty), type: f.geometry.type, vertices: m.vertices, ...(m.length ? { lengthKm: km(m.length) } : {}), ...(m.area ? { areaKm2: km2(m.area), perimeterKm: km(m.perimeter) } : {}) })),
      truncated: rows.length > args.limit, ...notesOf(res.notes),
    };
  },
});

register({
  name: 'geo.distance', readOnly: true,
  description: 'Distance between two points, both ways of computing it: Vincenty\'s geodesic on the WGS84 ellipsoid (accurate to millimetres) and the haversine great circle on a 6371.0088 km sphere (off by up to ~0.5%). Also returns initial/final bearing and the midpoint. No file needed.',
  schema: { properties: { from: PT('Start point'), to: PT('End point') }, required: ['from', 'to'] },
  examples: ['geo.distance from=-0.1276,51.5072 to=-74.006,40.7128'],
  async run(args) {
    const { geo } = await lib(); const a = point(args.from, 'from'), b = point(args.to, 'to');
    const v = geo.vincentyInverse(a, b), h = geo.haversine(a, b);
    return {
      vincenty: { meters: r(v.distance, 3), km: r(v.distance / 1000, 4), converged: v.converged, note: v.converged ? undefined : 'points are nearly antipodal: Vincenty did not converge, value is the great-circle distance' },
      haversine: { meters: r(h, 3), km: r(h / 1000, 4) },
      differencePercent: v.distance ? r((h - v.distance) / v.distance * 100, 4) : 0,
      nauticalMiles: r(v.distance / 1852, 3), miles: r(v.distance / 1609.344, 3),
      initialBearing: r(v.initialBearing, 4), finalBearing: r(v.finalBearing, 4), compass: geo.compass(v.initialBearing),
      midpoint: ll(geo.sphInterpolate(a, b, 0.5)),
    };
  },
});

register({
  name: 'geo.bearing', readOnly: true,
  description: 'Direction from one point to another in degrees clockwise from true north: the geodesic initial and final bearing (Vincenty, WGS84), the great-circle initial bearing on a sphere, and the constant rhumb-line (loxodrome) bearing with its length. Returns a 16-point compass name too.',
  schema: { properties: { from: PT('Start point'), to: PT('End point') }, required: ['from', 'to'] },
  examples: ['geo.bearing from=-0.1276,51.5072 to=-74.006,40.7128'],
  async run(args) {
    const { geo } = await lib(); const a = point(args.from, 'from'), b = point(args.to, 'to');
    const v = geo.vincentyInverse(a, b);
    const dpsi = Math.log(Math.tan(Math.PI / 4 + b[1] * geo.RAD / 2) / Math.tan(Math.PI / 4 + a[1] * geo.RAD / 2));
    let dl = (b[0] - a[0]) * geo.RAD; if (Math.abs(dl) > Math.PI) dl -= Math.sign(dl) * 2 * Math.PI;
    const dphi = (b[1] - a[1]) * geo.RAD, q = Math.abs(dpsi) > 1e-12 ? dphi / dpsi : Math.cos(a[1] * geo.RAD);
    const rhumb = ((Math.atan2(dl, dpsi) * geo.DEG) + 360) % 360;
    return {
      initialBearing: r(v.initialBearing, 4), finalBearing: r(v.finalBearing, 4), compass: geo.compass(v.initialBearing),
      greatCircleInitialBearing: r(geo.sphBearing(a, b), 4),
      rhumb: { bearing: r(rhumb, 4), compass: geo.compass(rhumb), km: r(Math.hypot(dphi, q * dl) * geo.R_MEAN / 1000, 3) },
      distanceKm: r(v.distance / 1000, 4), method: 'Vincenty inverse on WGS84; rhumb line on a 6371.0088 km sphere',
    };
  },
});

register({
  name: 'geo.destination', readOnly: true,
  description: 'Where you end up travelling a given distance from a point on a given initial bearing along the geodesic (Vincenty direct formula, WGS84). The inverse of geo.distance. Returns the destination [lon, lat] and the arrival bearing.',
  schema: { properties: { from: PT('Start point'), bearing: { type: 'number', description: 'Initial bearing in degrees clockwise from north (90 = east)' }, distance: { type: 'number', minimum: 0, description: 'Distance in metres' } }, required: ['from', 'bearing', 'distance'] },
  examples: ['geo.destination from=2.3522,48.8566 bearing=45 distance=100000'],
  async run(args) { const { geo } = await lib(); const d = geo.vincentyDirect(point(args.from, 'from'), args.bearing, args.distance); return { point: ll(d.point, 7), lon: r(d.point[0], 7), lat: r(d.point[1], 7), finalBearing: r(d.finalBearing, 4), method: 'Vincenty direct, WGS84' }; },
});

register({
  name: 'geo.greatCircle',
  description: 'Write the shortest path between two points as a densified GeoJSON line (points interpolated along the great circle), cut into two parts where it crosses the antimeridian. Use it to draw flight-style arcs with geo.render — a plain two-point line would be drawn straight in lon/lat. Returns the file and the geodesic length.',
  schema: { properties: { from: PT('Start point'), to: PT('End point'), points: { type: 'integer', default: 96, minimum: 2, maximum: 5000, description: 'Number of vertices along the path' }, name: { type: 'string', description: 'Value for the "name" property of the line' }, output: { type: 'string', description: 'VFS path to write (default: greatcircle.geojson)' } }, required: ['from', 'to'] },
  examples: ['geo.greatCircle from=139.69,35.69 to=-122.42,37.77 output=tokyo-sf.geojson'],
  async run(args) {
    const { geo, ops } = await lib(); const a = point(args.from, 'from'), b = point(args.to, 'to');
    const pts = []; for (let i = 0; i < args.points; i++) pts.push(geo.sphInterpolate(a, b, i / (args.points - 1)).map((v) => +v.toFixed(6)));
    pts[0] = a; pts[pts.length - 1] = b;
    const parts = [[pts[0]]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      if (Math.abs(q[0] - p[0]) > 180) { const qx = q[0] + (q[0] < p[0] ? 360 : -360), edge = qx > p[0] ? 180 : -180, t = (edge - p[0]) / (qx - p[0]), lat = +(p[1] + (q[1] - p[1]) * t).toFixed(6); parts[parts.length - 1].push([edge, lat]); parts.push([[-edge, lat]]); }
      parts[parts.length - 1].push(q);
    }
    const v = geo.vincentyInverse(a, b);
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: args.name || 'great circle', distance_km: r(v.distance / 1000, 3) }, geometry: parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts } }] };
    const out = await saveFC(fc, { output: args.output || vfs.unique('greatcircle', 'geojson') }, 'greatcircle');
    return { output: out.stat, distanceKm: r(v.distance / 1000, 4), vertices: ops.vertexCount(fc), crossesAntimeridian: parts.length > 1, initialBearing: r(v.initialBearing, 3) };
  },
});

// ────────────────────────────────────────── bbox / centroid / hull ──
register({
  name: 'geo.bbox',
  description: 'Bounding box of a map file as [west, south, east, north], antimeridian-aware: data straddling ±180° (Fiji, the Aleutians, Pacific routes) gets a box with west > east instead of one spanning the whole globe. Also returns the centre and the box size in degrees and kilometres. Give output= to also write the box as a GeoJSON polygon.',
  schema: { properties: { ...IN, output: { type: 'string', description: 'Optional VFS path: write the box as a GeoJSON Polygon feature (nothing is written when omitted)' } }, required: ['input'] },
  examples: ['geo.bbox input=track.gpx'],
  async run(args) {
    const { ops, geo } = await lib();
    const res = await load(args); const bb = ops.bboxOf(res.fc);
    if (!bb.bbox) throw new Error('the file has no coordinates');
    const [w, s, e, n] = bb.bbox; const span = ops.bboxSpan(bb.bbox); const cl = geo.wrapLon(w + span[0] / 2), cy = (s + n) / 2;
    const lonlat = Math.abs(s) <= 90 && Math.abs(n) <= 90 && Math.abs(w) <= 360;
    const out = { bbox: bb.bbox.map((v) => r(v, 7)), crossesAntimeridian: bb.crossesAntimeridian, center: [r(cl, 7), r(cy, 7)], spanDegrees: span.map((v) => r(v, 7)), vertices: bb.count };
    if (lonlat) { out.widthKm = km(geo.haversine([w, cy], [w + span[0] / 2, cy]) * 2); out.heightKm = km(geo.dist([cl, s], [cl, n])); out.widthNote = 'width measured along the middle latitude'; }
    if (args.output) { const e2 = w + span[0]; const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { source: args.input }, bbox: bb.bbox, geometry: { type: 'Polygon', coordinates: [[[w, s], [e2, s], [e2, n], [w, n], [w, s]]] } }] }; out.output = (await saveFC(fc, args, 'bbox')).stat; if (bb.crossesAntimeridian) out.note = 'the written polygon uses east longitudes above 180 to stay in one piece'; }
    return { ...out, ...notesOf(res.notes) };
  },
});

register({
  name: 'geo.centroid',
  description: 'Centre point of the whole dataset and of each feature: polygons by area, lines by length, points by mean — averaged on the sphere, so it is correct across the antimeridian. Returns the overall centroid and a per-feature list (capped by limit). Give output= to write the centroids as a GeoJSON point layer carrying the original properties (handy for labelling or for turning polygons into points).',
  schema: { properties: { ...IN, limit: { type: 'integer', default: 50, minimum: 0, maximum: 500, description: 'Maximum per-feature centroids returned inline' }, output: { type: 'string', description: 'Optional VFS path: write one Point per feature (nothing is written when omitted)' } }, required: ['input'] },
  examples: ['geo.centroid input=countries.geojson output=country-points.geojson'],
  async run(args) {
    const { ops } = await lib();
    const res = await load(args); await needLonLat(res.fc, 'geo.centroid');
    const pts = res.fc.features.map((f) => (f.geometry ? ops.centroidOf(f.geometry) : null));
    const maxDim = Math.max(-1, ...res.fc.features.map((f) => ops.dimOf(f.geometry)));
    const all = ops.centroidOf({ type: 'GeometryCollection', geometries: res.fc.features.filter((f) => f.geometry && ops.dimOf(f.geometry) === maxDim).map((f) => f.geometry) });
    const out = { centroid: ll(all), basis: ['mean of points', 'length-weighted lines', 'area-weighted polygons'][maxDim] || 'no geometry', features: res.fc.features.length, perFeature: res.fc.features.slice(0, args.limit).map((f, i) => ({ index: i, name: nameOf(f), centroid: ll(pts[i]) })), truncated: res.fc.features.length > args.limit };
    if (args.output) { const fc = { type: 'FeatureCollection', features: res.fc.features.map((f, i) => (pts[i] ? { type: 'Feature', properties: { ...f.properties }, geometry: { type: 'Point', coordinates: ll(pts[i], 7) } } : null)).filter(Boolean) }; out.output = (await saveFC(fc, args, 'centroids')).stat; }
    return { ...out, ...notesOf(res.notes) };
  },
});

register({
  name: 'geo.convexHull',
  description: 'Smallest convex polygon containing every vertex of the dataset (Andrew monotone chain in the lon/lat plane, antimeridian-aware). Use it for a quick footprint/coverage outline of scattered points or tracks. Writes the hull as a GeoJSON polygon and returns its area, perimeter and vertex count.',
  schema: { properties: { ...IN, output: OUT() }, required: ['input'] },
  examples: ['geo.convexHull input=sightings.csv'],
  async run(args) {
    const { ops } = await lib();
    const res = await load(args); await needLonLat(res.fc, 'geo.convexHull');
    const h = ops.convexHull(res.fc); if (!h.geometry) throw new Error('the file has no coordinates to build a hull from');
    const m = ops.measureGeom(h.geometry);
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { source: args.input, inputVertices: ops.vertexCount(res.fc) }, geometry: h.geometry }] };
    const out = await saveFC(fc, args, 'hull');
    return { output: out.stat, hullType: h.geometry.type, hullVertices: m.vertices, areaKm2: km2(m.area), perimeterKm: km(m.perimeter || m.length), inputVertices: ops.vertexCount(res.fc), ...notesOf(res.notes, h.shifted ? ['data crosses the antimeridian: hull longitudes west of it are written as lon+360 to keep the polygon in one piece'] : [], ['hull edges are straight in lon/lat, not great circles']) };
  },
});

// ─────────────────────────────────────────── filter / clip / merge ──
const TYPE_ALIAS = { point: ['Point', 'MultiPoint'], line: ['LineString', 'MultiLineString'], polygon: ['Polygon', 'MultiPolygon'] };
register({
  name: 'geo.filter',
  description: 'Keep only the features you want: by bounding box, by geometry type, and/or by a property expression. The expression language is small and safe (no eval): property names (`odd name` in backticks), numbers, "strings", true/false/null, comparison == != < <= > >=, logic && || ! (or and/or/not), arithmetic + - * / %, `in [a, b]`, text tests `contains` `startswith` `endswith` and `~ "regex"` (case-insensitive), functions lower() upper() len() abs() round() number() string() coalesce() exists(name), and specials $type $id $index $length (m) $area (m²) $vertices $lon $lat (centroid). Can also keep/drop property columns to shrink the file. Returns how many features were kept.',
  schema: {
    properties: {
      ...IN,
      where: { type: 'string', description: 'Expression evaluated per feature, e.g. pop_est > 5e7 && continent == "Asia", name ~ "^san ", $area > 1e9, type in ["park", "forest"]' },
      bbox: BBOX('Keep features touching this box'),
      bboxMode: { type: 'string', enum: ['intersects', 'within', 'centroid'], default: 'intersects', description: 'intersects = the feature\'s own bbox overlaps the box; within = every vertex is inside; centroid = the centroid is inside' },
      types: { type: 'array', items: { type: 'string' }, description: 'Geometry types to keep: point, line, polygon (each includes its Multi form) or exact GeoJSON type names' },
      invert: { type: 'boolean', default: false, description: 'Keep the features that do NOT match instead' },
      limit: { type: 'integer', minimum: 1, description: 'Keep at most this many matching features (first in file order)' },
      keepProperties: { type: 'array', items: { type: 'string' }, description: 'Drop every property except these keys' },
      dropProperties: { type: 'array', items: { type: 'string' }, description: 'Drop these property keys' },
      output: OUT(),
    },
    required: ['input'],
  },
  examples: ['geo.filter input=countries.geojson where=\'pop_est > 1e8\'', 'geo.filter input=pois.geojson bbox=2.2,48.8,2.5,48.95 types=point keepProperties=name,amenity'],
  async run(args) {
    const { ops } = await lib();
    const res = await load(args);
    const test = args.where ? ops.compileExpr(args.where) : null;
    const b = args.bbox ? box(args.bbox) : null;
    let types = null;
    if (args.types && args.types.length) { types = new Set(); for (const t of args.types) { const a = TYPE_ALIAS[t.toLowerCase().replace(/s$/, '')]; if (a) a.forEach((x) => types.add(x)); else { const exact = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].find((x) => x.toLowerCase() === t.toLowerCase()); if (!exact) throw new Error(`unknown geometry type "${t}" — use point, line, polygon or a GeoJSON type name`); types.add(exact); } } }
    const inB = (f) => {
      if (!f.geometry) return false;
      if (args.bboxMode === 'centroid') { const c = ops.centroidOf(f.geometry); return !!c && ops.inBbox(c, b); }
      if (args.bboxMode === 'within') { let ok = true, n = 0; ops.eachPos(f.geometry, (c) => { n++; if (!ops.inBbox(c, b)) ok = false; }); return ok && n > 0; }
      const fb = ops.bboxOf(f.geometry).bbox; return !!fb && ops.bboxIntersects(fb, b);
    };
    const kept = []; let matched = 0;
    res.fc.features.forEach((f, i) => {
      let ok = true;
      if (types && !(f.geometry && types.has(f.geometry.type))) ok = false;
      if (ok && b && !inB(f)) ok = false;
      if (ok && test && !test(f, i)) ok = false;
      if (args.invert) ok = !ok;
      if (ok) { matched++; if (!args.limit || kept.length < args.limit) kept.push(f); }
    });
    let features = kept;
    if (args.keepProperties || args.dropProperties) {
      const keep = args.keepProperties ? new Set(args.keepProperties) : null, drop = new Set(args.dropProperties || []);
      features = kept.map((f) => ({ ...f, properties: Object.fromEntries(Object.entries(f.properties || {}).filter(([k]) => (!keep || keep.has(k)) && !drop.has(k))) }));
    }
    const fc = { type: 'FeatureCollection', features };
    const out = await saveFC(fc, args, 'filtered');
    return { output: out.stat, featuresBefore: res.fc.features.length, matched, kept: features.length, removed: res.fc.features.length - features.length, geometryTypes: ops.typeCounts(fc), ...notesOf(res.notes, out.notes, matched > features.length ? [`limit=${args.limit} cut ${matched - features.length} further matches`] : []) };
  },
});

register({
  name: 'geo.clip',
  description: 'Cut geometry to a bounding box: points outside are dropped, lines are cut at the box edge (Liang-Barsky), polygons are trimmed to the box (Sutherland-Hodgman). Unlike geo.filter, features are actually cut, so nothing sticks out. A concave polygon that the box splits into several pieces stays one ring joined along the box edge. Returns features and vertices before/after.',
  schema: { properties: { ...IN, bbox: BBOX('Clip box'), output: OUT() }, required: ['input', 'bbox'] },
  examples: ['geo.clip input=world.geojson bbox=-10,35,30,60 output=europe.geojson'],
  async run(args) {
    const { ops } = await lib();
    const res = await load(args); const b = box(args.bbox);
    const clipped = ops.clip(res.fc, b); const fc = { type: 'FeatureCollection', features: clipped.features };
    const out = await saveFC(fc, args, 'clip');
    return { output: out.stat, bbox: b, featuresBefore: res.fc.features.length, featuresAfter: fc.features.length, verticesBefore: ops.vertexCount(res.fc), verticesAfter: ops.vertexCount(fc), geometryTypes: ops.typeCounts(fc), ...notesOf(res.notes, out.notes, clipped.droppedCoordinateProperties ? [`per-vertex timestamps were removed from ${clipped.droppedCoordinateProperties} cut track(s): they no longer line up with the vertices`] : []) };
  },
});

register({
  name: 'geo.merge',
  description: 'Concatenate several map files — of any supported formats, mixed — into one FeatureCollection. Each feature gets a "source" property naming the file it came from (turn off with tagSource=false) so the layers can still be told apart, filtered, or coloured with geo.render choropleth=source. Returns the merged file and per-input feature counts.',
  schema: {
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, description: 'VFS paths of the files to merge, in order (formats are sniffed per file)' },
      tagSource: { type: 'boolean', default: true, description: 'Add a "source" property with the input file name to every feature' },
      output: { type: 'string', description: 'VFS path to write (default: merged.geojson). GeoJSON unless the extension says otherwise' },
    },
    required: ['inputs'],
  },
  examples: ['geo.merge inputs=track.gpx,pois.kml,area.geojson output=trip.geojson'],
  async run(args) {
    const { ops } = await lib();
    if (!args.inputs.length) throw new Error('"inputs" must list at least one VFS path');
    const features = [], per = [], notes = [];
    for (const input of args.inputs) {
      const res = await load({ input, format: 'auto' });
      for (const f of res.fc.features) features.push(args.tagSource ? { ...f, properties: { ...f.properties, source: input } } : f);
      per.push({ input, format: res.format, features: res.fc.features.length }); notes.push(...res.notes.map((n) => `${input}: ${n}`));
    }
    const fc = { type: 'FeatureCollection', features };
    const out = await saveFC(fc, { output: args.output || vfs.unique('merged', 'geojson') }, 'merged');
    return { output: out.stat, features: features.length, geometryTypes: ops.typeCounts(fc), inputs: per, ...notesOf(notes, out.notes) };
  },
});

// ──────────────────────────────────────────────────────── reproject ──
async function crsOf(spec, fc, role) {
  const { geo, ops } = await lib();
  const s = String(spec).trim(); const u = s.toUpperCase().replace(/\s+/g, '');
  const id = (c) => c.slice();
  if (['EPSG:4326', 'WGS84', 'CRS84', 'OGC:CRS84', 'LONLAT', 'LNGLAT', '4326'].includes(u)) return { code: 'EPSG:4326', name: 'WGS84 lon/lat degrees', fwd: id, inv: id };
  if (['EPSG:3857', 'EPSG:900913', 'EPSG:102100', 'WEBMERCATOR', 'MERCATOR', '3857'].includes(u)) return { code: 'EPSG:3857', name: 'Web Mercator (metres)', fwd: geo.toMercator, inv: geo.fromMercator };
  let zone, south, m;
  if ((m = /^(?:EPSG:)?32([67])(\d\d)$/.exec(u))) { zone = +m[2]; south = m[1] === '7'; }
  else if ((m = /^UTM:?(\d{1,2})([NS])$/.exec(u))) { zone = +m[1]; south = m[2] === 'S'; }
  else if (u === 'UTM') {
    if (role === 'from') throw new Error('from=utm needs the zone: use EPSG:326xx (north) / EPSG:327xx (south) or "utm:33N"');
    const b = ops.bboxOf(fc).bbox; if (!b) throw new Error('cannot pick a UTM zone: the file has no coordinates');
    const span = ops.bboxSpan(b); const lon = geo.wrapLon(b[0] + span[0] / 2), lat = (b[1] + b[3]) / 2; zone = geo.utmZoneOf(lon, lat); south = lat < 0;
  }
  if (zone !== undefined) {
    if (zone < 1 || zone > 60) throw new Error(`UTM zone must be 1…60 (got ${zone})`);
    return { code: `EPSG:${(south ? 32700 : 32600) + zone}`, name: `WGS84 / UTM zone ${zone}${south ? 'S' : 'N'} (metres)`, zone, south, fwd: (c) => geo.toUTM(c, zone, south), inv: (c) => geo.fromUTM(c, zone, south) };
  }
  throw new Error(`unsupported CRS "${s}". Supported: EPSG:4326 (wgs84), EPSG:3857 (webmercator), EPSG:32601–32660 / EPSG:32701–32760 (UTM north/south; also "utm:33N", or to=utm to pick the zone from the data). Not supported: datum shifts (NAD27, ED50, OSGB36…), national grids, Lambert/Albers conics, PROJ strings`);
}
register({
  name: 'geo.reproject',
  description: 'Transform coordinates between WGS84 lon/lat (EPSG:4326), Web Mercator (EPSG:3857) and UTM on WGS84 (EPSG:32601–32660 north, 32701–32760 south; "utm:33N"; or to=utm to choose the zone from the data). UTM uses the Krüger series (sub-millimetre inside a zone). Use it to bring projected data back to lon/lat before measuring or rendering, or to get metre coordinates. NOT supported: datum shifts and any other projection (national grids, Lambert, Albers, PROJ strings). Output is GeoJSON; non-4326 output carries a "crs" member naming its EPSG code so later tools can recognise it.',
  schema: {
    properties: {
      ...IN,
      from: { type: 'string', default: 'auto', description: 'Source CRS. auto = the file\'s declared crs, else EPSG:4326' },
      to: { type: 'string', description: 'Target CRS: EPSG:4326 | EPSG:3857 | EPSG:326xx | EPSG:327xx | utm | utm:<zone><N|S>' },
      output: { type: 'string', description: 'VFS path to write (default: derived from the input), GeoJSON' },
    },
    required: ['input', 'to'],
  },
  examples: ['geo.reproject input=parcels.geojson from=EPSG:32633 to=EPSG:4326', 'geo.reproject input=city.geojson to=utm'],
  async run(args) {
    const { ops, geo } = await lib();
    const res = await load(args); let fromSpec = args.from;
    const notes = [...res.notes];
    if (fromSpec === 'auto') {
      const decl = (res.crs && (res.crs.suggest || res.crs.declared)) || '';
      const m = /EPSG:{1,2}(\d+)/i.exec(decl);
      fromSpec = m ? `EPSG:${m[1]}` : 'EPSG:4326'; if (/CRS84/i.test(decl)) fromSpec = 'EPSG:4326';
      if (m) notes.push(`source CRS taken from the file: ${fromSpec}`);
    }
    const from = await crsOf(fromSpec, res.fc, 'from');
    if (from.code === 'EPSG:4326') await needLonLat(res.fc, 'geo.reproject (from=EPSG:4326)');
    const mid = from.code === 'EPSG:4326' ? res.fc : { ...res.fc, features: res.fc.features.map((f) => ({ ...f, geometry: ops.mapPos(f.geometry, (c) => [...from.inv(c), ...c.slice(2)]) })) };
    const to = await crsOf(args.to, mid, 'to');
    let clamped = 0, far = 0;
    const tr = (c) => { if (to.code === 'EPSG:3857' && Math.abs(c[1]) > geo.MERC_MAX_LAT) clamped++; if (to.zone && Math.abs(geo.wrapLon(c[0] - (to.zone * 6 - 183))) > 9) far++; const o = to.fwd(c); return [...(to.code === 'EPSG:4326' ? o.map((v) => +v.toFixed(9)) : o.map((v) => +v.toFixed(4))), ...c.slice(2)]; };
    const fc = to.code === 'EPSG:4326' ? { type: 'FeatureCollection', features: mid.features.map((f) => ({ ...f, geometry: ops.mapPos(f.geometry, tr) })) } : { type: 'FeatureCollection', crs: { type: 'name', properties: { name: `urn:ogc:def:crs:EPSG::${to.code.slice(5)}` } }, features: mid.features.map((f) => ({ ...f, geometry: ops.mapPos(f.geometry, tr) })) };
    if (clamped) notes.push(`${clamped} vertices beyond ±85.0511° latitude were clamped (Web Mercator cannot show the poles)`);
    if (far) notes.push(`${far} vertices lie more than 9° from the central meridian of UTM zone ${to.zone}: still computed, but distortion grows quickly out there`);
    const { fmt } = await lib();
    const path = vfs.out(args.output, args.input, to.code.replace(':', '').toLowerCase(), 'geojson');
    const stat = await vfs.write(path, JSON.stringify(fc) + '\n', { mime: fmt.OUT_MIME.geojson, meta: { features: fc.features.length, crs: to.code } });
    const b = ops.bboxOf(fc).bbox;
    return { output: stat, from: { code: from.code, name: from.name }, to: { code: to.code, name: to.name, ...(to.zone ? { zone: to.zone, hemisphere: to.south ? 'S' : 'N' } : {}) }, features: fc.features.length, vertices: ops.vertexCount(fc), bbox: b ? b.map((v) => r(v, to.code === 'EPSG:4326' ? 7 : 3)) : null, units: to.code === 'EPSG:4326' ? 'degrees' : 'metres', ...notesOf(notes) };
  },
});

// ─────────────────────────────────────────────────────────── render ──
const RENDER_ARGS = {
  projection: { type: 'string', enum: ['equirectangular', 'mercator', 'equalearth', 'orthographic', 'laea'], default: 'equirectangular', description: 'equirectangular = plate carrée (x=lon, y=lat; easiest to read coordinates off); mercator = Web Mercator (familiar, cut at ±85°); equalearth = Equal Earth, equal-area world map; orthographic = globe seen from space; laea = Lambert azimuthal equal-area (good for polar or continental data)' },
  width: { type: 'integer', default: 1280, minimum: 320, maximum: 4096, description: 'Image width in pixels (1024–1568 suits vision models)' },
  height: { type: 'integer', minimum: 240, maximum: 4096, description: 'Image height in pixels (default: chosen from the map\'s aspect ratio)' },
  bbox: BBOX('Explicit view extent instead of fitting to the data'),
  center: PT('View centre (with span, or alone for a whole-world/globe view centred there)'),
  span: { type: 'number', minimum: 0.001, maximum: 360, description: 'With center: height of the view in degrees of latitude (≥180 shows the whole world)' },
  theme: { type: 'string', enum: ['dark', 'light'], default: 'dark', description: 'dark = near-black ground with phosphor-green linework and amber data; light = white "print" theme' },
  basemap: { type: 'string', enum: ['countries', 'land', 'none'], default: 'countries', description: 'Vendored Natural Earth 1:110m context under the data: land with country borders, land only, or nothing. It is coarse — fine for world/continent/country views, only a hint below ~200 km' },
  graticule: { type: 'boolean', default: true, description: 'Draw the lat/lon grid with labelled ticks' },
  countryLabels: { type: 'boolean', default: false, description: 'Write country names from the basemap where they fit' },
  label: { type: 'string', description: 'Property whose value is written next to each feature (overlapping labels are skipped)' },
  maxLabels: { type: 'integer', default: 80, minimum: 0, maximum: 1000, description: 'Maximum feature labels drawn' },
  choropleth: { type: 'string', description: 'Property to colour features by. Numeric → sequential classes with a legend; text → up to 8 categories (rest grouped as "other")' },
  classes: { type: 'integer', default: 5, minimum: 2, maximum: 7, description: 'Number of classes for a numeric choropleth' },
  method: { type: 'string', enum: ['quantile', 'equal'], default: 'quantile', description: 'Class breaks: quantile (equal counts) or equal (equal value ranges)' },
  color: { type: 'string', description: 'Data colour as #rrggbb when no choropleth is used (default: amber on dark, burnt orange on light)' },
  lineWidth: { type: 'number', minimum: 0.25, maximum: 20, description: 'Line width in pixels (default 2)' },
  pointRadius: { type: 'number', minimum: 0.5, maximum: 40, description: 'Point radius in pixels (default: 4.5, smaller when there are thousands)' },
  fillOpacity: { type: 'number', minimum: 0, maximum: 1, description: 'Polygon fill opacity (default 0.22, or 0.85 for a choropleth)' },
  title: { type: 'string', description: 'Title written above the map (default: the input file name)' },
  scaleBar: { type: 'boolean', default: true, description: 'Draw a scale bar (true at the centre of the view)' },
};
const renderOpts = (a) => { if (a.color && !/^#[0-9a-fA-F]{6}$/.test(a.color)) throw new Error('color must be #rrggbb, e.g. #ffb000'); return { ...a, bbox: a.bbox ? box(a.bbox) : undefined, center: a.center ? point(a.center, 'center') : undefined }; };

register({
  name: 'geo.render',
  description: 'Draw a map file as a picture a vision model (or a human) can read: PNG by default, SVG on request. The view fits the data automatically (or takes bbox / center+span), handles data crossing the antimeridian and the poles, and sits on a vendored low-resolution world basemap (no tiles, no network). Includes a labelled lat/lon graticule, scale bar, optional feature labels from a property, optional country names, and an optional choropleth with legend. Without input it draws just the basemap. Returns the image file plus what was drawn: projection, centre, visible lat/lon range, graticule step, metres per pixel, legend classes, counts.',
  schema: { properties: { input: { ...IN.input, description: `${IN.input.description}. Omit to draw only the basemap` }, format: IN.format, layer: IN.layer, ...RENDER_ARGS, as: { type: 'string', enum: ['png', 'svg'], default: 'png', description: 'Image type to write' }, output: { type: 'string', description: 'VFS path to write (default: <input stem>.map.png)' } } },
  examples: ['geo.render input=countries.geojson projection=equalearth choropleth=pop_est', 'geo.render input=track.gpx projection=mercator label=name', 'geo.render projection=orthographic center=139.7,35.7 countryLabels=true output=globe.png'],
  async run(args) {
    const { rnd } = await lib();
    let fc = null, notes = [];
    if (args.input) { const res = await load(args); fc = res.fc; notes = res.notes; await needLonLat(fc, 'geo.render'); }
    const as = args.as === 'svg' || /\.svg$/i.test(args.output || '') ? 'svg' : 'png';
    const o = renderOpts(args);
    const out = await rnd.renderMap(fc, { ...o, format: as, title: args.title ?? (args.input ? args.input.replace(/^.*\//, '') : 'world') });
    const path = vfs.out(args.output, args.input || 'world', 'map', as);
    const stat = as === 'svg' ? await vfs.write(path, out.result, { mime: 'image/svg+xml', meta: { width: out.width, height: out.height } }) : await saveCanvas(out.result, path, { format: 'png' });
    return { output: stat, width: out.width, height: out.height, ...out.info, ...notesOf(notes, out.info.drawn.hiddenPoints ? [`${out.info.drawn.hiddenPoints} point(s) fall outside the view or on the far side of the globe`] : []) };
  },
});

// ────────────────────────────────────────────────────────── summary ──
register({
  name: 'geo.summary',
  description: 'Write a compact Markdown description of a map dataset for a language model: what it is (format, feature and vertex counts, geometry types), where it is (bbox, centre, extent in km, countries it falls in according to the coarse basemap), how much (total length, area), elevation/time coverage, a table of properties with types, ranges and top values, and a few sample features. Returns the Markdown inline (it is short) and saves it to the VFS. Use it instead of pasting raw GeoJSON into a prompt.',
  schema: {
    properties: {
      ...IN,
      samples: { type: 'integer', default: 5, minimum: 0, maximum: 20, description: 'Number of sample features to list' },
      places: { type: 'boolean', default: true, description: 'Look up which countries the features fall in (loads the vendored 110m basemap; coarse near borders and coasts)' },
      output: { type: 'string', description: 'VFS path to write (default: <input stem>.summary.md)' },
    },
    required: ['input'],
  },
  examples: ['geo.summary input=hike.gpx'],
  async run(args) {
    const { ops, geo, rnd } = await lib();
    const res = await load(args); const fc = res.fc; const bb = ops.bboxOf(fc); const b = bb.bbox;
    const lonlat = !!b && b[1] >= -90.0001 && b[3] <= 90.0001 && b[0] >= -360.0001 && b[2] <= 360.0001;
    const types = ops.typeCounts(fc); const verts = ops.vertexCount(fc);
    let length = 0, area = 0, z = 0, zmin = Infinity, zmax = -Infinity, tmin = null, tmax = null;
    for (const f of fc.features) {
      ops.eachPos(f.geometry, (c) => { if (c.length > 2 && Number.isFinite(c[2])) { z++; if (c[2] < zmin) zmin = c[2]; if (c[2] > zmax) zmax = c[2]; } });
      if (lonlat && f.geometry) { const m = ops.measureGeom(f.geometry, verts > 300000 ? 'haversine' : 'vincenty'); length += m.length; area += m.area; }
      const ts = f.properties && f.properties.coordinateProperties && f.properties.coordinateProperties.times; const flat = ts ? ts.flat().filter(Boolean) : f.properties && typeof f.properties.time === 'string' ? [f.properties.time] : [];
      for (const t of flat) { if (!tmin || t < tmin) tmin = t; if (!tmax || t > tmax) tmax = t; }
    }
    const L = []; const n = (v) => Number(v).toLocaleString('en-US');
    L.push(`# ${args.input.replace(/^.*\//, '')} — map data summary`, '');
    L.push(`- **What**: ${res.format} file, ${M.human(res.bytes)}; ${n(fc.features.length)} feature${fc.features.length === 1 ? '' : 's'}, ${n(verts)} vertices`);
    L.push(`- **Geometry**: ${Object.entries(types).map(([k, v]) => `${n(v)} ${k}`).join(', ') || 'none'}`);
    let places = null;
    if (b && lonlat) {
      const span = ops.bboxSpan(b); const cl = geo.wrapLon(b[0] + span[0] / 2), cy = (b[1] + b[3]) / 2;
      L.push(`- **Where**: bbox [${b.map((v) => r(v, 5)).join(', ')}] (west, south, east, north)${bb.crossesAntimeridian ? ' — crosses the antimeridian' : ''}; centre ${rnd.fmtLat(cy, 0.001)} ${rnd.fmtLon(cl, 0.001)}; about ${n(Math.round(geo.haversine([b[0], cy], [b[0] + span[0] / 2, cy]) * 2 / 100) / 10)} km east–west × ${n(Math.round(geo.dist([cl, b[1]], [cl, b[3]]) / 100) / 10)} km north–south`);
      if (args.places) {
        try {
          const base = await rnd.loadBasemap(); const tally = new Map(); const step = Math.max(1, Math.ceil(fc.features.length / 300)); let tested = 0, sea = 0;
          for (let i = 0; i < fc.features.length; i += step) { const g = fc.features[i].geometry; const c = g && ops.centroidOf(g); if (!c) continue; tested++; const hit = base.countries.features.find((cf) => ops.geomContains(cf.geometry, c)); if (hit) tally.set(hit.properties.name, (tally.get(hit.properties.name) || 0) + 1); else sea++; }
          places = [...tally.entries()].sort((a, b2) => b2[1] - a[1]);
          if (tested) L.push(`- **Countries** (feature centroids against the 110m basemap${step > 1 ? `, every ${step}th feature` : ''}): ${places.slice(0, 8).map(([k, v]) => `${k} ${Math.round(v / tested * 100)}%`).join(', ') || 'none'}${sea ? `${places.length ? ', ' : ''}at sea / off the coarse coastline ${Math.round(sea / tested * 100)}%` : ''}${places.length > 8 ? `, +${places.length - 8} more` : ''}`);
        } catch (e) { L.push(`- **Countries**: lookup unavailable (${e.message})`); }
      }
    } else if (b) L.push(`- **Where**: coordinates are not lon/lat degrees (x ${r(b[0], 1)}…${r(b[2], 1)}, y ${r(b[1], 1)}…${r(b[3], 1)}) — projected; run geo.reproject to EPSG:4326 for sizes and maps`);
    if (lonlat && (length || area)) L.push(`- **How much**: ${[length ? `${n(km(length))} km of lines` : '', area ? `${n(km2(area))} km² of polygons` : ''].filter(Boolean).join('; ')} (geodesic, WGS84)`);
    if (z) L.push(`- **Elevation**: ${n(z)} of ${n(verts)} vertices carry elevation, ${r(zmin, 1)} … ${r(zmax, 1)} m`);
    if (tmin) L.push(`- **Time**: ${tmin} → ${tmax}`);
    if (res.layers && res.layers.length > 1) L.push(`- **Layers**: ${res.layers.join(', ')}`);
    for (const note of res.notes.slice(0, 4)) L.push(`- _Note_: ${note}`);
    const ps = ops.propertyStats(fc, { maxKeys: 25, samples: 4 });
    const keys = ps.keys.filter((k) => k.key !== 'coordinateProperties');
    if (keys.length) {
      L.push('', `## Properties (${ps.total})`, '', '| key | type | filled | values |', '|---|---|---|---|');
      const cellv = (v) => String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
      for (const k of keys) L.push(`| ${cellv(k.key)} | ${k.type} | ${k.filled}/${fc.features.length} | ${k.min !== undefined ? `${rnd.fmtNum(k.min)} … ${rnd.fmtNum(k.max)}, mean ${rnd.fmtNum(k.mean)}` : `${k.distinct ?? 0} distinct`}${k.samples && (k.min === undefined || k.distinct <= 6) ? `: ${k.samples.map((s) => cellv(typeof s === 'string' && s.length > 24 ? s.slice(0, 23) + '…' : s)).join(', ')}` : ''} |`);
      if (ps.truncated) L.push('', `_…${ps.total - 25} more keys not shown._`);
    }
    if (args.samples && fc.features.length) {
      L.push('', '## Sample features', '');
      const stepS = Math.max(1, Math.floor(fc.features.length / args.samples));
      for (let k = 0, i = 0; k < args.samples && i < fc.features.length; k++, i += stepS) {
        const f = fc.features[i]; const g = f.geometry; const c = g && lonlat ? ops.centroidOf(g) : null; const m = g && lonlat ? ops.measureGeom(g, 'haversine') : null;
        const pr = Object.entries(f.properties || {}).filter(([kk, v]) => kk !== 'coordinateProperties' && v !== null && v !== '' && typeof v !== 'object').slice(0, 6).map(([kk, v]) => `${kk}=${JSON.stringify(typeof v === 'string' && v.length > 40 ? v.slice(0, 39) + '…' : v)}`).join(', ');
        L.push(`${k + 1}. #${i} ${g ? g.type : 'no geometry'}${m ? `, ${n(m.vertices)} vertices` : ''}${c ? `, at ${rnd.fmtLat(c[1], 0.001)} ${rnd.fmtLon(c[0], 0.001)}` : ''}${m && m.length ? `, ${n(km(m.length))} km` : ''}${m && m.area ? `, ${n(km2(m.area))} km²` : ''}${pr ? ` — ${pr}` : ''}`);
      }
    }
    let md = L.join('\n') + '\n';
    const stat = await vfs.write(vfs.out(args.output, args.input, 'summary', 'md'), md, { mime: 'text/markdown' });
    const truncated = md.length > 6000; if (truncated) md = md.slice(0, 6000) + '\n…(truncated — read the output file for the rest)\n';
    return { output: stat, markdown: md, truncated, features: fc.features.length, vertices: verts, bbox: b ? b.map((v) => r(v, 6)) : null, countries: places ? places.slice(0, 8).map(([name, count]) => ({ name, features: count })) : undefined };
  },
});

// ─────────────────────────────────────────────────── tiles / geohash ──
register({
  name: 'geo.tile', readOnly: true,
  description: 'Slippy-map tile arithmetic (the XYZ / Web Mercator scheme used by OSM, Google, Bing, Mapbox). Three ways in: lon+lat+zoom → the tile containing the point; x+y+z → that tile; quadkey → that tile. Always returns x, y, z, the Bing quadkey, the tile\'s bounding box and centre, its ground size, the TMS (flipped) row, and for a point its pixel position inside the 256-px tile. With bbox+zoom it returns the range and count of tiles covering the box. No tiles are fetched — this is only the maths.',
  schema: {
    properties: {
      lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude in degrees (with lat and zoom)' },
      lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude in degrees (clamped to ±85.0511, the Web Mercator limit)' },
      zoom: { type: 'integer', minimum: 0, maximum: 30, description: 'Zoom level for lon/lat or bbox input' },
      x: { type: 'integer', minimum: 0, description: 'Tile column (with y and z)' },
      y: { type: 'integer', minimum: 0, description: 'Tile row, XYZ scheme: 0 at the top (with x and z)' },
      z: { type: 'integer', minimum: 0, maximum: 30, description: 'Tile zoom (with x and y)' },
      quadkey: { type: 'string', description: 'Bing quadkey, digits 0–3; its length is the zoom' },
      bbox: BBOX('Box to cover with tiles at "zoom"'),
    },
  },
  examples: ['geo.tile lon=13.405 lat=52.52 zoom=12', 'geo.tile x=2200 y=1343 z=12', 'geo.tile quadkey=120210233222'],
  async run(a) {
    const { geo } = await lib();
    if (a.bbox) {
      const b = box(a.bbox); if (a.zoom === undefined) throw new Error('bbox needs zoom');
      const t0 = geo.lonLatToTile(b[0], b[3], a.zoom), t1 = geo.lonLatToTile(b[2], b[1], a.zoom); const n = 2 ** a.zoom;
      const cols = b[0] <= b[2] ? t1.x - t0.x + 1 : n - t0.x + t1.x + 1, rows = t1.y - t0.y + 1;
      return { zoom: a.zoom, x: [t0.x, t1.x], y: [t0.y, t1.y], columns: cols, rows, tiles: cols * rows, wrapsAntimeridian: b[0] > b[2], topLeft: { x: t0.x, y: t0.y, quadkey: geo.tileToQuadkey(t0.x, t0.y, a.zoom) }, bottomRight: { x: t1.x, y: t1.y, quadkey: geo.tileToQuadkey(t1.x, t1.y, a.zoom) } };
    }
    let t, pixel;
    if (a.quadkey !== undefined) t = geo.quadkeyToTile(String(a.quadkey));
    else if (a.x !== undefined || a.y !== undefined || a.z !== undefined) { if (a.x === undefined || a.y === undefined || a.z === undefined) throw new Error('tile input needs all of x, y and z'); const n = 2 ** a.z; if (a.x >= n || a.y >= n) throw new Error(`at z=${a.z} x and y must be 0…${n - 1}`); t = { x: a.x, y: a.y, z: a.z }; }
    else if (a.lon !== undefined && a.lat !== undefined) { if (a.zoom === undefined) throw new Error('lon/lat input needs zoom'); const f = geo.lonLatToTile(a.lon, a.lat, a.zoom); t = { x: f.x, y: f.y, z: a.zoom }; pixel = [Math.min(255, Math.floor((f.fx - f.x) * 256)), Math.min(255, Math.floor((f.fy - f.y) * 256))]; }
    else throw new Error('give one of: lon+lat+zoom, x+y+z, quadkey, or bbox+zoom');
    const b = geo.tileBounds(t.x, t.y, t.z); const cy = (b[1] + b[3]) / 2;
    return { x: t.x, y: t.y, z: t.z, quadkey: geo.tileToQuadkey(t.x, t.y, t.z), path: `${t.z}/${t.x}/${t.y}`, tmsY: 2 ** t.z - 1 - t.y, bbox: b.map((v) => r(v, 8)), center: [r((b[0] + b[2]) / 2, 8), r(Math.atan(Math.sinh((Math.asinh(Math.tan(b[1] * geo.RAD)) + Math.asinh(Math.tan(b[3] * geo.RAD))) / 2)) * geo.DEG, 8)], widthMeters: r(geo.haversine([b[0], cy], [b[2], cy]), 1), heightMeters: r(geo.dist([b[0], b[1]], [b[0], b[3]]), 1), metersPerPixel256: r(geo.haversine([b[0], cy], [b[2], cy]) / 256, 3), pixelInTile: pixel, tilesAtZoom: 4 ** t.z };
  },
});

register({
  name: 'geo.geohash', readOnly: true,
  description: 'Geohash encode and decode (the base-32 cell code used by Redis, Elasticsearch, DynamoDB geo indexes). Give lon+lat (+precision) to get the hash, or hash to get its cell: centre, bounding box, error margins and cell size in metres. Both directions also return the 8 neighbouring cells.',
  schema: {
    properties: {
      lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude in degrees (to encode)' },
      lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude in degrees (to encode)' },
      precision: { type: 'integer', default: 9, minimum: 1, maximum: 12, description: 'Hash length when encoding (5 ≈ 4.9 km cell, 7 ≈ 153 m, 9 ≈ 4.8 m)' },
      hash: { type: 'string', description: 'Geohash to decode' },
    },
  },
  examples: ['geo.geohash lon=-0.1276 lat=51.5072 precision=7', 'geo.geohash hash=gcpvj0d'],
  async run(a) {
    const { geo } = await lib();
    let hash = a.hash;
    if (hash === undefined) { if (a.lon === undefined || a.lat === undefined) throw new Error('give lon+lat to encode, or hash to decode'); hash = geo.geohashEncode(a.lon, a.lat, a.precision); } else { hash = String(hash).trim().toLowerCase(); if (!hash) throw new Error('hash is empty'); }
    const d = geo.geohashDecode(hash); const b = d.bbox;
    return { hash, precision: hash.length, center: [r(d.lon, 9), r(d.lat, 9)], bbox: b.map((v) => r(v, 9)), lonError: +d.lonError.toPrecision(4), latError: +d.latError.toPrecision(4), cellWidthMeters: r(geo.haversine([b[0], d.lat], [b[2], d.lat]), 2), cellHeightMeters: r(geo.dist([b[0], b[1]], [b[0], b[3]]), 2), neighbors: geo.geohashNeighbors(hash) };
  },
});

// ──────────────────────────────────────────────────────────── tracks ──
function tracksOf(fc, ops) {
  const out = [];
  fc.features.forEach((f, index) => {
    const g = f.geometry; if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return;
    const segs = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    const T = f.properties && f.properties.coordinateProperties && f.properties.coordinateProperties.times;
    const times = !T ? segs.map(() => null) : g.type === 'LineString' ? [T] : T;
    out.push({ index, name: nameOf(f), segs, times });
  });
  return out;
}
function statsOf(tr, geo, o) {
  let dist = 0, moving = 0, movingDist = 0, maxSpeed = 0, asc = 0, desc = 0, emin = Infinity, emax = -Infinity, pts = 0, withEle = 0, withTime = 0, t0 = null, t1 = null, ref = null, elapsed = 0;
  for (let s = 0; s < tr.segs.length; s++) {
    const c = tr.segs[s], ts = tr.times[s]; let pt = null;
    for (let i = 0; i < c.length; i++) {
      pts++; const e = c[i].length > 2 && Number.isFinite(c[i][2]) ? c[i][2] : null;
      if (e !== null) { withEle++; if (e < emin) emin = e; if (e > emax) emax = e; if (ref === null) ref = e; else if (e - ref >= o.elevationThreshold) { asc += e - ref; ref = e; } else if (ref - e >= o.elevationThreshold) { desc += ref - e; ref = e; } }
      const t = ts && ts[i] ? Date.parse(ts[i]) : NaN; if (Number.isFinite(t)) { withTime++; if (t0 === null || t < t0) t0 = t; if (t1 === null || t > t1) t1 = t; }
      if (i) { const d = geo.dist(c[i - 1], c[i]); dist += d; if (Number.isFinite(t) && pt !== null && t > pt) { const dt = (t - pt) / 1000, v = d / dt; elapsed += dt; if (v >= o.movingSpeed) { moving += dt; movingDist += d; } if (v > maxSpeed && dt >= 1) maxSpeed = v; } }
      if (Number.isFinite(t)) pt = t;
    }
  }
  const dur = t0 !== null ? (t1 - t0) / 1000 : null;
  return {
    points: pts, segments: tr.segs.length, distanceM: r(dist, 1), distanceKm: km(dist),
    ...(dur !== null ? { start: new Date(t0).toISOString(), end: new Date(t1).toISOString(), durationS: r(dur, 0), movingS: r(moving, 0), avgSpeedKmh: dur ? r(dist / dur * 3.6, 2) : null, movingSpeedKmh: moving ? r(movingDist / moving * 3.6, 2) : null, maxSpeedKmh: r(maxSpeed * 3.6, 2), paceMinPerKm: moving && movingDist ? r(moving / 60 / (movingDist / 1000), 2) : null } : { timed: false }),
    ...(withEle ? { elevation: { minM: r(emin, 1), maxM: r(emax, 1), ascentM: r(asc, 1), descentM: r(desc, 1), startM: r(tr.segs[0][0][2] ?? null, 1), pointsWithElevation: withEle } } : { elevation: null }),
    _raw: { dist, dur, moving, movingDist, asc, desc, emin, emax, t0, t1, maxSpeed, withEle },
  };
}
const TRACK_ARGS = {
  elevationThreshold: { type: 'number', default: 3, minimum: 0, description: 'Metres of climb/drop that must accumulate before it counts toward ascent/descent (hysteresis; suppresses GPS/barometer jitter). 0 = count every change' },
  movingSpeed: { type: 'number', default: 0.5, minimum: 0, description: 'Speed in m/s below which a segment counts as stopped (affects moving time and moving speed)' },
};
register({
  name: 'geo.trackStats', readOnly: true,
  description: 'Statistics of GPS tracks (GPX tracks/routes, or any lines with elevation and timestamps): distance (Vincenty, WGS84, horizontal), duration, moving time, average / moving / maximum speed, pace, elevation min/max and cumulative ascent/descent (with a noise threshold), start and end time. Per track (first 20) and totals. Use geo.elevationProfile for the chart.',
  schema: { properties: { ...IN, ...TRACK_ARGS }, required: ['input'] },
  examples: ['geo.trackStats input=ride.gpx'],
  async run(args) {
    const { ops, geo } = await lib();
    const res = await load(args); await needLonLat(res.fc, 'geo.trackStats');
    const tracks = tracksOf(res.fc, ops); if (!tracks.length) throw new Error(`no line features in "${args.input}" (found: ${Object.entries(ops.typeCounts(res.fc)).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'}) — track statistics need LineStrings`);
    const st = tracks.map((t) => ({ t, s: statsOf(t, geo, args) }));
    const sum = (k) => st.reduce((a, x) => a + (x.s._raw[k] || 0), 0); const anyT = st.some((x) => x.s._raw.dur !== null), anyE = st.some((x) => x.s._raw.withEle);
    const t0 = Math.min(...st.map((x) => x.s._raw.t0 ?? Infinity)), t1 = Math.max(...st.map((x) => x.s._raw.t1 ?? -Infinity));
    const totals = { tracks: tracks.length, points: st.reduce((a, x) => a + x.s.points, 0), distanceKm: km(sum('dist')) };
    if (anyT) Object.assign(totals, { start: new Date(t0).toISOString(), end: new Date(t1).toISOString(), elapsedS: r((t1 - t0) / 1000, 0), movingS: r(sum('moving'), 0), movingSpeedKmh: sum('moving') ? r(sum('movingDist') / sum('moving') * 3.6, 2) : null, maxSpeedKmh: r(Math.max(...st.map((x) => x.s._raw.maxSpeed)) * 3.6, 2) });
    if (anyE) Object.assign(totals, { ascentM: r(sum('asc'), 1), descentM: r(sum('desc'), 1), minElevationM: r(Math.min(...st.map((x) => x.s._raw.emin)), 1), maxElevationM: r(Math.max(...st.map((x) => x.s._raw.emax)), 1) });
    return { totals, tracks: st.slice(0, 20).map(({ t, s }) => { const { _raw, ...pub } = s; return { feature: t.index, name: t.name, ...pub }; }), truncated: st.length > 20, method: `distance: Vincenty on WGS84 (horizontal only); ascent/descent: hysteresis ${args.elevationThreshold} m; moving: segment speed ≥ ${args.movingSpeed} m/s; max speed ignores fixes less than 1 s apart`, ...notesOf(res.notes) };
  },
});

register({
  name: 'geo.elevationProfile',
  description: 'Elevation profile of a track: a PNG chart of elevation against distance, plus the numbers — distance, min/max elevation, ascent/descent, steepest sustained grades, and ~24 evenly spaced [km, m] samples so the shape is readable without the picture. Works on GPX tracks/routes or any line whose coordinates carry elevation. By default all line features are joined in file order; pick one with feature=.',
  schema: {
    properties: {
      ...IN,
      feature: { type: 'integer', minimum: 0, description: 'Index of the feature to profile (default: every line feature, joined)' },
      ...TRACK_ARGS,
      width: { type: 'integer', default: 1280, minimum: 400, maximum: 4096, description: 'Chart width in pixels' },
      height: { type: 'integer', default: 480, minimum: 240, maximum: 2160, description: 'Chart height in pixels' },
      theme: { type: 'string', enum: ['dark', 'light'], default: 'dark', description: 'dark terminal look or light print look' },
      output: { type: 'string', description: 'VFS path of the PNG chart (default: <input stem>.profile.png)' },
    },
    required: ['input'],
  },
  examples: ['geo.elevationProfile input=hike.gpx'],
  async run(args) {
    const { ops, geo, rnd } = await lib();
    const res = await load(args); await needLonLat(res.fc, 'geo.elevationProfile');
    let tracks = tracksOf(res.fc, ops);
    if (args.feature !== undefined) { tracks = tracks.filter((t) => t.index === args.feature); if (!tracks.length) throw new Error(`feature ${args.feature} is not a line — line features are at: ${tracksOf(res.fc, ops).map((t) => t.index).slice(0, 20).join(', ') || '(none)'}`); }
    if (!tracks.length) throw new Error(`no line features in "${args.input}" — an elevation profile needs a track or route`);
    const D = [], E = []; let d = 0, missing = 0, prev = null;
    for (const t of tracks) for (const seg of t.segs) for (let i = 0; i < seg.length; i++) { const c = seg[i]; if (prev && i) d += geo.dist(prev, c); prev = c; if (c.length > 2 && Number.isFinite(c[2])) { D.push(d); E.push(c[2]); } else missing++; }
    if (D.length < 2) throw new Error(`the line has no elevation values (third coordinate / <ele>) — ${missing} points without elevation. This tool does not look elevation up`);
    const joined = { segs: tracks.flatMap((t) => t.segs), times: tracks.flatMap((t) => t.times) };
    const s = statsOf(joined, geo, args);
    // steepest grade over ≥ max(100 m, 2% of the track) windows
    const win = Math.max(100, d * 0.02); let up = 0, down = 0;
    for (let i = 0, j = 0; i < D.length; i++) { while (j < D.length - 1 && D[j] - D[i] < win) j++; const run = D[j] - D[i]; if (run >= win * 0.999) { const gr = (E[j] - E[i]) / run * 100; if (gr > up) up = gr; if (gr < down) down = gr; } }
    const N = Math.min(24, D.length); const samples = [];
    for (let k = 0, i = 0; k < N; k++) { const target = d * k / (N - 1); while (i < D.length - 1 && D[i + 1] <= target) i++; const a = D[i], b = D[Math.min(D.length - 1, i + 1)]; const tt = b > a ? Math.min(1, Math.max(0, (target - a) / (b - a))) : 0; samples.push([r(target / 1000, 3), r(E[i] + (E[Math.min(E.length - 1, i + 1)] - E[i]) * tt, 1)]); }
    const title = args.input.replace(/^.*\//, '') + (tracks.length === 1 && tracks[0].name ? ` — ${tracks[0].name}` : '');
    const chart = rnd.drawProfile({ dist: D, ele: E }, { width: args.width, height: args.height, theme: args.theme, title, stats: `${km(d)} km · +${Math.round(s._raw.asc)} m / −${Math.round(s._raw.desc)} m · ${Math.round(s._raw.emin)}–${Math.round(s._raw.emax)} m` });
    const stat = await saveCanvas(chart.result, vfs.out(args.output, args.input, 'profile', 'png'), { format: 'png' });
    return { output: stat, tracks: tracks.length, points: D.length, pointsWithoutElevation: missing, distanceKm: km(d), minElevationM: r(s._raw.emin, 1), maxElevationM: r(s._raw.emax, 1), ascentM: r(s._raw.asc, 1), descentM: r(s._raw.desc, 1), netM: r(E[E.length - 1] - E[0], 1), steepestClimbPercent: r(up, 1), steepestDescentPercent: r(down, 1), gradeWindowM: Math.round(win), samples, samplesNote: '[distance km, elevation m], evenly spaced along the track', ...notesOf(res.notes) };
  },
});

// ──────────────────────────────────────────────────────────── locate ──
register({
  name: 'geo.locate', readOnly: true,
  description: 'What is at this point? With input: the polygon features that contain [lon, lat] and the nearest features with their distances (first 10). Without input: offline reverse-geocoding to a country using the vendored Natural Earth 1:110m basemap — coarse (small islands and city-states are missing, borders are approximate to tens of km), but needs no network.',
  schema: { properties: { point: PT('Point to look up'), input: { ...IN.input, description: `${IN.input.description}. Omit to look the point up in the built-in country basemap` }, format: IN.format, layer: IN.layer, nameProperty: { type: 'string', description: 'Property used to name features (default: name/title/id)' }, limit: { type: 'integer', default: 10, minimum: 1, maximum: 50, description: 'Maximum nearest features returned' } }, required: ['point'] },
  examples: ['geo.locate point=2.35,48.86', 'geo.locate point=-73.97,40.78 input=boroughs.geojson nameProperty=boro_name'],
  async run(args) {
    const { ops, rnd } = await lib(); const p = point(args.point, 'point');
    let fc, source;
    if (args.input) { fc = (await load(args)).fc; source = args.input; await needLonLat(fc, 'geo.locate'); } else { fc = (await rnd.loadBasemap()).countries; source = 'Natural Earth 1:110m countries (vendored)'; }
    const rows = [];
    fc.features.forEach((f, i) => { if (!f.geometry) return; const d = ops.distanceToGeom(f.geometry, p); if (Number.isFinite(d)) rows.push({ index: i, name: nameOf(f, args.nameProperty), type: f.geometry.type, contains: d === 0 && /Polygon/.test(f.geometry.type), distanceKm: km(d) }); });
    rows.sort((a, b) => a.distanceKm - b.distanceKm);
    const inside = rows.filter((x) => x.contains);
    return { point: p, source, containing: inside.slice(0, 10).map(({ index, name, type }) => ({ index, name, type })), ...(args.input ? {} : { country: inside[0] ? inside[0].name : null }), nearest: rows.slice(0, args.limit).map(({ contains, ...x }) => x), truncated: rows.length > args.limit, note: 'distances are to the nearest vertex or edge (great-circle, edges approximated locally); 0 = inside or on it' };
  },
});

// ───────────────────────────────────────────────────────────── synth ──
// [name, country, continent, lon, lat, rough metro population in millions]
const CAPITALS = [
  ['London', 'United Kingdom', 'Europe', -0.13, 51.51, 9.0], ['Paris', 'France', 'Europe', 2.35, 48.86, 11.0], ['Berlin', 'Germany', 'Europe', 13.40, 52.52, 3.7], ['Madrid', 'Spain', 'Europe', -3.70, 40.42, 6.7], ['Rome', 'Italy', 'Europe', 12.50, 41.90, 4.3],
  ['Lisbon', 'Portugal', 'Europe', -9.14, 38.72, 2.9], ['Athens', 'Greece', 'Europe', 23.73, 37.98, 3.2], ['Vienna', 'Austria', 'Europe', 16.37, 48.21, 2.0], ['Warsaw', 'Poland', 'Europe', 21.01, 52.23, 1.8], ['Stockholm', 'Sweden', 'Europe', 18.07, 59.33, 1.6],
  ['Oslo', 'Norway', 'Europe', 10.75, 59.91, 1.0], ['Helsinki', 'Finland', 'Europe', 24.94, 60.17, 1.3], ['Reykjavik', 'Iceland', 'Europe', -21.94, 64.15, 0.2], ['Dublin', 'Ireland', 'Europe', -6.26, 53.35, 1.3], ['Moscow', 'Russia', 'Europe', 37.62, 55.75, 12.5],
  ['Kyiv', 'Ukraine', 'Europe', 30.52, 50.45, 3.0], ['Ankara', 'Turkey', 'Asia', 32.86, 39.93, 5.7], ['Cairo', 'Egypt', 'Africa', 31.24, 30.04, 21.0], ['Nairobi', 'Kenya', 'Africa', 36.82, -1.29, 5.0], ['Addis Ababa', 'Ethiopia', 'Africa', 38.75, 9.03, 5.0],
  ['Abuja', 'Nigeria', 'Africa', 7.49, 9.06, 3.5], ['Accra', 'Ghana', 'Africa', -0.19, 5.60, 2.5], ['Dakar', 'Senegal', 'Africa', -17.47, 14.69, 3.3], ['Rabat', 'Morocco', 'Africa', -6.84, 34.02, 1.9], ['Algiers', 'Algeria', 'Africa', 3.06, 36.75, 2.8],
  ['Kinshasa', 'DR Congo', 'Africa', 15.31, -4.32, 15.0], ['Pretoria', 'South Africa', 'Africa', 28.19, -25.75, 2.6], ['Riyadh', 'Saudi Arabia', 'Asia', 46.72, 24.69, 7.5], ['Tehran', 'Iran', 'Asia', 51.39, 35.69, 9.3], ['Baghdad', 'Iraq', 'Asia', 44.37, 33.31, 7.5],
  ['Kabul', 'Afghanistan', 'Asia', 69.17, 34.53, 4.4], ['Islamabad', 'Pakistan', 'Asia', 73.05, 33.69, 1.2], ['New Delhi', 'India', 'Asia', 77.21, 28.61, 32.0], ['Dhaka', 'Bangladesh', 'Asia', 90.41, 23.81, 22.0], ['Kathmandu', 'Nepal', 'Asia', 85.32, 27.72, 1.5],
  ['Bangkok', 'Thailand', 'Asia', 100.50, 13.75, 10.7], ['Hanoi', 'Vietnam', 'Asia', 105.85, 21.03, 5.1], ['Jakarta', 'Indonesia', 'Asia', 106.85, -6.21, 11.0], ['Manila', 'Philippines', 'Asia', 120.98, 14.60, 14.0], ['Beijing', 'China', 'Asia', 116.40, 39.90, 21.0],
  ['Seoul', 'South Korea', 'Asia', 126.98, 37.57, 9.9], ['Tokyo', 'Japan', 'Asia', 139.69, 35.69, 37.0], ['Ulaanbaatar', 'Mongolia', 'Asia', 106.92, 47.92, 1.6], ['Canberra', 'Australia', 'Oceania', 149.13, -35.28, 0.45], ['Wellington', 'New Zealand', 'Oceania', 174.78, -41.29, 0.42],
  ['Suva', 'Fiji', 'Oceania', 178.44, -18.14, 0.18], ['Nuku\'alofa', 'Tonga', 'Oceania', -175.20, -21.14, 0.03], ['Washington', 'United States', 'North America', -77.04, 38.91, 6.3], ['Ottawa', 'Canada', 'North America', -75.70, 45.42, 1.4], ['Mexico City', 'Mexico', 'North America', -99.13, 19.43, 22.0],
  ['Havana', 'Cuba', 'North America', -82.37, 23.11, 2.1], ['Bogota', 'Colombia', 'South America', -74.07, 4.71, 11.0], ['Lima', 'Peru', 'South America', -77.04, -12.05, 11.0], ['Santiago', 'Chile', 'South America', -70.67, -33.45, 6.9], ['Buenos Aires', 'Argentina', 'South America', -58.38, -34.60, 15.5],
  ['Brasilia', 'Brazil', 'South America', -47.88, -15.79, 4.8], ['Caracas', 'Venezuela', 'South America', -66.90, 10.48, 2.9], ['Quito', 'Ecuador', 'South America', -78.47, -0.18, 2.0], ['Montevideo', 'Uruguay', 'South America', -56.16, -34.90, 1.8],
];
function rng(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
register({
  name: 'geo.synth',
  description: 'Generate sample map data so the geo tools can be tried with nothing uploaded. kind=points: random points in a bbox with id/value/category properties. kind=walk: a random-walk GPS track with elevation and 1-per-step timestamps, written as GPX by default. kind=grid: a rows×cols lattice of square polygons with a smooth numeric "value" (good for choropleths). kind=capitals: ~59 world capitals with country, continent and a rough population (illustrative figures, not authoritative; coordinates to ~1 km). Deterministic for a given seed.',
  schema: {
    properties: {
      kind: { type: 'string', enum: ['points', 'walk', 'grid', 'capitals'], default: 'points', description: 'What to generate' },
      bbox: BBOX('Area for points/grid, and the start area of a walk (default: [-10, 35, 30, 60], Europe)'),
      count: { type: 'integer', default: 200, minimum: 1, maximum: 200000, description: 'points: number of points; walk: number of track points; capitals: how many (largest first); grid: ignored' },
      rows: { type: 'integer', default: 8, minimum: 1, maximum: 200, description: 'grid: number of rows' },
      cols: { type: 'integer', default: 12, minimum: 1, maximum: 200, description: 'grid: number of columns' },
      stepMeters: { type: 'number', default: 25, minimum: 0.1, maximum: 100000, description: 'walk: average distance between consecutive track points' },
      seed: { type: 'integer', default: 1, description: 'Random seed (same seed → same data)' },
      to: { type: 'string', enum: OUT_FORMATS, description: 'Output format (default: gpx for walk, geojson otherwise, or from the output extension)' },
      output: { type: 'string', description: 'VFS path to write (default: synth-<kind>.<ext>)' },
    },
  },
  examples: ['geo.synth kind=capitals', 'geo.synth kind=walk count=600 bbox=7.9,46.5,8.1,46.6 output=hike.gpx', 'geo.synth kind=grid rows=10 cols=16 bbox=-125,25,-66,49'],
  async run(args) {
    const { geo, ops } = await lib();
    const b = args.bbox ? box(args.bbox) : [-10, 35, 30, 60]; const w = b[0], s = b[1], e = b[2] >= b[0] ? b[2] : b[2] + 360, n = b[3];
    const rand = rng(args.seed); const features = []; const extra = {};
    if (args.kind === 'points') {
      const cats = ['alpha', 'beta', 'gamma', 'delta'];
      const s1 = Math.sin(s * geo.RAD), s2 = Math.sin(n * geo.RAD);
      for (let i = 0; i < args.count; i++) { const lon = geo.wrapLon(w + rand() * (e - w)), lat = Math.asin(s1 + rand() * (s2 - s1)) * geo.DEG; features.push({ type: 'Feature', properties: { id: i + 1, value: Math.round(rand() * rand() * 1000) / 10, category: cats[Math.floor(rand() * rand() * 4)] }, geometry: { type: 'Point', coordinates: [+lon.toFixed(6), +lat.toFixed(6)] } }); }
      extra.note = 'points are uniform by area on the sphere (not by degrees)';
    } else if (args.kind === 'walk') {
      let p = [geo.wrapLon(w + (0.3 + rand() * 0.4) * (e - w)), s + (0.3 + rand() * 0.4) * (n - s)], heading = rand() * 360, ele = 400 + rand() * 800, slope = 0, t = Date.UTC(2024, 5, 1, 7, 0, 0);
      const coords = [], times = [];
      for (let i = 0; i < args.count; i++) {
        coords.push([+p[0].toFixed(6), +p[1].toFixed(6), +ele.toFixed(1)]); times.push(new Date(t).toISOString().replace('.000Z', 'Z'));
        heading += (rand() - 0.5) * 50; const step = args.stepMeters * (0.6 + rand() * 0.8);
        p = geo.vincentyDirect(p, heading, step).point; slope = Math.max(-0.25, Math.min(0.25, slope * 0.92 + (rand() - 0.5) * 0.06)); ele = Math.max(0, ele + slope * step);
        t += Math.round(step / (1.1 + rand() * 0.6) * (1 + Math.max(0, slope) * 6)) * 1000;
      }
      features.push({ type: 'Feature', properties: { name: `random walk (seed ${args.seed})`, _gpxType: 'trk', time: times[0], coordinateProperties: { times } }, geometry: { type: 'LineString', coordinates: coords } });
      features.push({ type: 'Feature', properties: { name: 'start', _gpxType: 'wpt', time: times[0] }, geometry: { type: 'Point', coordinates: coords[0] } }, { type: 'Feature', properties: { name: 'finish', _gpxType: 'wpt', time: times[times.length - 1] }, geometry: { type: 'Point', coordinates: coords[coords.length - 1] } });
    } else if (args.kind === 'grid') {
      const dx = (e - w) / args.cols, dy = (n - s) / args.rows; const fx = 1 + rand() * 2, fy = 1 + rand() * 2, ph = rand() * 6.28;
      for (let rr = 0; rr < args.rows; rr++) for (let c = 0; c < args.cols; c++) {
        const x0 = +(w + c * dx).toFixed(6), x1 = +(w + (c + 1) * dx).toFixed(6), y0 = +(s + rr * dy).toFixed(6), y1 = +(s + (rr + 1) * dy).toFixed(6);
        const v = 50 + 35 * Math.sin(ph + fx * c / args.cols * Math.PI) * Math.cos(fy * rr / args.rows * Math.PI) + (rand() - 0.5) * 20;
        features.push({ type: 'Feature', properties: { id: `r${rr}c${c}`, row: rr, col: c, value: Math.round(v * 10) / 10 }, geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] } });
      }
    } else {
      const list = CAPITALS.slice().sort((a, c) => c[5] - a[5]).slice(0, args.count === 200 ? CAPITALS.length : args.count);
      for (const [name, country, continent, lon, lat, pop] of list) features.push({ type: 'Feature', properties: { name, country, continent, pop_millions: pop }, geometry: { type: 'Point', coordinates: [lon, lat] } });
      extra.note = 'pop_millions is a rough metropolitan figure for demos, not a reference value';
    }
    const fc = { type: 'FeatureCollection', features };
    const to = args.to || formatOfPath(args.output) || (args.kind === 'walk' ? 'gpx' : 'geojson');
    const out = await saveFC(fc, { output: args.output || vfs.unique(`synth-${args.kind}`, to) }, 'synth', { format: to });
    const bb = ops.bboxOf(fc);
    return { output: out.stat, kind: args.kind, format: to, features: features.length, vertices: ops.vertexCount(fc), bbox: bb.bbox ? bb.bbox.map((v) => r(v, 5)) : null, seed: args.seed, properties: Object.keys(features[0].properties).filter((k) => k !== 'coordinateProperties' && k !== '_gpxType'), ...extra, ...notesOf(out.notes) };
  },
});

// ──────────────────────────────────────────────────────── previewer ──
M.registerPreviewer(
  (stat) => /\.(geojson|topojson|kml|kmz|gpx|wkt|shp)$/i.test(stat.path),
  async (stat, el) => {
    const { rnd } = await lib();
    el.textContent = '';
    try {
      const res = await load({ input: stat.path, format: 'auto' });
      await needLonLat(res.fc, 'preview');
      const light = typeof getComputedStyle === 'function' && /^(rgb\(2[0-9]{2}|#f)/.test(getComputedStyle(el).backgroundColor || '');
      const width = Math.max(640, Math.min(1600, Math.round((el.clientWidth || 1024) * (globalThis.devicePixelRatio || 1))));
      const out = await rnd.renderMap(res.fc, { projection: 'equirectangular', width, theme: light ? 'light' : 'dark', title: stat.path, basemap: 'countries', label: res.fc.features.length <= 60 && res.fc.features.some((f) => f.properties && f.properties.name !== undefined) ? 'name' : undefined });
      const blob = out.result.convertToBlob ? await out.result.convertToBlob({ type: 'image/png' }) : await new Promise((ok) => out.result.toBlob(ok, 'image/png'));
      const img = document.createElement('img'); img.alt = `map of ${stat.path}`; img.src = URL.createObjectURL(blob); img.onload = () => URL.revokeObjectURL(img.src);
      img.style.cssText = 'max-width:100%;height:auto;display:block'; el.appendChild(img);
      const cap = document.createElement('div'); cap.style.cssText = 'font:12px ui-monospace,monospace;opacity:.75;padding:4px 0';
      cap.textContent = `${res.format} · ${res.fc.features.length} features · ${out.info.drawn.polygons} polygons, ${out.info.drawn.lines} lines, ${out.info.drawn.points} points`; el.appendChild(cap);
    } catch (e) {
      const pre = document.createElement('pre'); pre.textContent = `cannot draw ${stat.path}: ${e.message}`; el.appendChild(pre);
    }
  },
);
