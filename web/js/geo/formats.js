// μεταμόρφωσις :: geo/formats — sniff, read and write map formats. Everything is normalised to a GeoJSON FeatureCollection.
// Read: geojson, geojsonl, topojson, kml, kmz, gpx, wkt, csv, polyline, shapefile (.shp/.dbf/.prj, loose or zipped).
// Write: geojson, topojson, kml, kmz, gpx, wkt, csv, polyline.

export const READ_FORMATS = ['geojson', 'topojson', 'kml', 'kmz', 'gpx', 'wkt', 'csv', 'polyline', 'shapefile'];
export const WRITE_FORMATS = ['geojson', 'topojson', 'kml', 'kmz', 'gpx', 'wkt', 'csv', 'polyline'];
const EXT_FORMAT = { geojson: 'geojson', json: 'json', topojson: 'topojson', kml: 'kml', kmz: 'kmz', gpx: 'gpx', wkt: 'wkt', csv: 'csv', tsv: 'csv', polyline: 'polyline', shp: 'shapefile', zip: 'zip', geojsonl: 'geojsonl', ndjson: 'geojsonl', jsonl: 'geojsonl' };
export const OUT_EXT = { geojson: 'geojson', topojson: 'topojson', kml: 'kml', kmz: 'kmz', gpx: 'gpx', wkt: 'wkt', csv: 'csv', polyline: 'polyline' };
export const OUT_MIME = { geojson: 'application/geo+json', topojson: 'application/json', kml: 'application/vnd.google-earth.kml+xml', kmz: 'application/vnd.google-earth.kmz', gpx: 'application/gpx+xml', wkt: 'text/plain', csv: 'text/csv', polyline: 'text/plain' };

const extOf = (p) => { const m = /\.([A-Za-z0-9]+)$/.exec(p || ''); return m ? m[1].toLowerCase() : ''; };
const td = (bytes) => new TextDecoder().decode(bytes).replace(/^﻿/, '');
const GEOM_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);

// ───────────────────────────────────────────────────────────── sniff ──
export function sniff(bytes, name = '') {
  const ext = EXT_FORMAT[extOf(name)];
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)) return ext === 'kmz' ? 'kmz' : 'zip';
  if (bytes.length >= 100 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0x27 && bytes[3] === 0x0a) return 'shapefile';
  const head = td(bytes.subarray(0, 4096)).trimStart();
  if (head[0] === '{' || head[0] === '[') {
    if (/"type"\s*:\s*"Topology"/.test(head) || ext === 'topojson') return 'topojson';
    if (ext === 'geojsonl') return 'geojsonl';
    // several JSON objects, one per line → GeoJSON text sequence
    const nl = head.indexOf('\n');
    if (head[0] === '{' && nl > 0 && /^\s*\{/.test(head.slice(nl + 1)) && /\}\s*$/.test(head.slice(0, nl))) return 'geojsonl';
    return 'geojson';
  }
  if (head[0] === '<') {
    if (/<kml[\s>]/i.test(head) || /<(Placemark|Document|Folder)[\s>]/.test(head)) return 'kml';
    if (/<gpx[\s>]/i.test(head)) return 'gpx';
    if (ext === 'kml' || ext === 'gpx') return ext;
    throw new Error('XML file is neither KML (<kml>) nor GPX (<gpx>)');
  }
  if (/^(SRID=\d+;\s*)?(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i.test(head)) return 'wkt';
  if (ext === 'csv' || ext === 'wkt' || ext === 'polyline') return ext;
  const first = head.split(/\r?\n/)[0];
  if (/^[?-~]+$/.test(head.trim()) && head.trim().length >= 2 && bytes.length <= 4096) return 'polyline';
  if (/[,;\t|]/.test(first) && /[A-Za-z]/.test(first)) return 'csv';
  if (head.trim().split(/\r?\n/).every((l) => /^[?-~]+$/.test(l.trim()))) return 'polyline';
  throw new Error(`cannot recognise "${name || 'input'}" as a map format — accepted: ${READ_FORMATS.join(', ')} (pass format= to force one)`);
}

// ───────────────────────────────────────────────────────────── entry ──
/**
 * parse(bytes, {name, format, layer, csv:{lon,lat,wkt,delimiter}, polylinePrecision, sibling(ext) → bytes|null})
 * → {fc, format, notes[], crs?, layers?}
 */
