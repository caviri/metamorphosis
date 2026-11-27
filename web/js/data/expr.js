// data/expr — a small, safe expression language (tokeniser → Pratt parser → closures; no eval, no Function) and the query engine on top of it.
//
// Grammar:  or/|| · and/&& · not/! · comparisons (== = != <> < <= > >=, in (…), not in, like, ilike, contains, icontains, startswith,
//           endswith, matches, between a and b, is null, is not null) · + - · * / % · unary - · literals (numbers, 'str', "str", true, false, null)
//           · columns (bare name, dotted path into nested values, or `back ticked name`) · function calls (see FUNCS).

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'like', 'ilike', 'contains', 'icontains', 'startswith', 'endswith', 'matches', 'between', 'is', 'null', 'true', 'false', 'as', 'asc', 'desc']);

function tokenize(src) {
  const out = []; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i)); out.push({ t: 'num', v: Number(m[0]), pos: i }); i += m[0].length; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1; let s = '';
      for (;;) {
        if (j >= n) throw new Error(`expression: unterminated string starting at position ${i}`);
        if (src[j] === '\\' && j + 1 < n) { const e = src[j + 1]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e; j += 2; continue; }
        if (src[j] === c) { if (src[j + 1] === c) { s += c; j += 2; continue; } break; }
        s += src[j++];
      }
      out.push({ t: 'str', v: s, pos: i }); i = j + 1; continue;
    }
    if (c === '`') { const j = src.indexOf('`', i + 1); if (j < 0) throw new Error(`expression: unterminated \`column\` at position ${i}`); out.push({ t: 'id', v: src.slice(i + 1, j), quoted: true, pos: i }); i = j + 1; continue; }
    const idm = /^[\p{L}_@$][\p{L}\p{N}_@$]*(?:\.[\p{L}\p{N}_@$]+|\[\d+\])*/u.exec(src.slice(i));
    if (idm) {
      const word = idm[0]; const low = word.toLowerCase();
      if (KEYWORDS.has(low)) out.push({ t: 'kw', v: low, pos: i }); else out.push({ t: 'id', v: word, pos: i });
      i += word.length; continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<>', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two, pos: i }); i += 2; continue; }
    if ('=<>+-*/%(),![]'.includes(c)) { out.push({ t: 'op', v: c, pos: i }); i++; continue; }
    throw new Error(`expression: unexpected character "${c}" at position ${i} in: ${src}`);
  }
  out.push({ t: 'end', pos: n });
  return out;
}

