// data/schema — JSON Schema inference and validation (a stated subset), JSONPath-style picking, structural diff, flatten/unflatten.
import { parse, compile, objectResolver } from './expr.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);

// ─────────────────────────────────────────────────────── inference ──
const FORMATS = [['date-time', /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/], ['date', /^\d{4}-\d{2}-\d{2}$/], ['email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/], ['uri', /^[a-z][a-z0-9+.-]*:\/\/\S+$/i], ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i]];
function observe(node, v) {
  const t = typeOf(v); node.types.add(t); node.n++;
  if (t === 'object') { node.objs++; node.props ||= new Map(); for (const k of Object.keys(v)) { let p = node.props.get(k); if (!p) node.props.set(k, (p = { node: newNode(), seen: 0 })); p.seen++; observe(p.node, v[k]); } } else if (t === 'array') { node.items ||= newNode(); for (const x of v) observe(node.items, x); } else if (t === 'string') {
    node.strs++; if (node.fmt === undefined) node.fmt = FORMATS.find(([, re]) => re.test(v))?.[0] || null; else if (node.fmt && !FORMATS.find(([f]) => f === node.fmt)[1].test(v)) node.fmt = null;
    if (node.enum && node.enum.size <= 12) node.enum.add(v);
  }
}
const newNode = () => ({ types: new Set(), n: 0, objs: 0, strs: 0, enum: new Set() });
function emitSchema(node, opts) {
  const types = [...node.types]; if (types.includes('number')) { const i = types.indexOf('integer'); if (i >= 0) types.splice(i, 1); }
  const order = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']; types.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const s = {}; if (types.length === 1) s.type = types[0]; else if (types.length) s.type = types;
  if (node.props) {
    s.properties = {}; const req = [];
    for (const [k, p] of node.props) { s.properties[k] = emitSchema(p.node, opts); if (p.seen === node.objs) req.push(k); }
    if (req.length && opts.required) s.required = req;
  }
  if (node.items) s.items = node.items.n ? emitSchema(node.items, opts) : {};
  if (node.strs) { if (node.fmt && opts.formats) s.format = node.fmt; if (opts.enums && node.enum.size <= opts.enumMax && node.strs >= Math.max(opts.enumMin, node.enum.size * 3)) s.enum = [...node.enum].sort(); }
  return s;
}
/** inferSchema(value, {required=true, formats=true, enums=false}) → draft 2020-12 schema describing the value */
export function inferSchema(value, opts = {}) {
  const o = { required: opts.required !== false, formats: opts.formats !== false, enums: !!opts.enums, enumMax: 10, enumMin: 8 };
  const root = newNode(); observe(root, value);
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...emitSchema(root, o) };
}

// ────────────────────────────────────────────────────── validation ──
export const SCHEMA_SUPPORT = {
  supported: ['type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames', 'minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas', 'dependencies', 'items', 'prefixItems', 'additionalItems', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format (date, date-time, time, email, uri, uuid, ipv4, ipv6, hostname)', 'allOf', 'anyOf', 'oneOf', 'not', 'if/then/else', '$ref (local: "#", "#/json/pointer", $defs, definitions)', 'boolean schemas'],
  unsupported: ['remote $ref / $id resolution', '$anchor', '$dynamicRef', 'unevaluatedProperties', 'unevaluatedItems', 'contentEncoding/contentMediaType', 'other formats (ignored)'],
};
const FMT = {
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s,
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s.replace(/t/, 'T').replace(/z/, 'Z'))),
  time: (s) => /^([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/.test(s),
  email: (s) => /^[^\s@]+@[^\s@]+$/.test(s),
  uri: (s) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\S*$/.test(s),
  uuid: (s) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s),
  ipv4: (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((p) => Number(p) <= 255 && (p === '0' || !p.startsWith('0'))),
  ipv6: (s) => /^[0-9a-fA-F:.]+$/.test(s) && s.includes(':') && (() => { try { return new URL(`http://[${s}]/`).hostname.length > 0; } catch { return false; } })(),
  hostname: (s) => s.length <= 253 && /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(s),
};
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a); const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => own(b, k) && deepEqual(a[k], b[k]));
}
const ptr = (path, k) => `${path}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`;
function resolveRef(root, ref) {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) throw new Error(`$ref "${ref}" is not supported (only local references like "#/$defs/name")`);
  let cur = root;
  for (const raw of ref.slice(2).split('/')) { const k = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~'); if (cur === null || typeof cur !== 'object' || !own(cur, k)) throw new Error(`$ref "${ref}" does not resolve`); cur = cur[k]; }
  return cur;
}
const matchesType = (t, v) => { const a = typeOf(v); return t === a || (t === 'number' && a === 'integer') || (t === 'integer' && typeof v === 'number' && Number.isInteger(v)); };