export async function parse(bytes, opts = {}) {
  const notes = [];
  let format = opts.format && opts.format !== 'auto' ? opts.format : sniff(bytes, opts.name);
  if (format === 'json') format = 'geojson';
  let fc, crs = null, layers;
  switch (format) {
    case 'geojson': { let j; try { j = JSON.parse(td(bytes)); } catch (e) { throw new Error(`invalid JSON: ${e.message}`); }
      if (j && j.type === 'Topology') { ({ fc, layers } = readTopo(j, opts.layer)); format = 'topojson'; } else { fc = normalise(j); if (j.crs) crs = { declared: crsName(j.crs) }; }
      break; }
    case 'geojsonl': { const feats = []; for (const line of td(bytes).split(/\r?\n/)) { const s = line.replace(/^\x1e/, '').trim(); if (s) feats.push(...normalise(JSON.parse(s)).features); } fc = { type: 'FeatureCollection', features: feats }; break; }
    case 'topojson': { const j = JSON.parse(td(bytes)); ({ fc, layers } = readTopo(j, opts.layer)); break; }
    case 'kml': fc = readKML(td(bytes), notes); break;
    case 'gpx': fc = readGPX(td(bytes), notes); break;
    case 'wkt': fc = readWKTFile(td(bytes), notes); break;
    case 'csv': fc = readCSV(td(bytes), opts.csv || {}, notes); break;
    case 'polyline': fc = readPolylineFile(td(bytes), opts.polylinePrecision || 5); break;
    case 'shapefile': {
      const sib = opts.sibling || (() => null);
      ({ fc, crs } = readShapefile(bytes, sib('dbf'), sib('prj'), sib('cpg'), notes));
      break; }
    case 'kmz': case 'zip': {
      const files = await unzip(bytes);
      const names = [...files.keys()];
      const kml = names.find((n) => /(^|\/)doc\.kml$/i.test(n)) || names.find((n) => /\.kml$/i.test(n));
      const shps = names.filter((n) => /\.shp$/i.test(n));
      if (kml && (format === 'kmz' || !shps.length)) { fc = readKML(td(files.get(kml)), notes); format = 'kmz'; break; }
      if (shps.length) {
        let pick = shps;
        if (opts.layer) { pick = shps.filter((n) => n.replace(/^.*\//, '').replace(/\.shp$/i, '') === opts.layer); if (!pick.length) throw new Error(`no layer "${opts.layer}" in zip — have: ${shps.map((n) => n.replace(/^.*\//, '').replace(/\.shp$/i, '')).join(', ')}`); }
        layers = shps.map((n) => n.replace(/^.*\//, '').replace(/\.shp$/i, ''));
        const feats = [];
        for (const shp of pick) {
          const stem = shp.replace(/\.shp$/i, ''); const get = (e) => files.get(names.find((n) => n.toLowerCase() === `${stem}.${e}`.toLowerCase()));
          const r = readShapefile(files.get(shp), get('dbf'), get('prj'), get('cpg'), notes);
          if (r.crs) crs = r.crs;
          if (pick.length > 1) for (const f of r.fc.features) f.properties.layer = stem.replace(/^.*\//, '');
          feats.push(...r.fc.features);
        }
        fc = { type: 'FeatureCollection', features: feats }; format = 'shapefile'; break;
      }
      const inner = names.find((n) => /\.(geojson|json|topojson|gpx|wkt|csv)$/i.test(n));
      if (!inner) throw new Error(`zip holds no map file (looked for .kml, .shp, .geojson, .json, .topojson, .gpx, .wkt, .csv) — entries: ${names.slice(0, 10).join(', ')}`);
      const r = await parse(files.get(inner), { ...opts, name: inner, format: undefined });
      r.notes.unshift(`read "${inner}" from the zip`); return r;
    }
    default: throw new Error(`unknown input format "${format}" — accepted: ${READ_FORMATS.join(', ')}`);
  }
  return { fc, format, notes, crs, layers };
}
const crsName = (c) => (c && c.properties && (c.properties.name || c.properties.href)) || JSON.stringify(c).slice(0, 120);

/** anything GeoJSON-ish → FeatureCollection with well-formed features */
export function normalise(j) {
  if (!j || typeof j !== 'object') throw new Error('GeoJSON must be an object');
  let feats;
  if (Array.isArray(j)) feats = j.flatMap((x) => normalise(x).features);
  else if (j.type === 'FeatureCollection') feats = (j.features || []).filter(Boolean).map(feat);
  else if (j.type === 'Feature') feats = [feat(j)];
  else if (GEOM_TYPES.has(j.type)) feats = [{ type: 'Feature', properties: {}, geometry: j }];
  else throw new Error(`not GeoJSON: top-level "type" is ${JSON.stringify(j.type)} (want FeatureCollection, Feature or a geometry)`);
  const fc = { type: 'FeatureCollection', features: feats };
  if (j.crs) fc.crs = j.crs;
  return fc;
}
function feat(f) {
  if (GEOM_TYPES.has(f.type)) return { type: 'Feature', properties: {}, geometry: f };
  const o = { type: 'Feature' };
  if (f.id !== undefined) o.id = f.id;
  o.properties = f.properties && typeof f.properties === 'object' ? f.properties : {};
  o.geometry = f.geometry && GEOM_TYPES.has(f.geometry.type) ? f.geometry : null;
  return o;
}

// ────────────────────────────────────────────────────────── topojson ──
export function readTopo(t, layer) {
  if (!t || t.type !== 'Topology' || !t.objects) throw new Error('not TopoJSON: expected {"type":"Topology","objects":{…},"arcs":[…]}');
  const tr = t.transform, sc = tr ? tr.scale : null, tl = tr ? tr.translate : null;
  const arcs = (t.arcs || []).map((arc) => {
    let x = 0, y = 0;
    return arc.map((p) => { if (tr) { x += p[0]; y += p[1]; return [x * sc[0] + tl[0], y * sc[1] + tl[1]]; } return p.slice(); });
  });
  const pt = (p) => (tr ? [p[0] * sc[0] + tl[0], p[1] * sc[1] + tl[1], ...p.slice(2)] : p.slice());
  const line = (idx) => {
    const out = [];
    for (const i of idx) {
      const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
      if (!a) throw new Error(`TopoJSON refers to missing arc ${i}`);
      for (let k = out.length ? 1 : 0; k < a.length; k++) out.push(a[k]);
    }
    return out;
  };
  const geom = (o) => {
    switch (o.type) {
      case 'Point': return { type: 'Point', coordinates: pt(o.coordinates) };
      case 'MultiPoint': return { type: 'MultiPoint', coordinates: o.coordinates.map(pt) };
      case 'LineString': return { type: 'LineString', coordinates: line(o.arcs) };
      case 'MultiLineString': return { type: 'MultiLineString', coordinates: o.arcs.map(line) };
      case 'Polygon': return { type: 'Polygon', coordinates: o.arcs.map(line) };
      case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: o.arcs.map((p) => p.map(line)) };
      case 'GeometryCollection': return { type: 'GeometryCollection', geometries: (o.geometries || []).map(geom).filter(Boolean) };
      default: return null;
    }
  };
  const names = Object.keys(t.objects);
  if (layer && !t.objects[layer]) throw new Error(`no TopoJSON object "${layer}" — have: ${names.join(', ')}`);
  const feats = [];
  for (const n of layer ? [layer] : names) {
    const o = t.objects[n];
    const items = o.type === 'GeometryCollection' ? o.geometries || [] : [o];
    for (const g of items) {
      const f = { type: 'Feature' }; if (g.id !== undefined) f.id = g.id;
      f.properties = { ...(g.properties || {}) };
      if (!layer && names.length > 1) f.properties.layer = n;
      f.geometry = g.type ? geom(g) : null;
      feats.push(f);
    }
  }
  return { fc: { type: 'FeatureCollection', features: feats }, layers: names };
}

/** Quantised TopoJSON. Each ring/line becomes one arc; identical arcs (either direction) are stored once. No junction detection. */
export function writeTopo(fc, { quantization = 1e6, name = 'data' } = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const scan = (c) => { if (typeof c[0] === 'number') { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; } else c.forEach(scan); };
  const scanG = (g) => { if (!g) return; if (g.type === 'GeometryCollection') g.geometries.forEach(scanG); else scan(g.coordinates); };
  fc.features.forEach((f) => scanG(f.geometry));
  if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
  const q = Math.max(2, Math.round(quantization));
  const kx = x1 > x0 ? (x1 - x0) / (q - 1) : 1, ky = y1 > y0 ? (y1 - y0) / (q - 1) : 1;
  const Q = (p) => [Math.round((p[0] - x0) / kx), Math.round((p[1] - y0) / ky)];
  const arcs = [], index = new Map();
  const arc = (coords, ring) => {
    let pts = []; let last;
    for (const c of coords) { const p = Q(c); if (!last || p[0] !== last[0] || p[1] !== last[1]) pts.push(p); last = p; }
    if (ring && pts.length < 4) { while (pts.length < 4) pts.splice(pts.length - 1, 0, pts[0]); }
    if (!ring && pts.length < 2) pts.push(pts[0]);
    const key = pts.join(';');
    if (index.has(key)) return index.get(key);
    const rkey = pts.slice().reverse().join(';');
    if (!ring && index.has(rkey)) return ~index.get(rkey);
    let px = 0, py = 0;
    const delta = pts.map((p) => { const d = [p[0] - px, p[1] - py]; px = p[0]; py = p[1]; return d; });
    arcs.push(delta); index.set(key, arcs.length - 1);
    return arcs.length - 1;
  };
  const geom = (g) => {
    if (!g) return { type: null };
    switch (g.type) {
      case 'Point': return { type: 'Point', coordinates: Q(g.coordinates) };
      case 'MultiPoint': return { type: 'MultiPoint', coordinates: g.coordinates.map(Q) };
      case 'LineString': return { type: 'LineString', arcs: [arc(g.coordinates, false)] };
      case 'MultiLineString': return { type: 'MultiLineString', arcs: g.coordinates.map((l) => [arc(l, false)]) };
      case 'Polygon': return { type: 'Polygon', arcs: g.coordinates.map((r) => [arc(r, true)]) };
      case 'MultiPolygon': return { type: 'MultiPolygon', arcs: g.coordinates.map((p) => p.map((r) => [arc(r, true)])) };
      case 'GeometryCollection': return { type: 'GeometryCollection', geometries: g.geometries.map(geom) };
      default: return { type: null };
    }
  };
  const geometries = fc.features.map((f) => { const o = geom(f.geometry); if (f.id !== undefined) o.id = f.id; if (f.properties && Object.keys(f.properties).length) o.properties = f.properties; return o; });
  return JSON.stringify({ type: 'Topology', bbox: [x0, y0, x1, y1], transform: { scale: [kx, ky], translate: [x0, y0] }, objects: { [name]: { type: 'GeometryCollection', geometries } }, arcs });
}

// ─────────────────────────────────────────────────────────────── xml ──
function xmlDoc(text, what) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`${what} is not well-formed XML: ${err.textContent.replace(/\s+/g, ' ').slice(0, 160)}`);
  return doc;
}
const kids = (el, name) => { const o = []; for (const c of el.children) if (c.localName === name) o.push(c); return o; };
const kid = (el, name) => { for (const c of el.children) if (c.localName === name) return c; return null; };
const txt = (el, name) => { const c = kid(el, name); return c ? c.textContent.trim() : undefined; };
const all = (el, name) => { const o = []; const walk = (n) => { for (const c of n.children) { if (c.localName === name) o.push(c); walk(c); } }; walk(el); return o; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const autoType = (s) => { if (typeof s !== 'string') return s; const t = s.trim(); if (t !== '' && String(Number(t)) === t) return Number(t); return s; };
const num = (n) => { const s = String(+n.toFixed(9)); return s; };

// ─────────────────────────────────────────────────────────────── kml ──
function kmlCoords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).map((t) => t.split(',').map(Number)).filter((c) => c.length >= 2 && c.every(Number.isFinite));
}
function kmlGeom(el) {
  switch (el.localName) {
    case 'Point': { const c = kmlCoords(txt(el, 'coordinates'))[0]; return c ? { type: 'Point', coordinates: c } : null; }
    case 'LineString': case 'LinearRing': { const c = kmlCoords(txt(el, 'coordinates')); return c.length ? { type: 'LineString', coordinates: c } : null; }
    case 'Polygon': {
      const ring = (b) => { const lr = b && all(b, 'LinearRing')[0]; const c = lr ? kmlCoords(txt(lr, 'coordinates')) : []; if (c.length && (c[0][0] !== c[c.length - 1][0] || c[0][1] !== c[c.length - 1][1])) c.push(c[0].slice()); return c; };
      const outer = ring(kid(el, 'outerBoundaryIs')); if (outer.length < 4) return null;
      return { type: 'Polygon', coordinates: [outer, ...kids(el, 'innerBoundaryIs').map(ring).filter((r) => r.length >= 4)] };
    }
    case 'MultiGeometry': {
      const gs = [...el.children].map(kmlGeom).filter(Boolean);
      if (!gs.length) return null;
      if (gs.length === 1) return gs[0];
      const t = gs[0].type;
      if (gs.every((g) => g.type === t) && ['Point', 'LineString', 'Polygon'].includes(t)) return { type: 'Multi' + t, coordinates: gs.map((g) => g.coordinates) };
      return { type: 'GeometryCollection', geometries: gs };
    }
    case 'Track': {
      const coords = kids(el, 'coord').map((c) => c.textContent.trim().split(/\s+/).map(Number));
      return coords.length ? { type: 'LineString', coordinates: coords, _times: kids(el, 'when').map((w) => w.textContent.trim()) } : null;
    }
    case 'MultiTrack': { const ts = kids(el, 'Track').map(kmlGeom).filter(Boolean); return ts.length ? { type: 'MultiLineString', coordinates: ts.map((t) => t.coordinates), _times: ts.map((t) => t._times) } : null; }
    default: return null;
  }
}
export function readKML(text, notes = []) {
  const doc = xmlDoc(text, 'KML');
  const feats = [];
  const skipped = new Set();
  for (const pm of all(doc, 'Placemark')) {
    const props = {};
    for (const k of ['name', 'description', 'styleUrl', 'address']) { const v = txt(pm, k); if (v !== undefined && v !== '') props[k] = v; }
    const folder = pm.parentElement && pm.parentElement.localName === 'Folder' ? txt(pm.parentElement, 'name') : undefined;
    if (folder) props.folder = folder;
    const ext = kid(pm, 'ExtendedData');
    if (ext) {
      for (const d of all(ext, 'Data')) { const n = d.getAttribute('name'); if (n) props[n] = autoType(txt(d, 'value') ?? ''); }
      for (const d of all(ext, 'SimpleData')) { const n = d.getAttribute('name'); if (n) props[n] = autoType(d.textContent.trim()); }
    }
    const ts = kid(pm, 'TimeStamp'); if (ts && txt(ts, 'when')) props.time = txt(ts, 'when');
    const span = kid(pm, 'TimeSpan'); if (span) { if (txt(span, 'begin')) props.begin = txt(span, 'begin'); if (txt(span, 'end')) props.end = txt(span, 'end'); }
    let geometry = null;
    for (const c of pm.children) { const g = kmlGeom(c); if (g) { geometry = g; break; } if (['Model', 'GroundOverlay'].includes(c.localName)) skipped.add(c.localName); }
    if (geometry && geometry._times) { if (geometry._times.length) props.coordinateProperties = { times: geometry._times }; delete geometry._times; }
    const f = { type: 'Feature', properties: props, geometry };
    if (pm.getAttribute('id')) f.id = pm.getAttribute('id');
    feats.push(f);
  }
  if (!feats.length) notes.push('KML holds no Placemark elements');
  if (all(doc, 'NetworkLink').length) notes.push('NetworkLink elements were ignored (no network access)');
  if (all(doc, 'GroundOverlay').length) notes.push('GroundOverlay images were ignored');
  return { type: 'FeatureCollection', features: feats };
}
const kmlC = (c) => c.slice(0, 3).map(num).join(',');
function kmlGeomOut(g) {
  if (!g) return '';
  const ring = (r, tag) => `<${tag}><LinearRing><coordinates>${r.map(kmlC).join(' ')}</coordinates></LinearRing></${tag}>`;
  const poly = (p) => `<Polygon>${ring(p[0], 'outerBoundaryIs')}${p.slice(1).map((r) => ring(r, 'innerBoundaryIs')).join('')}</Polygon>`;
  switch (g.type) {
    case 'Point': return `<Point><coordinates>${kmlC(g.coordinates)}</coordinates></Point>`;
    case 'LineString': return `<LineString><coordinates>${g.coordinates.map(kmlC).join(' ')}</coordinates></LineString>`;
    case 'Polygon': return poly(g.coordinates);
    case 'MultiPoint': return `<MultiGeometry>${g.coordinates.map((c) => kmlGeomOut({ type: 'Point', coordinates: c })).join('')}</MultiGeometry>`;
    case 'MultiLineString': return `<MultiGeometry>${g.coordinates.map((c) => kmlGeomOut({ type: 'LineString', coordinates: c })).join('')}</MultiGeometry>`;
    case 'MultiPolygon': return `<MultiGeometry>${g.coordinates.map(poly).join('')}</MultiGeometry>`;
    case 'GeometryCollection': return `<MultiGeometry>${g.geometries.map(kmlGeomOut).join('')}</MultiGeometry>`;
    default: return '';
  }
}
export function writeKML(fc, { name = 'data' } = {}) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2">', `<Document><name>${esc(name)}</name>`];
  for (const f of fc.features) {
    const p = f.properties || {};
    let s = `<Placemark${f.id !== undefined ? ` id="${esc(f.id)}"` : ''}>`;
    const nm = p.name ?? p.Name ?? p.title;
    if (nm !== undefined && nm !== null) s += `<name>${esc(nm)}</name>`;
    if (p.description !== undefined && p.description !== null) s += `<description>${esc(p.description)}</description>`;
    const rest = Object.entries(p).filter(([k, v]) => !(k === 'name' && nm === p.name) && k !== 'description' && v !== null && v !== undefined);
    if (rest.length) s += `<ExtendedData>${rest.map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</value></Data>`).join('')}</ExtendedData>`;
    s += kmlGeomOut(f.geometry) + '</Placemark>';
    out.push(s);
  }
  out.push('</Document>', '</kml>');
  return out.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────── gpx ──
function gpxPt(el) {
  const c = [Number(el.getAttribute('lon')), Number(el.getAttribute('lat'))];
  const e = txt(el, 'ele'); if (e !== undefined && e !== '' && Number.isFinite(Number(e))) c.push(Number(e));
  return c;
}
const GPX_META = ['name', 'desc', 'cmt', 'src', 'type', 'sym', 'number'];
export function readGPX(text, notes = []) {
  const doc = xmlDoc(text, 'GPX');
  const root = doc.documentElement;
  if (root.localName !== 'gpx') throw new Error(`not GPX: root element is <${root.localName}>`);
  const feats = [];
  const meta = (el, props) => { for (const k of GPX_META) { const v = txt(el, k); if (v !== undefined && v !== '') props[k] = k === 'number' ? autoType(v) : v; } return props; };
  const seg = (pts) => {
    const coords = [], times = []; let any = false;
    for (const p of pts) { const c = gpxPt(p); if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue; coords.push(c); const t = txt(p, 'time'); times.push(t || null); if (t) any = true; }
    return { coords, times: any ? times : null };
  };
  for (const w of kids(root, 'wpt')) {
    const c = gpxPt(w); if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const props = meta(w, { _gpxType: 'wpt' }); const t = txt(w, 'time'); if (t) props.time = t;
    feats.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: c } });
  }
  for (const r of kids(root, 'rte')) {
    const s = seg(kids(r, 'rtept')); if (!s.coords.length) continue;
    const props = meta(r, { _gpxType: 'rte' }); if (s.times) props.coordinateProperties = { times: s.times };
    feats.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: s.coords } });
  }
  for (const t of kids(root, 'trk')) {
    const segs = kids(t, 'trkseg').map((s) => seg(kids(s, 'trkpt'))).filter((s) => s.coords.length);
    if (!segs.length) continue;
    const props = meta(t, { _gpxType: 'trk' });
    if (segs.some((s) => s.times)) { const ts = segs.map((s) => s.times || s.coords.map(() => null)); props.coordinateProperties = { times: segs.length === 1 ? ts[0] : ts }; if (!props.time) props.time = ts.flat().find(Boolean); }
    feats.push({ type: 'Feature', properties: props, geometry: segs.length === 1 ? { type: 'LineString', coordinates: segs[0].coords } : { type: 'MultiLineString', coordinates: segs.map((s) => s.coords) } });
  }
  if (!feats.length) notes.push('GPX holds no waypoints, routes or tracks');
  return { type: 'FeatureCollection', features: feats };
}
export function writeGPX(fc, { name = 'data' } = {}, notes = []) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="metamorphosis geo.convert" xmlns="http://www.topografix.com/GPX/1/1">', `<metadata><name>${esc(name)}</name></metadata>`];
  const wpts = [], rtes = [], trks = [];
  const metaXml = (p) => GPX_META.filter((k) => p[k] !== undefined && p[k] !== null && k !== 'number').map((k) => `<${k}>${esc(p[k])}</${k}>`).join('');
  const pt = (tag, c, time, extra = '') => `<${tag} lat="${num(c[1])}" lon="${num(c[0])}">${c.length > 2 && Number.isFinite(c[2]) ? `<ele>${num(c[2])}</ele>` : ''}${time ? `<time>${esc(time)}</time>` : ''}${extra}</${tag}>`;
  let polys = 0, dropped = 0;
  const emit = (g, p) => {
    if (!g) { dropped++; return; }
    const times = p.coordinateProperties && p.coordinateProperties.times;
    switch (g.type) {
      case 'Point': wpts.push(pt('wpt', g.coordinates, p.time, metaXml(p))); break;
      case 'MultiPoint': g.coordinates.forEach((c) => wpts.push(pt('wpt', c, p.time, metaXml(p)))); break;
      case 'LineString':
        if (p._gpxType === 'rte') rtes.push(`<rte>${metaXml(p)}${g.coordinates.map((c, i) => pt('rtept', c, times && times[i])).join('')}</rte>`);
        else trks.push(`<trk>${metaXml(p)}<trkseg>${g.coordinates.map((c, i) => pt('trkpt', c, times && times[i])).join('')}</trkseg></trk>`);
        break;
      case 'MultiLineString': trks.push(`<trk>${metaXml(p)}${g.coordinates.map((l, k) => `<trkseg>${l.map((c, i) => pt('trkpt', c, times && Array.isArray(times[k]) ? times[k][i] : null)).join('')}</trkseg>`).join('')}</trk>`); break;
      case 'Polygon': polys++; trks.push(`<trk>${metaXml(p)}${g.coordinates.map((l) => `<trkseg>${l.map((c) => pt('trkpt', c)).join('')}</trkseg>`).join('')}</trk>`); break;
      case 'MultiPolygon': polys++; trks.push(`<trk>${metaXml(p)}${g.coordinates.flat().map((l) => `<trkseg>${l.map((c) => pt('trkpt', c)).join('')}</trkseg>`).join('')}</trk>`); break;
      case 'GeometryCollection': g.geometries.forEach((x) => emit(x, p)); break;
      default: dropped++;
    }
  };
  for (const f of fc.features) emit(f.geometry, f.properties || {});
  if (polys) notes.push(`GPX has no polygons: ${polys} polygon feature(s) were written as tracks tracing their rings`);
  if (dropped) notes.push(`${dropped} feature(s) without geometry were dropped`);
  notes.push('GPX keeps only name/desc/cmt/src/type/sym, elevation and time; other properties are not written');
  out.push(...wpts, ...rtes, ...trks, '</gpx>');
  return out.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────── wkt ──
export function parseWKT(input) {
  let s = String(input).trim(), srid;
  const m = /^SRID=(\d+);\s*/i.exec(s); if (m) { srid = Number(m[1]); s = s.slice(m[0].length); }
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = (what) => { throw new Error(`WKT parse error at character ${i}: expected ${what}, found "${s.slice(i, i + 20)}"`); };
  const word = () => { ws(); const m2 = /^[A-Za-z]+/.exec(s.slice(i)); if (!m2) return ''; i += m2[0].length; return m2[0].toUpperCase(); };
  const eat = (c) => { ws(); if (s[i] === c) { i++; return true; } return false; };
  const need = (c) => { if (!eat(c)) fail(`"${c}"`); };
  const number = () => { ws(); const m2 = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(s.slice(i)); if (!m2) fail('a number'); i += m2[0].length; return Number(m2[0]); };
  const empty = () => { const save = i; if (word() === 'EMPTY') return true; i = save; return false; };
  let dims;
  const coord = () => { const c = [number(), number()]; ws(); while (i < s.length && /[-+.\d]/.test(s[i])) { c.push(number()); ws(); } if (dims === 'M') c.length = 2; else if (c.length > 3) c.length = 3; return c; };
  const list = (item) => { need('('); const o = [item()]; while (eat(',')) o.push(item()); need(')'); return o; };
  const ptMaybeParen = () => { ws(); if (s[i] === '(') { i++; const c = coord(); need(')'); return c; } return coord(); };
  const geom = () => {
    let type = word(); if (!type) fail('a geometry keyword');
    const save = i; const d = word(); if (d === 'Z' || d === 'M' || d === 'ZM') dims = d; else { i = save; dims = undefined; }
    const zm = /^(.*?)(ZM|Z|M)$/.exec(type); if (zm && !['POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON', 'GEOMETRYCOLLECTION'].includes(type)) { type = zm[1]; dims = zm[2]; }
    switch (type) {
      case 'POINT': if (empty()) return null; { need('('); const c = coord(); need(')'); return { type: 'Point', coordinates: c }; }
      case 'LINESTRING': case 'LINEARRING': return empty() ? { type: 'LineString', coordinates: [] } : { type: 'LineString', coordinates: list(coord) };
      case 'POLYGON': return empty() ? { type: 'Polygon', coordinates: [] } : { type: 'Polygon', coordinates: list(() => list(coord)) };
      case 'MULTIPOINT': return empty() ? { type: 'MultiPoint', coordinates: [] } : { type: 'MultiPoint', coordinates: list(ptMaybeParen) };
      case 'MULTILINESTRING': return empty() ? { type: 'MultiLineString', coordinates: [] } : { type: 'MultiLineString', coordinates: list(() => list(coord)) };
      case 'MULTIPOLYGON': return empty() ? { type: 'MultiPolygon', coordinates: [] } : { type: 'MultiPolygon', coordinates: list(() => list(() => list(coord))) };
      case 'GEOMETRYCOLLECTION': return empty() ? { type: 'GeometryCollection', geometries: [] } : { type: 'GeometryCollection', geometries: list(geom).filter(Boolean) };
      default: throw new Error(`WKT: unsupported geometry type "${type}" (supported: POINT, LINESTRING, POLYGON, MULTI*, GEOMETRYCOLLECTION, with optional Z/M)`);
    }
  };
  const g = geom(); ws();
  if (i < s.length) fail('end of text');
  return { geometry: g, srid };
}
function readWKTFile(text, notes) {
  // one geometry per line, or a single geometry spread over several lines
  const feats = []; let srid;
  const push = (t) => { const r = parseWKT(t); if (r.srid) srid = r.srid; feats.push({ type: 'Feature', properties: {}, geometry: r.geometry }); };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const starts = lines.filter((l) => /^(SRID=\d+;\s*)?[A-Za-z]/.test(l)).length;
  if (starts === lines.length && lines.length > 1) lines.forEach(push); else push(lines.join(' '));
  if (srid && srid !== 4326) notes.push(`EWKT declares SRID=${srid}; coordinates were kept as they are (use geo.reproject if they are not lon/lat)`);
  return { type: 'FeatureCollection', features: feats };
}
export function toWKT(g) {
  if (!g) return 'GEOMETRYCOLLECTION EMPTY';
  const has3 = (c) => (typeof c[0] === 'number' ? c.length > 2 && Number.isFinite(c[2]) : c.some(has3));
  const z = g.type !== 'GeometryCollection' && g.coordinates.length && has3(g.coordinates);
  const c = (p) => (z ? [p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0] : p.slice(0, 2)).map(num).join(' ');
  const l = (a) => `(${a.map(c).join(', ')})`, ll = (a) => `(${a.map(l).join(', ')})`;
  const tag = (t) => (z ? `${t} Z ` : `${t} `);
  if (g.type !== 'GeometryCollection' && !g.coordinates.length) return `${g.type.toUpperCase()} EMPTY`;
  switch (g.type) {
    case 'Point': return `${tag('POINT')}(${c(g.coordinates)})`;
    case 'MultiPoint': return `${tag('MULTIPOINT')}(${g.coordinates.map((p) => `(${c(p)})`).join(', ')})`;
    case 'LineString': return tag('LINESTRING') + l(g.coordinates);
    case 'MultiLineString': return tag('MULTILINESTRING') + ll(g.coordinates);
    case 'Polygon': return tag('POLYGON') + ll(g.coordinates);
    case 'MultiPolygon': return `${tag('MULTIPOLYGON')}(${g.coordinates.map(ll).join(', ')})`;
    case 'GeometryCollection': return g.geometries.length ? `GEOMETRYCOLLECTION (${g.geometries.map(toWKT).join(', ')})` : 'GEOMETRYCOLLECTION EMPTY';
    default: throw new Error(`cannot write geometry type ${g.type} as WKT`);
  }
}

// ─────────────────────────────────────────────────────────────── csv ──
export function parseCSV(text, delimiter) {
  if (!delimiter) { const first = text.split(/\r?\n/, 1)[0]; delimiter = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0]; }
  const rows = []; let row = [], cell = '', q = false, i = 0; const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; } cell += ch; i++; continue; }
    if (ch === '"' && cell === '') { q = true; i++; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; i++; continue; }
    cell += ch; i++;
  }
  row.push(cell); if (row.length > 1 || row[0] !== '') rows.push(row);
  return { rows, delimiter };
}
const LON_NAMES = ['lon', 'lng', 'long', 'longitude', 'x', 'lon_deg', 'longitude_deg', 'decimallongitude', 'point_x', 'xcoord'];
const LAT_NAMES = ['lat', 'latitude', 'y', 'lat_deg', 'latitude_deg', 'decimallatitude', 'point_y', 'ycoord'];
const WKT_NAMES = ['wkt', 'geometry', 'geom', 'the_geom', 'shape', 'wkt_geom'];
const ELE_NAMES = ['ele', 'elevation', 'alt', 'altitude', 'z'];
function readCSV(text, o, notes) {
  const { rows, delimiter } = parseCSV(text, o.delimiter);
  if (rows.length < 1) throw new Error('CSV is empty');
  const header = rows[0].map((h) => h.trim());
  const find = (explicit, names, what) => {
    if (explicit !== undefined && explicit !== null && explicit !== '') { const i = header.indexOf(explicit); if (i < 0) throw new Error(`CSV has no column "${explicit}" for ${what} — columns: ${header.join(', ')}`); return i; }
    const low = header.map((h) => h.toLowerCase().replace(/[\s-]+/g, '_'));
    for (const nme of names) { const i = low.indexOf(nme); if (i >= 0) return i; }
    return -1;
  };
  let iw = o.wkt ? find(o.wkt, [], 'WKT') : -1;
  let ix = find(o.lon, LON_NAMES, 'longitude'), iy = find(o.lat, LAT_NAMES, 'latitude');
  if (iw < 0 && (ix < 0 || iy < 0)) iw = find(undefined, WKT_NAMES, 'WKT');
  if (iw < 0 && (ix < 0 || iy < 0)) throw new Error(`CSV: could not find coordinate columns. Looked for longitude (${LON_NAMES.slice(0, 5).join('/')}), latitude (${LAT_NAMES.slice(0, 3).join('/')}) or a WKT column (${WKT_NAMES.slice(0, 3).join('/')}). Columns are: ${header.join(', ')} — name them with lonColumn/latColumn/wktColumn`);
  const iz = iw < 0 ? find(undefined, ELE_NAMES.filter((nme) => nme !== 'z' || header.map((h) => h.toLowerCase()).includes('x')), 'elevation') : -1;
  const feats = []; let bad = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; const props = {};
    header.forEach((h, i) => { if (i !== iw && h !== '') { const v = row[i]; props[h] = v === undefined || v === '' ? null : autoType(v); } });
    let geometry = null;
    if (iw >= 0) { try { geometry = row[iw] ? parseWKT(row[iw]).geometry : null; } catch { bad++; } } else {
      const x = Number(row[ix]), y = Number(row[iy]);
      if (row[ix] !== '' && row[iy] !== '' && row[ix] !== undefined && Number.isFinite(x) && Number.isFinite(y)) { geometry = { type: 'Point', coordinates: iz >= 0 && row[iz] !== '' && Number.isFinite(Number(row[iz])) ? [x, y, Number(row[iz])] : [x, y] }; } else bad++;
    }
    feats.push({ type: 'Feature', properties: props, geometry });
  }
  notes.push(iw >= 0 ? `CSV geometry from WKT column "${header[iw]}"` : `CSV points from columns lon="${header[ix]}", lat="${header[iy]}"${iz >= 0 ? `, elevation="${header[iz]}"` : ''} (delimiter ${JSON.stringify(delimiter)})`);
  if (bad) notes.push(`${bad} row(s) had missing or unparsable coordinates and carry null geometry`);
  return { type: 'FeatureCollection', features: feats };
}
export function writeCSV(fc, notes = []) {
  const keys = []; const seen = new Set();
  for (const f of fc.features) for (const k of Object.keys(f.properties || {})) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const allPts = fc.features.every((f) => !f.geometry || f.geometry.type === 'Point');
  const cell = (v) => { if (v === null || v === undefined) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const hasZ = allPts && fc.features.some((f) => f.geometry && f.geometry.coordinates.length > 2);
  const avoid = (n) => (seen.has(n) ? `_${n}` : n);
  const head = allPts ? [avoid('lon'), avoid('lat'), ...(hasZ ? [avoid('ele')] : [])] : [avoid('wkt')];
  const lines = [[...head, ...keys].map(cell).join(',')];
  for (const f of fc.features) {
    const g = f.geometry; let lead;
    if (allPts) lead = g ? [num(g.coordinates[0]), num(g.coordinates[1]), ...(hasZ ? [g.coordinates.length > 2 ? num(g.coordinates[2]) : ''] : [])] : ['', '', ...(hasZ ? [''] : [])];
    else lead = [g ? toWKT(g) : ''];
    lines.push([...lead, ...keys.map((k) => (f.properties || {})[k])].map(cell).join(','));
  }
  notes.push(allPts ? 'CSV written with lon/lat columns' : 'CSV written with a WKT geometry column (not every feature is a point)');
  return lines.join('\n') + '\n';
}

// ────────────────────────────────────────────────── encoded polyline ──
export function decodePolyline(str, precision = 5) {
  const f = 10 ** precision, out = []; let i = 0, lat = 0, lon = 0;
  const next = () => { let r = 0, s = 0, b; do { if (i >= str.length) throw new Error('encoded polyline is truncated'); b = str.charCodeAt(i++) - 63; if (b < 0 || b > 63) throw new Error(`invalid character in encoded polyline at ${i - 1}`); r += (b & 31) * 2 ** s; s += 5; } while (b >= 32); return r % 2 ? -(r + 1) / 2 : r / 2; };
  while (i < str.length) { lat += next(); lon += next(); out.push([lon / f, lat / f]); }
  return out;
}
export function encodePolyline(coords, precision = 5) {
  const f = 10 ** precision; let out = '', plat = 0, plon = 0;
  const enc = (v) => { let n = v < 0 ? -2 * v - 1 : 2 * v; let s = ''; while (n >= 32) { s += String.fromCharCode((32 | (n % 32)) + 63); n = Math.floor(n / 32); } return s + String.fromCharCode(n + 63); };
  for (const c of coords) { const lat = Math.round(c[1] * f), lon = Math.round(c[0] * f); out += enc(lat - plat) + enc(lon - plon); plat = lat; plon = lon; }
  return out;
}
function readPolylineFile(text, precision) {
  const feats = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: decodePolyline(l, precision) } }));
  if (!feats.length) throw new Error('encoded polyline text is empty');
  const bad = feats.find((f) => f.geometry.coordinates.some((c) => Math.abs(c[1]) > 90 || Math.abs(c[0]) > 180));
  if (bad) throw new Error(`decoded polyline leaves the globe at precision ${precision} — try polylinePrecision=${precision === 5 ? 6 : 5}`);
  return { type: 'FeatureCollection', features: feats };
}
function writePolyline(fc, precision, notes) {
  const lines = []; let skipped = 0;
  const add = (g) => { if (!g) return; if (g.type === 'LineString') lines.push(encodePolyline(g.coordinates, precision)); else if (g.type === 'MultiLineString') g.coordinates.forEach((l) => lines.push(encodePolyline(l, precision))); else if (g.type === 'Polygon') g.coordinates.forEach((l) => lines.push(encodePolyline(l, precision))); else if (g.type === 'MultiPolygon') g.coordinates.flat().forEach((l) => lines.push(encodePolyline(l, precision))); else if (g.type === 'GeometryCollection') g.geometries.forEach(add); else skipped++; };
  fc.features.forEach((f) => add(f.geometry));
  if (!lines.length) throw new Error('encoded polyline needs at least one LineString or Polygon; this data has only points — collect them into a line first or choose another format');
  if (skipped) notes.push(`${skipped} point geometr(ies) were skipped (a polyline holds lines only)`);
  notes.push(`encoded polyline: ${lines.length} line(s), one per text line, precision ${precision}; properties and elevation are not kept`);
  return lines.join('\n') + '\n';
}

// ───────────────────────────────────────────────────────── shapefile ──
function ringSigned(r) { let a = 0; for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) a += (r[i][0] - r[j][0]) * (r[i][1] + r[j][1]); return a; } // >0 = clockwise
function pip(pt, ring) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }
export function readShapefile(shp, dbf, prj, cpg, notes = []) {
  const dv = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  if (shp.length < 100 || dv.getInt32(0) !== 9994) throw new Error('not a shapefile: bad .shp header (file code is not 9994). Pass the .shp itself, or a .zip holding .shp + .dbf');
  const geoms = []; let off = 100, unsupported = 0;
  while (off + 8 <= shp.length) {
    const len = dv.getInt32(off + 4) * 2; const p = off + 8; off = p + len;
    if (len < 4 || off > shp.length) break;
    const t = dv.getInt32(p, true);
    const base = t % 10, hasZ = t >= 10 && t < 20;
    const xy = (o) => [dv.getFloat64(o, true), dv.getFloat64(o + 8, true)];
    if (t === 0) { geoms.push(null); continue; }
    if (base === 1) { const c = xy(p + 4); if (hasZ) c.push(dv.getFloat64(p + 20, true)); geoms.push({ type: 'Point', coordinates: c }); continue; }
    if (base === 8) {
      const n = dv.getInt32(p + 36, true); const pts = []; for (let i = 0; i < n; i++) pts.push(xy(p + 40 + i * 16));
      if (hasZ) { const zo = p + 40 + n * 16 + 16; for (let i = 0; i < n; i++) pts[i].push(dv.getFloat64(zo + i * 8, true)); }
      geoms.push({ type: 'MultiPoint', coordinates: pts }); continue;
    }
    if (base === 3 || base === 5) {
      const np = dv.getInt32(p + 36, true), n = dv.getInt32(p + 40, true); const parts = [];
      for (let i = 0; i < np; i++) parts.push(dv.getInt32(p + 44 + i * 4, true)); parts.push(n);
      const po = p + 44 + np * 4, zo = po + n * 16 + 16; const rings = [];
      for (let k = 0; k < np; k++) { const r = []; for (let i = parts[k]; i < parts[k + 1]; i++) { const c = xy(po + i * 16); if (hasZ) c.push(dv.getFloat64(zo + i * 8, true)); r.push(c); } rings.push(r); }
      if (base === 3) { geoms.push(rings.length === 1 ? { type: 'LineString', coordinates: rings[0] } : { type: 'MultiLineString', coordinates: rings }); continue; }
      const polys = [], holes = [];
      for (const r of rings) { if (r.length < 4) continue; if (ringSigned(r) >= 0) polys.push([r]); else holes.push(r); }
      for (const h of holes) { const host = polys.find((pl) => pip(h[0], pl[0])) || polys[polys.length - 1]; if (host) host.push(h); else polys.push([h]); }
      geoms.push(polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys }); continue;
    }
    unsupported++; geoms.push(null);
  }
  if (unsupported) notes.push(`${unsupported} record(s) of an unsupported shape type (MultiPatch) were read as null geometry`);
  let rows = [];
  if (dbf && dbf.length > 32) rows = readDBF(dbf, cpg ? td(cpg).trim() : null, notes);
  else notes.push('no .dbf found next to the .shp — features have no attributes (put <name>.dbf in the VFS or zip both)');
  if (rows.length && rows.length !== geoms.length) notes.push(`.dbf has ${rows.length} rows but .shp has ${geoms.length} shapes; matched by position`);
  const feats = geoms.map((g, i) => ({ type: 'Feature', properties: rows[i] || {}, geometry: g }));
  let crs = null;
  if (prj) {
    const w = td(prj).trim(); crs = { prj: w.slice(0, 240), projected: /^PROJCS|^PROJCRS/i.test(w) };
    const utm = /UTM[_ ]zone[_ ](\d{1,2})([NS])/i.exec(w);
    if (utm) crs.suggest = `EPSG:${(utm[2].toUpperCase() === 'N' ? 32600 : 32700) + Number(utm[1])}`;
    else if (/Web[_ ]Mercator|Pseudo[-_ ]Mercator|Mercator_Auxiliary_Sphere/i.test(w)) crs.suggest = 'EPSG:3857';
    else if (!crs.projected) crs.geographic = true;
    if (crs.projected) notes.push(`.prj says the coordinates are projected${crs.suggest ? ` (${crs.suggest})` : ''}; run geo.reproject${crs.suggest ? ` from=${crs.suggest}` : ''} to=EPSG:4326 before measuring or rendering`);
  }
  return { fc: { type: 'FeatureCollection', features: feats }, crs };
}
function readDBF(dbf, cpg, notes) {
  const dv = new DataView(dbf.buffer, dbf.byteOffset, dbf.byteLength);
  const n = dv.getUint32(4, true), hl = dv.getUint16(8, true), rl = dv.getUint16(10, true);
  const fields = [];
  for (let o = 32; o + 32 <= hl && dbf[o] !== 0x0d; o += 32) {
    let name = ''; for (let i = 0; i < 11 && dbf[o + i]; i++) name += String.fromCharCode(dbf[o + i]);
    fields.push({ name: name.trim(), type: String.fromCharCode(dbf[o + 11]), len: dbf[o + 16] });
  }
  let dec;
  const label = cpg && /^(utf-?8|65001)$/i.test(cpg) ? 'utf-8' : cpg && /^\d+$/.test(cpg) ? `windows-${cpg}` : cpg && /8859-?(\d+)/i.test(cpg) ? `iso-8859-${/8859-?(\d+)/i.exec(cpg)[1]}` : null;
  try { dec = new TextDecoder(label || 'utf-8', { fatal: !label }); } catch { dec = new TextDecoder('utf-8', { fatal: true }); }
  const latin = new TextDecoder('windows-1252');
  const rows = []; let fellBack = false;
  for (let r = 0; r < n; r++) {
    let o = hl + r * rl; if (o + rl > dbf.length) break; o += 1;
    const row = {};
    for (const f of fields) {
      const raw = dbf.subarray(o, o + f.len); o += f.len;
      let s; try { s = dec.decode(raw); } catch { s = latin.decode(raw); fellBack = true; }
      s = s.replace(/\0/g, '').trim();
      if (f.type === 'N' || f.type === 'F' || f.type === 'I' || f.type === 'O') row[f.name] = s === '' || s.startsWith('*') || !Number.isFinite(Number(s)) ? null : Number(s);
      else if (f.type === 'L') row[f.name] = /[YyTt]/.test(s) ? true : /[NnFf]/.test(s) ? false : null;
      else if (f.type === 'D') row[f.name] = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s || null;
      else row[f.name] = s;
    }
    rows.push(row);
  }
  if (fellBack) notes.push('.dbf text is not UTF-8; decoded as windows-1252 (add a .cpg file to name the code page)');
  return rows;
}

// ─────────────────────────────────────────────────────────────── zip ──
async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    try { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); } catch (e) { if (!(e instanceof TypeError)) throw new Error(`zip entry is corrupt: ${e.message}`); }
  }
  const ff = await import(new URL('../../vendor/fflate/fflate.js', import.meta.url).href).catch(() => null);
  if (ff && ff.inflateSync) return ff.inflateSync(bytes);
  throw new Error('this browser cannot inflate zip entries (no DecompressionStream("deflate-raw") and no vendored fflate)');
}
/** unzip(bytes) → Map(name → Uint8Array). Store and deflate entries only. */
export async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = dv.getUint16(e + 10, true); let o = dv.getUint32(e + 16, true);
  const out = new Map(); const dec = new TextDecoder();
  for (let k = 0; k < count && o + 46 <= bytes.length; k++) {
    if (dv.getUint32(o, true) !== 0x02014b50) break;
    const method = dv.getUint16(o + 10, true), csize = dv.getUint32(o + 20, true), nl = dv.getUint16(o + 28, true), xl = dv.getUint16(o + 30, true), cl = dv.getUint16(o + 32, true), lo = dv.getUint32(o + 42, true);
    const name = dec.decode(bytes.subarray(o + 46, o + 46 + nl)); o += 46 + nl + xl + cl;
    if (name.endsWith('/') || /(^|\/)__MACOSX\//.test(name)) continue;
    const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    const raw = bytes.subarray(ds, ds + csize);
    if (method === 0) out.set(name, raw); else if (method === 8) out.set(name, await inflateRaw(raw)); else throw new Error(`zip entry "${name}" uses unsupported compression method ${method} (only store and deflate)`);
  }
  return out;
}
let crcT;
function crc32(b) { if (!crcT) { crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; } } let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
/** zip({name: bytes}) → Uint8Array (deflate when the browser can, else store) */
export async function zip(entries) {
  const parts = [], central = []; let off = 0; const enc = new TextEncoder();
  for (const [name, data] of Object.entries(entries)) {
    const nb = enc.encode(name); let body = data, method = 0;
    if (typeof CompressionStream !== 'undefined') { try { const c = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); if (c.length < data.length) { body = c; method = 8; } } catch { /* store */ } }
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true); lh.setUint32(10, 0x00210000, true); lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true); ch.setUint32(12, 0x00210000, true); ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, off, true);
    parts.push(new Uint8Array(lh.buffer), nb, body); central.push(new Uint8Array(ch.buffer), nb);
    off += 30 + nb.length + body.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, central.length / 2, true); end.setUint16(10, central.length / 2, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
  const allParts = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(allParts.reduce((a, b) => a + b.length, 0)); let p = 0;
  for (const x of allParts) { out.set(x, p); p += x.length; }
  return out;
}

// ───────────────────────────────────────────────────────────── write ──
/** write(fc, format, {name, quantization, polylinePrecision, pretty}) → {data: string|Uint8Array, ext, mime, notes[]} */
export async function write(fc, format, opts = {}) {
  const notes = []; let data;
  switch (format) {
    case 'geojson': data = JSON.stringify(fc, null, opts.pretty ? 1 : undefined) + '\n'; break;
    case 'topojson': data = writeTopo(fc, opts) + '\n'; notes.push(`TopoJSON quantised to ${opts.quantization || 1e6} steps per axis; each ring/line is its own arc (identical arcs are shared, borders between neighbours are not detected); elevation is not kept`); break;
    case 'kml': data = writeKML(fc, opts); break;
    case 'kmz': data = await zip({ 'doc.kml': new TextEncoder().encode(writeKML(fc, opts)) }); break;
    case 'gpx': data = writeGPX(fc, opts, notes); break;
    case 'wkt': { const fs = fc.features.filter((f) => f.geometry); data = fs.map((f) => toWKT(f.geometry)).join('\n') + '\n'; notes.push(`WKT: one geometry per line (${fs.length}); properties are not kept — use csv to keep them next to a WKT column`); break; }
    case 'csv': data = writeCSV(fc, notes); break;
    case 'polyline': data = writePolyline(fc, opts.polylinePrecision || 5, notes); break;
    case 'shapefile': throw new Error('writing Shapefile is not supported (reading is) — write geojson, kml, gpx, topojson, wkt or csv instead');
    default: throw new Error(`unknown output format "${format}" — accepted: ${WRITE_FORMATS.join(', ')}`);
  }
  return { data, ext: OUT_EXT[format], mime: OUT_MIME[format], notes };
}