/** parse(src) → AST. With allowAlias, a trailing "as name" is returned as {ast, alias}. */
export function parse(src, { allowAlias = false } = {}) {
  if (typeof src !== 'string' || !src.trim()) throw new Error('expression: empty expression');
  if (src.length > 4000) throw new Error('expression: too long (max 4000 characters)');
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p]; const next = () => toks[p++];
  const isOp = (v) => peek().t === 'op' && peek().v === v; const isKw = (v) => peek().t === 'kw' && peek().v === v;
  const fail = (msg) => { throw new Error(`expression: ${msg} at position ${peek().pos} in: ${src}`); };
  const expectOp = (v) => { if (!isOp(v)) fail(`expected "${v}"`); next(); };

  const parseOr = () => { let l = parseAnd(); while (isKw('or') || isOp('||')) { next(); l = { k: 'or', a: l, b: parseAnd() }; } return l; };
  const parseAnd = () => { let l = parseNot(); while (isKw('and') || isOp('&&')) { next(); l = { k: 'and', a: l, b: parseNot() }; } return l; };
  const parseNot = () => { if (isKw('not') || isOp('!')) { next(); return { k: 'not', a: parseNot() }; } return parseCmp(); };
  const parseList = () => {
    const close = isOp('[') ? ']' : ')'; if (!isOp('(') && !isOp('[')) fail('expected a list like (1, 2, 3)'); next();
    const items = []; if (!isOp(close)) { do items.push(parseAdd()); while (isOp(',') && next()); }
    expectOp(close); return items;
  };
  const parseCmp = () => {
    const l = parseAdd(); const t = peek();
    if (t.t === 'op' && ['==', '=', '!=', '<>', '<', '<=', '>', '>='].includes(t.v)) { next(); return { k: 'cmp', op: t.v === '=' ? '==' : t.v === '<>' ? '!=' : t.v, a: l, b: parseAdd() }; }
    if (t.t === 'kw') {
      if (t.v === 'is') { next(); let neg = false; if (isKw('not')) { next(); neg = true; } if (!isKw('null')) fail('expected "null" after "is"'); next(); return { k: 'isnull', a: l, neg }; }
      let neg = false;
      if (t.v === 'not' && toks[p + 1].t === 'kw' && ['in', 'like', 'ilike', 'contains', 'icontains', 'between', 'matches', 'startswith', 'endswith'].includes(toks[p + 1].v)) { next(); neg = true; }
      const k = peek();
      const wrap = (node) => (neg ? { k: 'not', a: node } : node);
      if (k.t === 'kw' && k.v === 'in') { next(); return wrap({ k: 'in', a: l, list: parseList() }); }
      if (k.t === 'kw' && k.v === 'between') { next(); const lo = parseAdd(); if (!isKw('and')) fail('expected "and" in between'); next(); return wrap({ k: 'between', a: l, lo, hi: parseAdd() }); }
      if (k.t === 'kw' && ['like', 'ilike', 'contains', 'icontains', 'startswith', 'endswith', 'matches'].includes(k.v)) { next(); return wrap({ k: 'strop', op: k.v, a: l, b: parseAdd() }); }
    }
    return l;
  };
  const parseAdd = () => { let l = parseMul(); while (isOp('+') || isOp('-')) { const op = next().v; l = { k: 'bin', op, a: l, b: parseMul() }; } return l; };
  const parseMul = () => { let l = parseUnary(); while (isOp('*') || isOp('/') || isOp('%')) { const op = next().v; l = { k: 'bin', op, a: l, b: parseUnary() }; } return l; };
  const parseUnary = () => { if (isOp('-')) { next(); return { k: 'neg', a: parseUnary() }; } if (isOp('+')) { next(); return parseUnary(); } return parsePrimary(); };
  const parsePrimary = () => {
    const t = next();
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'kw' && (t.v === 'true' || t.v === 'false')) return { k: 'lit', v: t.v === 'true' };
    if (t.t === 'kw' && t.v === 'null') return { k: 'lit', v: null };
    if (t.t === 'op' && t.v === '(') { const e = parseOr(); expectOp(')'); return e; }
    if (t.t === 'id') {
      if (!t.quoted && isOp('(')) {
        next(); const args = [];
        if (isOp('*')) { next(); args.push({ k: 'star' }); } else if (!isOp(')')) { do args.push(parseOr()); while (isOp(',') && next()); }
        expectOp(')'); return { k: 'call', name: t.v.toLowerCase(), args };
      }
      return { k: 'col', name: t.v };
    }
    p--; return fail(t.t === 'end' ? 'unexpected end' : `unexpected "${t.v}"`);
  };
  const ast = parseOr(); let alias = null;
  if (allowAlias && isKw('as')) { next(); const t = next(); if (t.t !== 'id' && t.t !== 'str' && t.t !== 'kw') fail('expected a name after "as"'); alias = String(t.v); }
  if (peek().t !== 'end') fail(`unexpected "${peek().v}"`);
  return allowAlias ? { ast, alias } : ast;
}

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : typeof v === 'boolean' ? (v ? 1 : 0) : NaN);
const str = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** three-way compare with loose number/numeric-string matching; null when incomparable */
export function compare(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (typeof a === 'number' || typeof b === 'number') { const x = num(a); const y = num(b); if (!Number.isNaN(x) && !Number.isNaN(y)) return x < y ? -1 : x > y ? 1 : 0; }
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  const x = str(a); const y = str(b); return x < y ? -1 : x > y ? 1 : 0;
}
const eq = (a, b) => { if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null); if (typeof a === 'boolean' || typeof b === 'boolean') return a === b || str(a).toLowerCase() === str(b).toLowerCase(); return compare(a, b) === 0; };
const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '' || (typeof v === 'number' && Number.isNaN(v)));
const reCache = new Map();
const regex = (src, flags) => { if (src.length > 500) throw new Error('expression: regex too long (max 500 characters)'); const key = flags + '/' + src; let r = reCache.get(key); if (!r) { try { r = new RegExp(src, flags); } catch (e) { throw new Error(`expression: bad regex /${src}/ — ${e.message}`); } reCache.set(key, r); } return r; };
const likeRe = (pat, ci) => regex('^' + String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]') + '$', ci ? 'i' : '');
const datePart = (v, a, b) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v)); return m ? Number(m[0].slice(a, b)) : null; };