/** validate(value, schema, {max=1000}) → errors [{path (JSON pointer), keyword, message}] */
export function validate(value, schema, { max = 1000 } = {}) {
  const errors = []; const root = schema; const reCache = new Map();
  const re = (p) => { let r = reCache.get(p); if (!r) { try { r = new RegExp(p, 'u'); } catch { try { r = new RegExp(p); } catch (e) { throw new Error(`schema: bad pattern /${p}/ (${e.message})`); } } reCache.set(p, r); } return r; };
  const check = (v, s, path, out, depth) => {
    if (out.length >= max) return;
    if (depth > 200) throw new Error('schema: recursion too deep (circular $ref without progress?)');
    if (s === true || s === undefined) return;
    if (s === false) { out.push({ path, keyword: 'false', message: 'no value is allowed here' }); return; }
    if (!isObj(s)) throw new Error(`schema: expected an object or boolean at a subschema, got ${typeOf(s)}`);
    const err = (keyword, message) => { if (out.length < max) out.push({ path: path || '/', keyword, message }); };
    const ok = (val, sub, p = path) => { const tmp = []; check(val, sub, p, tmp, depth + 1); return tmp; };
    if (s.$ref !== undefined) check(v, resolveRef(root, s.$ref), path, out, depth + 1);
    if (s.type !== undefined) { const ts = Array.isArray(s.type) ? s.type : [s.type]; if (!ts.some((t) => matchesType(t, v))) err('type', `expected ${ts.join(' | ')}, got ${typeOf(v)}`); }
    if (s.enum !== undefined && !s.enum.some((e) => deepEqual(e, v))) err('enum', `value ${JSON.stringify(v)?.slice(0, 60)} is not one of ${JSON.stringify(s.enum).slice(0, 120)}`);
    if (s.const !== undefined && !deepEqual(s.const, v)) err('const', `expected exactly ${JSON.stringify(s.const).slice(0, 80)}`);
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && (s.exclusiveMinimum === true ? v <= s.minimum : v < s.minimum)) err('minimum', `${v} is below the minimum ${s.minimum}`);
      if (typeof s.maximum === 'number' && (s.exclusiveMaximum === true ? v >= s.maximum : v > s.maximum)) err('maximum', `${v} is above the maximum ${s.maximum}`);
      if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) err('exclusiveMinimum', `${v} must be > ${s.exclusiveMinimum}`);
      if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) err('exclusiveMaximum', `${v} must be < ${s.exclusiveMaximum}`);
      if (typeof s.multipleOf === 'number' && s.multipleOf > 0) { const q = v / s.multipleOf; if (Math.abs(q - Math.round(q)) > 1e-9 * Math.max(1, Math.abs(q))) err('multipleOf', `${v} is not a multiple of ${s.multipleOf}`); }
    }
    if (typeof v === 'string') {
      const len = (s.minLength !== undefined || s.maxLength !== undefined) ? [...v].length : 0;
      if (s.minLength !== undefined && len < s.minLength) err('minLength', `string is shorter than ${s.minLength} characters`);
      if (s.maxLength !== undefined && len > s.maxLength) err('maxLength', `string is longer than ${s.maxLength} characters`);
      if (s.pattern !== undefined && !re(s.pattern).test(v)) err('pattern', `string does not match /${s.pattern}/`);
      if (s.format !== undefined && FMT[s.format] && !FMT[s.format](v)) err('format', `string is not a valid ${s.format}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) err('minItems', `array has ${v.length} items, fewer than ${s.minItems}`);
      if (s.maxItems !== undefined && v.length > s.maxItems) err('maxItems', `array has ${v.length} items, more than ${s.maxItems}`);
      if (s.uniqueItems === true) { const seen = new Set(); for (let i = 0; i < v.length; i++) { const k = JSON.stringify(sortDeep(v[i])); if (seen.has(k)) { err('uniqueItems', `item ${i} duplicates an earlier item`); break; } seen.add(k); } }
      const tuple = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : null;
      const rest = Array.isArray(s.items) ? s.additionalItems : s.items;
      for (let i = 0; i < v.length && out.length < max; i++) { if (tuple && i < tuple.length) check(v[i], tuple[i], ptr(path, i), out, depth + 1); else if (rest !== undefined) check(v[i], rest, ptr(path, i), out, depth + 1); }
      if (s.contains !== undefined) { let c = 0; for (const x of v) if (!ok(x, s.contains).length) c++; const mn = s.minContains ?? 1; if (c < mn) err('contains', `needs at least ${mn} item(s) matching "contains", found ${c}`); if (s.maxContains !== undefined && c > s.maxContains) err('maxContains', `more than ${s.maxContains} items match "contains"`); }
    }
    if (isObj(v)) {
      const keys = Object.keys(v);
      if (s.minProperties !== undefined && keys.length < s.minProperties) err('minProperties', `object has fewer than ${s.minProperties} properties`);
      if (s.maxProperties !== undefined && keys.length > s.maxProperties) err('maxProperties', `object has more than ${s.maxProperties} properties`);
      if (Array.isArray(s.required)) for (const k of s.required) if (!own(v, k)) err('required', `missing required property "${k}"`);
      const pats = isObj(s.patternProperties) ? Object.keys(s.patternProperties) : [];
      for (const k of keys) {
        if (out.length >= max) break;
        let matched = false;
        if (isObj(s.properties) && own(s.properties, k)) { matched = true; check(v[k], s.properties[k], ptr(path, k), out, depth + 1); }
        for (const p of pats) if (re(p).test(k)) { matched = true; check(v[k], s.patternProperties[p], ptr(path, k), out, depth + 1); }
        if (!matched && s.additionalProperties !== undefined) { if (s.additionalProperties === false) err('additionalProperties', `unexpected property "${k}"`); else check(v[k], s.additionalProperties, ptr(path, k), out, depth + 1); }
        if (s.propertyNames !== undefined && ok(k, s.propertyNames).length) err('propertyNames', `property name "${k}" is not allowed`);
      }
      const deps = { ...(isObj(s.dependencies) ? s.dependencies : {}), ...(isObj(s.dependentRequired) ? s.dependentRequired : {}) };
      for (const k of Object.keys(deps)) if (own(v, k)) { if (Array.isArray(deps[k])) { for (const need of deps[k]) if (!own(v, need)) err('dependentRequired', `property "${need}" is required when "${k}" is present`); } else check(v, deps[k], path, out, depth + 1); }
      if (isObj(s.dependentSchemas)) for (const k of Object.keys(s.dependentSchemas)) if (own(v, k)) check(v, s.dependentSchemas[k], path, out, depth + 1);
    }
    if (Array.isArray(s.allOf)) for (const sub of s.allOf) check(v, sub, path, out, depth + 1);
    if (Array.isArray(s.anyOf) && !s.anyOf.some((sub) => !ok(v, sub).length)) err('anyOf', `value matches none of the ${s.anyOf.length} anyOf alternatives`);
    if (Array.isArray(s.oneOf)) { const c = s.oneOf.filter((sub) => !ok(v, sub).length).length; if (c !== 1) err('oneOf', `value matches ${c} of the oneOf alternatives (exactly 1 required)`); }
    if (s.not !== undefined && !ok(v, s.not).length) err('not', 'value must not match the "not" schema');
    if (s.if !== undefined) { if (!ok(v, s.if).length) { if (s.then !== undefined) check(v, s.then, path, out, depth + 1); } else if (s.else !== undefined) check(v, s.else, path, out, depth + 1); }
  };
  check(value, schema, '', errors, 0);
  return errors;
}
const sortDeep = (v) => (Array.isArray(v) ? v.map(sortDeep) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v);

// ───────────────────────────────────────────────────────── jsonpath ──
/**
 * pick(value, path) → [{path, value}]. Subset of JSONPath: $ root, .name, ['name'], [0], [-1], [*], .*, ..name (recursive descent),
 * [a:b] slices, [0,2] / ['a','b'] unions, [?(@.price > 10 and @.tag == 'x')] filters (the data.query expression language; @.x or bare x).
 */
export function pick(value, path) {
  let s = String(path).trim(); if (s.startsWith('$')) s = s.slice(1);
  let cur = [{ path: '$', value }]; let i = 0;
  const child = (n, k) => (n.value !== null && typeof n.value === 'object' && own(n.value, k) ? [{ path: `${n.path}${typeof k === 'number' || /^\d+$/.test(k) && Array.isArray(n.value) ? `[${k}]` : /^[A-Za-z_][\w]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`}`, value: n.value[k] }] : []);
  const kids = (n) => (Array.isArray(n.value) ? n.value.map((v, j) => ({ path: `${n.path}[${j}]`, value: v })) : isObj(n.value) ? Object.keys(n.value).flatMap((k) => child(n, k)) : []);
  const desc = (n, acc = []) => { acc.push(n); for (const k of kids(n)) desc(k, acc); return acc; };
  const applyBracket = (nodes, inner) => {
    inner = inner.trim();
    if (inner === '*') return nodes.flatMap(kids);
    if (inner.startsWith('?')) { let e = inner.slice(1).trim(); if (e.startsWith('(') && e.endsWith(')')) e = e.slice(1, -1); const f = compile(parse(e), objectResolver()); return nodes.flatMap(kids).filter((k) => { const r = f(k.value); return !(r === null || r === false || r === 0 || r === ''); }); }
    if (/^-?\d*\s*:\s*-?\d*(\s*:\s*-?\d*)?$/.test(inner)) { const [a, b, st] = inner.split(':').map((x) => (x.trim() === '' ? undefined : Number(x))); const step = st || 1; if (step < 1) throw new Error('jsonpath: slice step must be ≥ 1'); return nodes.flatMap((n) => (Array.isArray(n.value) ? n.value.slice(a, b).map((v, j) => ({ v, j })).filter((_, j) => j % step === 0).map(({ v, j }) => ({ path: `${n.path}[${(a === undefined ? 0 : a < 0 ? Math.max(0, n.value.length + a) : a) + j}]`, value: v })) : [])); }
    const parts = inner.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^,]+/g) || [];
    return nodes.flatMap((n) => parts.flatMap((p) => { p = p.trim(); if (/^-?\d+$/.test(p)) { let k = Number(p); if (Array.isArray(n.value)) { if (k < 0) k += n.value.length; return k >= 0 && k < n.value.length ? [{ path: `${n.path}[${k}]`, value: n.value[k] }] : []; } return child(n, p); } const name = /^['"]/.test(p) ? p.slice(1, -1).replace(/\\(.)/g, '$1') : p; return child(n, name); }));
  };
  const readBracket = () => { let depth = 0; let q = null; const start = i + 1; for (; i < s.length; i++) { const c = s[i]; if (q) { if (c === '\\') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '[' || c === '(') depth++; else if (c === ']' || c === ')') { depth--; if (depth === 0 && c === ']') { const inner = s.slice(start, i); i++; return inner; } } } throw new Error(`jsonpath: unclosed "[" in ${path}`); };
  while (i < s.length) {
    if (s.startsWith('..', i)) {
      i += 2; cur = cur.flatMap((n) => desc(n));
      if (s[i] === '[') { cur = applyBracket(cur, readBracket()); continue; }
      const m = /^(\*|[^.[\]]+)/.exec(s.slice(i)); if (!m) throw new Error(`jsonpath: expected a name after ".." in ${path}`);
      i += m[0].length; cur = m[0] === '*' ? cur.flatMap(kids) : cur.flatMap((n) => child(n, m[0])); continue;
    }
    if (s[i] === '.') { i++; const m = /^(\*|[^.[\]]+)/.exec(s.slice(i)); if (!m) throw new Error(`jsonpath: expected a name after "." in ${path}`); i += m[0].length; cur = m[0] === '*' ? cur.flatMap(kids) : cur.flatMap((n) => (Array.isArray(n.value) && /^-?\d+$/.test(m[0]) ? applyBracket([n], m[0]) : child(n, m[0]))); continue; }
    if (s[i] === '[') { cur = applyBracket(cur, readBracket()); continue; }
    const m = /^[^.[\]]+/.exec(s.slice(i)); if (!m) throw new Error(`jsonpath: cannot parse "${s.slice(i)}"`);
    i += m[0].length; cur = cur.flatMap((n) => (Array.isArray(n.value) && /^-?\d+$/.test(m[0]) ? applyBracket([n], m[0]) : child(n, m[0])));
  }
  return cur;
}

// ───────────────────────────────────────────────── flatten / diff ──
export function flatten(v, { sep = '.', arrays = true, maxDepth = 64 } = {}) {
  const out = {};
  const walk = (x, key, depth) => {
    if (depth < maxDepth && isObj(x) && Object.keys(x).length) { for (const k of Object.keys(x)) walk(x[k], key === null ? k : `${key}${sep}${k}`, depth + 1); return; }
    if (depth < maxDepth && arrays && Array.isArray(x) && x.length) { x.forEach((e, i) => walk(e, key === null ? String(i) : `${key}${sep}${i}`, depth + 1)); return; }
    out[key === null ? 'value' : key] = x;
  };
  walk(v, null, 0);
  return out;
}
export function unflatten(flat, { sep = '.' } = {}) {
  if (!isObj(flat)) throw new Error('unflatten: expected an object with path-like keys');
  const root = {};
  for (const key of Object.keys(flat)) {
    const parts = key.split(sep); let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]; if (p === '__proto__' || p === 'constructor' || p === 'prototype') throw new Error(`unflatten: refusing unsafe key segment "${p}"`);
      if (i === parts.length - 1) { cur[p] = flat[key]; break; }
      if (!own(cur, p) || cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
  }
  const fix = (o) => { if (!isObj(o)) return o; const ks = Object.keys(o); for (const k of ks) o[k] = fix(o[k]); if (ks.length && ks.every((k, i) => k === String(i))) return ks.map((k) => o[k]); return o; };
  return fix(root);
}

/** structural diff of two JSON values → [{path (JSON pointer), op: add|remove|replace, from?, to?}] */
export function diffJson(a, b, { max = 100000 } = {}) {
  const out = [];
  const walk = (x, y, path) => {
    if (out.length >= max) return;
    if (isObj(x) && isObj(y)) { for (const k of Object.keys(x)) { if (!own(y, k)) out.push({ path: ptr(path, k), op: 'remove', from: x[k] }); else walk(x[k], y[k], ptr(path, k)); } for (const k of Object.keys(y)) if (!own(x, k)) out.push({ path: ptr(path, k), op: 'add', to: y[k] }); return; }
    if (Array.isArray(x) && Array.isArray(y)) { const n = Math.min(x.length, y.length); for (let i = 0; i < n; i++) walk(x[i], y[i], ptr(path, i)); for (let i = n; i < x.length; i++) out.push({ path: ptr(path, i), op: 'remove', from: x[i] }); for (let i = n; i < y.length; i++) out.push({ path: ptr(path, i), op: 'add', to: y[i] }); return; }
    if (!deepEqual(x, y)) out.push({ path: path || '/', op: 'replace', from: x, to: y });
  };
  walk(a, b, '');
  return out;
}

/** row-level diff of two tables by key columns */
export function diffTables(A, B, keys, { ignore = [], numericTolerance = 0 } = {}) {
  for (const k of keys) { if (!A.columns.includes(k)) throw new Error(`key column "${k}" is not in the first table — columns: ${A.columns.join(', ')}`); if (!B.columns.includes(k)) throw new Error(`key column "${k}" is not in the second table — columns: ${B.columns.join(', ')}`); }
  const ia = new Map(A.columns.map((c, i) => [c, i])); const ib = new Map(B.columns.map((c, i) => [c, i]));
  const shared = A.columns.filter((c) => ib.has(c) && !keys.includes(c) && !ignore.includes(c));
  const keyOf = (r, idx) => JSON.stringify(keys.map((k) => r[idx.get(k)] ?? null));
  const mb = new Map(); const dupB = []; for (const r of B.rows) { const k = keyOf(r, ib); if (mb.has(k)) dupB.push(k); else mb.set(k, r); }
  const seen = new Set(); const dupA = []; const removed = []; const changed = []; let unchanged = 0;
  const same = (x, y) => { if (typeof x === 'number' && typeof y === 'number' && numericTolerance) return Math.abs(x - y) <= numericTolerance; return deepEqual(x ?? null, y ?? null); };
  const obj = (cols, r, idx) => Object.fromEntries(cols.map((c) => [c, r[idx.get(c)] ?? null]));
  for (const r of A.rows) {
    const k = keyOf(r, ia); if (seen.has(k)) { dupA.push(k); continue; } seen.add(k);
    const o = mb.get(k);
    if (!o) { removed.push(obj(A.columns, r, ia)); continue; }
    const ch = {}; for (const c of shared) { const x = r[ia.get(c)]; const y = o[ib.get(c)]; if (!same(x, y)) ch[c] = { from: x ?? null, to: y ?? null }; }
    if (Object.keys(ch).length) changed.push({ key: obj(keys, r, ia), changes: ch }); else unchanged++;
  }
  const added = []; for (const [k, r] of mb) if (!seen.has(k)) added.push(obj(B.columns, r, ib));
  return { added, removed, changed, unchanged, columnsAdded: B.columns.filter((c) => !ia.has(c)), columnsRemoved: A.columns.filter((c) => !ib.has(c)), duplicateKeysA: dupA.length, duplicateKeysB: dupB.length };
}