export const FUNCS = {
  lower: (s) => (s === null ? null : str(s).toLowerCase()), upper: (s) => (s === null ? null : str(s).toUpperCase()), trim: (s) => (s === null ? null : str(s).trim()),
  len: (s) => (s === null ? null : Array.isArray(s) ? s.length : str(s).length), length: (s) => FUNCS.len(s),
  abs: (x) => (x === null ? null : Math.abs(num(x))), floor: (x) => (x === null ? null : Math.floor(num(x))), ceil: (x) => (x === null ? null : Math.ceil(num(x))),
  sqrt: (x) => (x === null ? null : Math.sqrt(num(x))), pow: (x, y) => (x === null || y === null ? null : num(x) ** num(y)), log: (x) => (x === null ? null : Math.log(num(x))), exp: (x) => (x === null ? null : Math.exp(num(x))),
  round: (x, d = 0) => { if (x === null) return null; const k = 10 ** num(d); return Math.round(num(x) * k) / k; },
  min: (...a) => { const v = a.filter((x) => x !== null); return v.length ? v.reduce((m, x) => (compare(x, m) < 0 ? x : m)) : null; },
  max: (...a) => { const v = a.filter((x) => x !== null); return v.length ? v.reduce((m, x) => (compare(x, m) > 0 ? x : m)) : null; },
  coalesce: (...a) => { for (const x of a) if (x !== null && x !== undefined) return x; return null; },
  if: (c, a, b = null) => (truthy(c) ? a : b),
  number: (x) => { const v = num(x); return Number.isNaN(v) ? null : v; }, string: (x) => (x === null ? null : str(x)), bool: (x) => truthy(x),
  substr: (s, start = 0, n) => (s === null ? null : n === undefined ? str(s).slice(num(start)) : str(s).slice(num(start), num(start) + num(n))),
  replace: (s, a, b) => (s === null ? null : str(s).split(str(a)).join(str(b))),
  concat: (...a) => a.map(str).join(''),
  year: (v) => datePart(v, 0, 4), month: (v) => datePart(v, 5, 7), day: (v) => datePart(v, 8, 10),
  isnull: (v) => v === null || v === undefined,
};

/** compile(ast, resolve) → (row) => value.  resolve(name) must return an accessor (row) => value or throw for unknown columns. */
export function compile(ast, resolve) {
  switch (ast.k) {
    case 'lit': { const v = ast.v; return () => v; }
    case 'col': return resolve(ast.name);
    case 'or': { const a = compile(ast.a, resolve); const b = compile(ast.b, resolve); return (r) => truthy(a(r)) || truthy(b(r)); }
    case 'and': { const a = compile(ast.a, resolve); const b = compile(ast.b, resolve); return (r) => truthy(a(r)) && truthy(b(r)); }
    case 'not': { const a = compile(ast.a, resolve); return (r) => !truthy(a(r)); }
    case 'neg': { const a = compile(ast.a, resolve); return (r) => { const v = a(r); return v === null || v === undefined ? null : -num(v); }; }
    case 'isnull': { const a = compile(ast.a, resolve); const neg = ast.neg; return (r) => { const v = a(r); return (v === null || v === undefined) !== neg; }; }
    case 'cmp': {
      const a = compile(ast.a, resolve); const b = compile(ast.b, resolve); const op = ast.op;
      if (op === '==') return (r) => eq(a(r), b(r));
      if (op === '!=') return (r) => !eq(a(r), b(r));
      return (r) => { const c = compare(a(r), b(r)); if (c === null) return false; return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0; };
    }
    case 'in': { const a = compile(ast.a, resolve); const list = ast.list.map((x) => compile(x, resolve)); return (r) => { const v = a(r); return list.some((f) => eq(v, f(r))); }; }
    case 'between': { const a = compile(ast.a, resolve); const lo = compile(ast.lo, resolve); const hi = compile(ast.hi, resolve); return (r) => { const v = a(r); const c1 = compare(v, lo(r)); const c2 = compare(v, hi(r)); return c1 !== null && c2 !== null && c1 >= 0 && c2 <= 0; }; }
    case 'strop': {
      const a = compile(ast.a, resolve); const b = compile(ast.b, resolve); const op = ast.op;
      return (r) => {
        const x = a(r); const y = b(r); if (x === null || x === undefined || y === null || y === undefined) return false;
        if (op === 'contains' && Array.isArray(x)) return x.some((e) => eq(e, y));
        const s = str(x); const t = str(y);
        switch (op) {
          case 'contains': return s.includes(t);
          case 'icontains': return s.toLowerCase().includes(t.toLowerCase());
          case 'startswith': return s.startsWith(t);
          case 'endswith': return s.endsWith(t);
          case 'like': return likeRe(t, false).test(s);
          case 'ilike': return likeRe(t, true).test(s);
          default: return regex(t, '').test(s);
        }
      };
    }
    case 'bin': {
      const a = compile(ast.a, resolve); const b = compile(ast.b, resolve); const op = ast.op;
      return (r) => {
        const x = a(r); const y = b(r);
        if (x === null || x === undefined || y === null || y === undefined) return null;
        if (op === '+' && (typeof x === 'string' || typeof y === 'string') && (Number.isNaN(num(x)) || Number.isNaN(num(y)))) return str(x) + str(y);
        const p = num(x); const q = num(y); if (Number.isNaN(p) || Number.isNaN(q)) return null;
        const v = op === '+' ? p + q : op === '-' ? p - q : op === '*' ? p * q : op === '/' ? (q === 0 ? null : p / q) : (q === 0 ? null : p % q);
        return v;
      };
    }
    case 'call': {
      if (!Object.prototype.hasOwnProperty.call(FUNCS, ast.name)) throw new Error(`expression: unknown function "${ast.name}" — available: ${Object.keys(FUNCS).join(', ')}`);
      const fn = FUNCS[ast.name]; const args = ast.args.map((x) => { if (x.k === 'star') throw new Error(`expression: "*" is only valid in aggregates like count(*)`); return compile(x, resolve); });
      return (r) => { const v = fn(...args.map((f) => { const x = f(r); return x === undefined ? null : x; })); return v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? null : v; };
    }
    default: throw new Error(`expression: cannot evaluate node "${ast.k}"`);
  }
}

/** resolver over table columns: exact name, else a dotted/indexed path into a nested cell ("user.address.city", "tags[0]") */
export function columnResolver(columns) {
  const idx = new Map(columns.map((c, i) => [c, i]));
  return (name) => {
    if (idx.has(name)) { const i = idx.get(name); return (r) => r[i]; }
    const clean = name.replace(/^@\.?/, '').replace(/^\$\.?/, '');
    if (idx.has(clean)) { const i = idx.get(clean); return (r) => r[i]; }
    const parts = clean.split(/\.|\[(\d+)\]/).filter((x) => x !== undefined && x !== '');
    for (let k = parts.length - 1; k >= 1; k--) {
      const head = parts.slice(0, k).join('.');
      if (idx.has(head)) {
        const i = idx.get(head); const rest = parts.slice(k);
        return (r) => { let v = r[i]; for (const p of rest) { if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, p)) return null; v = v[p]; } return v === undefined ? null : v; };
      }
    }
    throw new Error(`unknown column "${name}" — columns: ${columns.slice(0, 40).join(', ')}${columns.length > 40 ? ', …' : ''}`);
  };
}
/** resolver over one object (for JSONPath filters): names are own-property paths; missing → null */
export const objectResolver = () => (name) => {
  const parts = name.replace(/^@\.?/, '').split(/\.|\[(\d+)\]/).filter((x) => x !== undefined && x !== '');
  return (o) => { let v = o; for (const p of parts) { if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, p)) return null; v = v[p]; } return v === undefined ? null : v; };
};

// ───────────────────────────────────────────────────────── query ──
export function sortRows(rows, keys) { // keys: [{get, desc}]
  const cmp = (a, b) => {
    for (const k of keys) {
      const x = k.get(a); const y = k.get(b);
      const nx = x === null || x === undefined; const ny = y === null || y === undefined;
      if (nx || ny) { if (nx && ny) continue; return nx ? 1 : -1; } // nulls last
      let c;
      if (typeof x === 'number' && typeof y === 'number') c = x - y;
      else if (typeof x === 'number' || typeof y === 'number') c = typeof x === 'number' ? -1 : 1;
      else { const s = str(x); const t = str(y); c = s < t ? -1 : s > t ? 1 : 0; }
      if (c) return k.desc ? -c : c;
    }
    return 0;
  };
  return rows.map((r, i) => [r, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map((x) => x[0]);
}
function parseSort(spec) {
  let s = String(spec).trim(); let desc = false;
  if (s.startsWith('-') && !/\s/.test(s)) { desc = true; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  const m = /^(.*?)\s+(asc|desc)$/i.exec(s); if (m) { s = m[1]; desc = m[2].toLowerCase() === 'desc'; }
  return { expr: s, desc };
}
const AGGS = ['count', 'sum', 'avg', 'mean', 'min', 'max', 'median', 'distinct', 'first', 'last', 'stddev'];
function makeAgg(spec, resolve, n) {
  const m = /^\s*([A-Za-z]+)\s*(?:\(\s*([\s\S]*?)\s*\))?\s*(?:\bas\s+[`"']?([^`"']+?)[`"']?)?\s*$/i.exec(spec);
  const fn = m && m[1].toLowerCase();
  if (!m || !AGGS.includes(fn)) throw new Error(`bad aggregate "${spec}" — use e.g. "count", "sum(price)", "avg(price) as mean_price"; functions: ${AGGS.join(', ')}`);
  const arg = m[2] && m[2] !== '*' ? m[2] : null;
  if (!arg && fn !== 'count') throw new Error(`aggregate "${fn}" needs a column: ${fn}(column)`);
  const get = arg ? compile(parse(arg), resolve) : null;
  const alias = m[3] || (arg ? `${fn}_${/^[\w.]+$/.test(arg) ? arg : n}` : 'count');
  const run = (rows) => {
    if (fn === 'count') return get ? rows.reduce((c, r) => c + (get(r) !== null && get(r) !== undefined ? 1 : 0), 0) : rows.length;
    const vals = []; for (const r of rows) { const v = get(r); if (v !== null && v !== undefined) vals.push(v); }
    if (fn === 'first') return vals.length ? vals[0] : null;
    if (fn === 'last') return vals.length ? vals[vals.length - 1] : null;
    if (fn === 'distinct') return new Set(vals.map((v) => (typeof v === 'object' ? JSON.stringify(v) : `${typeof v}:${v}`))).size;
    if (fn === 'min' || fn === 'max') { if (!vals.length) return null; return vals.reduce((a, b) => { const c = compare(b, a); return (fn === 'min' ? c < 0 : c > 0) ? b : a; }); }
    const nums = vals.map(num).filter((v) => !Number.isNaN(v)); if (!nums.length) return fn === 'sum' ? 0 : null;
    const sum = nums.reduce((a, b) => a + b, 0);
    if (fn === 'sum') return Number(sum.toPrecision(15));
    if (fn === 'avg' || fn === 'mean') return Number((sum / nums.length).toPrecision(15));
    if (fn === 'median') { nums.sort((a, b) => a - b); const h = nums.length >> 1; return nums.length % 2 ? nums[h] : (nums[h - 1] + nums[h]) / 2; }
    const mean = sum / nums.length; return nums.length > 1 ? Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1)) : null;
  };
  return { alias, run };
}

/** runQuery(table, q) → {columns, rows, matched} — where → group/aggregate → having → sort → select → distinct → offset/limit */
export function runQuery(table, q = {}) {
  let { columns } = table; let rows = table.rows;
  let resolve = columnResolver(columns);
  if (q.where) { const f = compile(parse(q.where), resolve); rows = rows.filter((r) => truthy(f(r))); }
  const matched = rows.length;
  const groupBy = q.groupBy || []; const aggs = q.aggregates || [];
  if (groupBy.length || aggs.length) {
    const keys = groupBy.map((g) => { const { ast, alias } = parse(g, { allowAlias: true }); return { name: alias || g, get: compile(ast, resolve) }; });
    const A = (aggs.length ? aggs : ['count']).map((a, i) => makeAgg(a, resolve, i + 1));
    const groups = new Map();
    for (const r of rows) { const kv = keys.map((k) => { const v = k.get(r); return v === undefined ? null : v; }); const id = JSON.stringify(kv); let g = groups.get(id); if (!g) groups.set(id, (g = { kv, rows: [] })); g.rows.push(r); }
    if (!keys.length && !groups.size) groups.set('[]', { kv: [], rows: [] });
    columns = [...keys.map((k) => k.name), ...A.map((a) => a.alias)];
    rows = [...groups.values()].map((g) => [...g.kv, ...A.map((a) => a.run(g.rows))]);
    resolve = columnResolver(columns);
    if (q.having) { const f = compile(parse(q.having), resolve); rows = rows.filter((r) => truthy(f(r))); }
  } else if (q.having) throw new Error('"having" needs groupBy or aggregates');
  let sortSpecs = (q.sort || []).map(parseSort); let sorted = false;
  if (sortSpecs.length) {
    try { const keys = sortSpecs.map((s) => ({ get: compile(parse(s.expr), resolve), desc: s.desc })); rows = sortRows(rows, keys); sorted = true; } catch (e) { if (!q.select?.length) throw e; }
  }
  if (q.select?.length && !(q.select.length === 1 && q.select[0] === '*')) {
    const outCols = []; const getters = [];
    for (const item of q.select) {
      if (item === '*') { columns.forEach((c, i) => { outCols.push(c); getters.push((r) => r[i]); }); continue; }
      const { ast, alias } = parse(item, { allowAlias: true });
      outCols.push(alias || (ast.k === 'col' ? ast.name : item.trim())); getters.push(compile(ast, resolve));
    }
    rows = rows.map((r) => getters.map((g) => { const v = g(r); return v === undefined ? null : v; }));
    columns = outCols; resolve = columnResolver(columns);
  }
  if (sortSpecs.length && !sorted) rows = sortRows(rows, sortSpecs.map((s) => ({ get: compile(parse(s.expr), resolve), desc: s.desc })));
  if (q.distinct) { const seen = new Set(); rows = rows.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; }); }
  const total = rows.length;
  const offset = q.offset || 0;
  if (offset || q.limit !== undefined) rows = rows.slice(offset, q.limit !== undefined && q.limit !== null ? offset + q.limit : undefined);
  return { columns, rows, matched, total };
}
