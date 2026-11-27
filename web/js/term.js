// μεταμόρφωσις :: terminal — a thin human/agent-visible skin over M.call. Nothing here is required to use the tools.
import { M, vfs, human } from './core.js';
import { DOMAIN_MODULE } from './rooms.js';

const $ = (id) => document.getElementById(id);
const log = $('log'), prompt = $('prompt'), hints = $('hints');
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ───────────────────────────────────────────────────────────── log ──
function line(cls, html, raw = false) {
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const d = document.createElement('div'); d.className = cls;
  if (raw) d.innerHTML = html; else d.textContent = html;
  log.appendChild(d);
  while (log.childElementCount > 600) log.firstElementChild.remove();
  if (stick || cls === 'cmd') log.scrollTop = log.scrollHeight;
  return d;
}
function paint(json) {
  return esc(json).replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, bool, nul, num) => (str ? (colon ? `<span class="j-k">${str}</span>${colon}` : `<span class="j-s">${str}</span>`) : bool ? `<span class="j-b">${m}</span>` : nul ? `<span class="j-z">${m}</span>` : `<span class="j-n">${num}</span>`));
}
function show(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const rows = text.split('\n');
  const FOLD = 48;
  if (rows.length <= FOLD) return line('out', typeof value === 'string' ? esc(text) : paint(text), true);
  const d = line('out', '', true);
  const head = rows.slice(0, FOLD).join('\n'), full = text;
  const render = (open) => {
    d.innerHTML = (typeof value === 'string' ? esc(open ? full : head) : paint(open ? full : head)) + `\n<button class="fold" type="button">${open ? '▴ fold' : `▾ ${rows.length - FOLD} more lines`}</button>`;
    d.querySelector('.fold').onclick = () => render(!open);
  };
  render(false);
  return d;
}

// ────────────────────────────────────────────────────────── parsing ──
const ALIAS = { diag: 'sys.diag', log: 'sys.log', debug: 'sys.debug', ls: 'fs.list', cat: 'fs.read', rm: 'fs.rm', mv: 'fs.mv', cp: 'fs.cp', view: 'fs.preview', get: 'fs.download', fetch: 'fs.fetch', env: 'sys.env', tools: 'sys.tools', rooms: 'sys.rooms', man: 'sys.help', help: 'sys.help' };

function tokenize(s) {
  const out = []; let cur = '', q = null, depth = 0, had = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && i + 1 < s.length && depth === 0) { cur += s[++i]; continue; } if (c === q && depth === 0) { q = null; continue; } cur += c; if (c === q) q = null; continue; }
    if (depth > 0) { cur += c; if (c === '{' || c === '[') depth++; else if (c === '}' || c === ']') depth--; else if (c === '"') { const j = s.indexOf('"', i + 1); if (j > 0) { cur += s.slice(i + 1, j + 1); i = j; } } continue; }
    if (c === '"' || c === "'") { q = c; had = true; continue; }
    if (c === '{' || c === '[') { depth++; cur += c; continue; }
    if (/\s/.test(c)) { if (cur || had) out.push(cur); cur = ''; had = false; continue; }
    cur += c;
  }
  if (cur || had) out.push(cur);
  return out;
}
const value = (v) => { if (/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)$/.test(v) || /^[[{]/.test(v)) { try { return JSON.parse(v); } catch { /* keep string */ } } return v; };

async function toolFor(name) {
  name = ALIAS[name] || name;
  if (!M.tools.has(name) && DOMAIN_MODULE[name.split('.')[0]]) await M.summon(DOMAIN_MODULE[name.split('.')[0]]);
  return { name, tool: M.tools.get(name) };
}
async function parse(stage, piped) {
  const tok = tokenize(stage.trim());
  if (!tok.length) throw new Error('empty command');
  const { name, tool } = await toolFor(tok.shift());
  const args = {}; const bare = [];
  for (const t of tok) { const m = /^([A-Za-z_][\w]*)=([\s\S]*)$/.exec(t); if (m) args[m[1]] = value(m[2]); else bare.push(value(t)); }
  if (tool) {
    const props = Object.keys(tool.schema.properties); const req = tool.schema.required || [];
    if (piped !== undefined) { const k = ['input', 'path', 'inputs', 'from', 'tool'].find((p) => props.includes(p) && args[p] === undefined); if (k) args[k] = k === 'inputs' ? [].concat(piped) : Array.isArray(piped) ? piped[0] : piped; }
    const order = [...req, ...props.filter((p) => !req.includes(p))];
    for (const b of bare) { const k = order.find((p) => args[p] === undefined); if (!k) throw new Error(`too many positional arguments for ${name}`); args[k] = b; }
  } else if (bare.length) args.input = bare[0];
  return { name, args };
}

/** exec('synth.plasma | dither.apply algorithm=atkinson') — runs a command line; stages are piped by output path. */
async function exec(text) {
  text = text.trim(); if (!text) return null;
  line('cmd', text);
  if (text === 'clear') { log.textContent = ''; return null; }
  if (text === 'put') { $('file').click(); return null; }
  let piped, env = null;
  for (const stage of text.split(/\s\|\s/)) {
    try { const { name, args } = await parse(stage, piped); env = await M.call(name, args, { via: 'terminal' }); } catch (e) { env = { ok: false, error: e.message }; line('err', e.message); }
    if (!env.ok) break;
    const outs = M.outputsOf(env.result).map((o) => o.path);
    piped = outs.length > 1 ? outs : outs[0];
  }
  return env;
}
M.exec = exec;

// ─────────────────────────────────────────────────────────── events ──
// Who is calling? 'terminal' is the prompt; 'webmcp' is an agent through document.modelContext; 'api' is a script
// on the page calling M.call (an agent driving the page by JavaScript). The last two light the πράκτωρ chip, get
// their own line in the log, and drive the progress strip under the nav.
const active = new Map(); // id → {tool, via, t0, fraction, note}
const agent = { calls: 0, last: 0, timer: null };
const short = (args) => { try { const s = JSON.stringify(args); return s === '{}' ? '' : ' ' + (s.length > 160 ? s.slice(0, 157) + '…' : s); } catch { return ''; } };
function work() {
  const el = $('work'); if (!el) return;
  const cur = [...active.values()].pop();
  if (!cur) { el.hidden = true; el.classList.remove('spin', 'agent'); $('busy').hidden = true; return; }
  el.hidden = false; $('busy').hidden = false; $('busy-what').textContent = cur.tool;
  const isAgent = cur.via !== 'terminal'; el.classList.toggle('agent', isAgent);
  const known = cur.fraction != null && cur.fraction >= 0; el.classList.toggle('spin', !known);
  $('work-bar').style.width = known ? `${Math.round(Math.min(1, cur.fraction) * 100)}%` : '';
  el.setAttribute('aria-valuenow', known ? Math.round(cur.fraction * 100) : 0);
  const secs = ((performance.now() - cur.t0) / 1000).toFixed(1);
  $('work-text').textContent = `${isAgent ? `⟐ ${cur.via} ` : ''}${cur.tool}${known ? ` ${Math.round(cur.fraction * 100)}%` : ''}${cur.note ? ` — ${cur.note}` : ''} · ${secs}s${active.size > 1 ? ` · +${active.size - 1} more` : ''}`;
}
setInterval(() => { if (active.size) work(); }, 250);
function agentSeen(via) {
  agent.calls++; agent.last = Date.now();
  const chip = $('agent-chip'); if (!chip) return;
  chip.classList.add('live'); $('chip-agent').textContent = `${via} ${agent.calls}`;
  chip.title = `an agent is calling tools on this page — ${agent.calls} call${agent.calls > 1 ? 's' : ''} so far, last via ${via}`;
  clearTimeout(agent.timer); agent.timer = setTimeout(() => { if (!active.size) chip.classList.remove('live'); }, 4000);
}
M.on('log', ({ level, tool, msg }) => line(level === 'warn' ? 'warn' : 'sys', `${tool ? `[${tool}] ` : ''}${msg}`));
M.on('progress', ({ tool, fraction, note }) => { for (const a of active.values()) if (a.tool === tool) { a.fraction = fraction; a.note = note; } work(); });
M.on('call:start', ({ id, tool, args, via }) => {
  active.set(id, { tool, via, t0: performance.now() });
  if (via !== 'terminal') { agentSeen(via); line('agent', `${via} → ${tool}${short(args)}`); }
  work();
});
M.on('call:end', (env) => {
  active.delete(env.id); work();
  const { id, via, ...rest } = env;
  try { const s = JSON.stringify(rest); $('last-result').textContent = s.length > 200000 ? JSON.stringify({ ok: rest.ok, tool: rest.tool, ms: rest.ms, note: 'result too large for the DOM mirror; read M.last' }) : s.replace(/</g, '\\u003c'); } catch { /* unserialisable */ }
  if (env.ok) { show(env.result); line('ok', `✓ ${env.tool} · ${env.ms} ms${env.result?.backend ? ` · ${env.result.backend}` : ''}${via !== 'terminal' ? ` · ${via}` : ''}`); } else line('err', env.error);
  const outs = M.outputsOf(env.result);
  if (outs.length && env.tool !== 'fs.preview') render(outs[outs.length - 1].path);
});
M.on('preview', ({ stat }) => render(stat.path));
M.on('vfs', () => { clearTimeout(listFiles.t); listFiles.t = setTimeout(listFiles, 30); });

// ───────────────────────────────────────────────────────── viewport ──
let shown = null;
const PREVIEW_MODULE = [[/pdf$/, 'pdf'], [/geo\+json|kml|gpx/, 'geo']];
async function render(path) {
  const el = $('viewport');
  let stat; try { stat = vfs.stat(path); } catch { return; }
  shown = stat.path; $('view-name').textContent = stat.path;
  const { path: _p, mime, bytes, ...meta } = stat;
  $('view-meta').textContent = [mime, human(bytes), meta.width && `${meta.width}×${meta.height}`, meta.pages && `${meta.pages} pp`, meta.duration && `${(+meta.duration).toFixed(2)} s`].filter(Boolean).join(' · ');
  el.replaceChildren();
  for (const li of $('vfs').children) li.classList.toggle('on', li.dataset.path === shown);
  try {
    const mod = PREVIEW_MODULE.find(([re]) => re.test(mime) || re.test(stat.path))?.[1];
    if (mod) await M.summon(mod);
    const custom = M.previewers.find((p) => { try { return p.test(stat); } catch { return false; } });
    if (custom) { await custom.render(stat, el); return; }
    if (/^image\//.test(mime)) {
      const im = new Image(); im.alt = stat.path; im.src = vfs.url(stat.path);
      await im.decode().catch(() => {});
      if (im.naturalWidth && im.naturalWidth < 400) im.className = 'px';
      if (!meta.width && im.naturalWidth) { vfs.setMeta(stat.path, { width: im.naturalWidth, height: im.naturalHeight }); $('view-meta').textContent += ` · ${im.naturalWidth}×${im.naturalHeight}`; }
      el.append(im);
    } else if (/^video\//.test(mime)) { const v = document.createElement('video'); v.controls = true; v.muted = true; v.loop = true; v.src = vfs.url(stat.path); el.append(v); } else if (/^audio\//.test(mime)) { const a = document.createElement('audio'); a.controls = true; a.src = vfs.url(stat.path); el.append(a); } else {
      const pre = document.createElement('pre');
      if (vfs.isTextMime(mime)) { const t = new TextDecoder().decode(vfs.read(stat.path).subarray(0, 20000)); pre.textContent = t + (bytes > 20000 ? '\n…' : ''); } else { const r = await M.run('fs.read', { path: stat.path, encoding: 'hex', length: 1024 }); pre.textContent = r.hex + (r.truncated ? '\n…' : ''); }
      el.append(pre);
    }
  } catch (e) { const p = document.createElement('p'); p.className = 'void'; p.textContent = `no preview: ${e.message}`; el.append(p); }
}

function listFiles() {
  const files = vfs.list().sort((a, b) => a.path.localeCompare(b.path));
  $('files-sum').textContent = `${files.length} · ${human(files.reduce((a, f) => a + f.bytes, 0))}`;
  $('vfs').replaceChildren(...files.map((f) => {
    const li = document.createElement('li'); li.dataset.path = f.path; li.title = f.mime; if (f.path === shown) li.className = 'on';
    for (const t of [f.path, f.width ? `${f.width}×${f.height}` : f.pages ? `${f.pages}pp` : '', human(f.bytes)]) { const s = document.createElement('span'); s.textContent = t; li.append(s); }
    li.onclick = () => render(f.path);
    return li;
  }));
}

// ──────────────────────────────────────────────────── files in (human) ──
async function ingest(fileList) {
  for (const f of fileList) { const st = await vfs.write(vfs.exists(f.name) ? vfs.unique(vfs.stemOf(f.name), vfs.extOf(f.name)) : f.name || vfs.unique('pasted', vfs.extForMime(f.type)), f); line('sys', `+ ${st.path} · ${st.mime} · ${human(st.bytes)}`); render(st.path); }
}
$('pick').onclick = () => $('file').click();
$('file').onchange = (e) => { ingest(e.target.files); e.target.value = ''; };
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
addEventListener('dragleave', () => document.body.classList.remove('drag'));
addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drag'); if (e.dataTransfer?.files?.length) ingest(e.dataTransfer.files); });
addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); ingest(f); } });

// ─────────────────────────────────────────────────────────── prompt ──
const history = []; let hi = -1, sel = -1;
function suggest() {
  const v = prompt.value; hints.replaceChildren(); sel = -1;
  if (!v.trim() || /\s\|\s[^|]*\s$/.test(v)) { hints.hidden = true; return; }
  const stage = v.split(/\s\|\s/).pop(); const head = stage.trimStart().split(/\s+/)[0]; const inArgs = /\s/.test(stage.trimStart());
  let items = [];
  if (!inArgs) {
    const names = [...M.tools.values()].filter((t) => M.exposed(t)).map((t) => t.name).sort();
    items = [...names.filter((n) => n.startsWith(head)), ...names.filter((n) => !n.startsWith(head) && n.includes(head)), ...Object.keys(ALIAS).filter((a) => a.startsWith(head))].slice(0, 14)
      .map((n) => ({ fill: v.slice(0, v.length - head.length) + n + ' ', html: `<b>${esc(n)}</b>  ${esc((M.tools.get(ALIAS[n] || n)?.description || '').slice(0, 90))}` }));
  } else {
    const t = M.tools.get(ALIAS[head] || head); if (!t) { hints.hidden = true; return; }
    const last = stage.split(/\s+/).pop(); const used = new Set([...stage.matchAll(/(\w+)=/g)].map((m) => m[1])); const req = new Set(t.schema.required || []);
    if (last.includes('=')) {
      const [k, part] = [last.slice(0, last.indexOf('=')), last.slice(last.indexOf('=') + 1)]; const s = t.schema.properties[k];
      const opts = s?.enum || (/input|path|from|^a$|^b$/.test(k) ? vfs.list().map((f) => f.path) : s?.type === 'boolean' ? ['true', 'false'] : []);
      items = opts.filter((o) => String(o).startsWith(part)).slice(0, 14).map((o) => ({ fill: v.slice(0, v.length - part.length) + o + ' ', html: `<b>${esc(o)}</b>` }));
    } else {
      items = Object.entries(t.schema.properties).filter(([k]) => !used.has(k) && k.startsWith(last)).slice(0, 14)
        .map(([k, s]) => ({ fill: v.slice(0, v.length - last.length) + k + '=', html: `<b>${esc(k)}</b>${req.has(k) ? '*' : ''}  ${esc(s.enum ? s.enum.join('|') : s.type || '')}${s.default !== undefined ? ` =${esc(JSON.stringify(s.default))}` : ''}  ${esc((s.description || '').slice(0, 80))}` }));
    }
  }
  hints.hidden = !items.length;
  hints.append(...items.map((it, i) => { const li = document.createElement('li'); li.innerHTML = it.html; li.dataset.fill = it.fill; li.onmousedown = (e) => { e.preventDefault(); prompt.value = it.fill; suggest(); }; return li; }));
}
const mark = () => [...hints.children].forEach((li, i) => li.classList.toggle('on', i === sel));
prompt.addEventListener('input', suggest);
prompt.addEventListener('blur', () => { hints.hidden = true; });
prompt.addEventListener('keydown', (e) => {
  const n = hints.hidden ? 0 : hints.childElementCount;
  if (e.key === 'Tab') { e.preventDefault(); if (n) { prompt.value = hints.children[Math.max(sel, 0)].dataset.fill; suggest(); } } else if (e.key === 'ArrowDown' && n) { e.preventDefault(); sel = (sel + 1) % n; mark(); } else if (e.key === 'ArrowUp' && n && sel >= 0) { e.preventDefault(); sel--; mark(); } else if (e.key === 'ArrowUp') { if (hi < history.length - 1) { e.preventDefault(); prompt.value = history[history.length - 1 - ++hi]; } } else if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.max(-1, hi - 1); prompt.value = hi < 0 ? '' : history[history.length - 1 - hi]; } else if (e.key === 'Escape') hints.hidden = true;
  else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); log.textContent = ''; }
});
$('line').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = (sel >= 0 && !hints.hidden ? hints.children[sel].dataset.fill : prompt.value).trim();
  if (sel >= 0 && !hints.hidden) { prompt.value = v + ' '; suggest(); return; }
  prompt.value = ''; hints.hidden = true; hi = -1; if (!v) return;
  history.push(v); exec(v);
});
addEventListener('keydown', (e) => { if (e.target === document.body && e.key.length === 1 && !e.ctrlKey && !e.metaKey) prompt.focus(); });

// ───────────────────────────────────────────────────────────── veil ──
// 1-bit ordered-dither plasma behind the masthead. Cheap: a few thousand cells at ~10 fps, still when asked.
(function veil() {
  const c = $('veil'); const g = c.getContext('2d'); if (!g) return;
  const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches; let t = Math.random() * 100, last = 0, img;
  function frame(now) {
    if (!still) requestAnimationFrame(frame);
    if (now - last < 100 || document.hidden) return; last = now;
    const w = Math.max(8, Math.ceil(c.clientWidth / 4)), h = Math.max(8, Math.ceil(c.clientHeight / 4));
    if (c.width !== w || c.height !== h || !img) { c.width = w; c.height = h; img = g.createImageData(w, h); }
    const d = img.data; t += 0.035;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
      const v = (Math.sin(x * 0.09 + t) + Math.sin(y * 0.17 - t * 0.7) + Math.sin((x + y) * 0.06 + t * 0.5) + Math.sin(Math.hypot(x - w * 0.7, y - h * 0.4) * 0.11 - t)) / 8 + 0.5;
      const on = v * (0.35 + 0.65 * x / w) > (B[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
      d[i] = on ? 70 : 4; d[i + 1] = on ? 190 : 7; d[i + 2] = on ? 60 : 4; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  requestAnimationFrame(frame);
})();

// ───────────────────────────────────────────────────────────── boot ──
function nav() {
  const el = $('rooms'); if (!el) return;
  const a = (href, gr, id, on) => `<a href="${href}"${on ? ' aria-current="page"' : ''} title="${esc(id)}"><span>${gr}</span> ${esc(id)}</a>`;
  el.innerHTML = a(M.room.url(''), 'ἀρχή', 'hub', M.room.id === 'hub') + M.rooms.map((r) => a(M.room.url(r.id), r.gr, r.id, M.room.ids.includes(r.id))).join('');
}

// the strip at the very top: this room's tools (on the hub: every room's, from tools.json), right to left, in Greek:
// the family as a Greek word, the verb transliterated into Greek letters. Hover shows the real name.
const GR_DOMAIN = { image: 'εἰκών', analysis: 'ἀνάλυσις', synth: 'σύνθεσις', dither: 'κόκκος', gpu: 'φῶς', vision: 'ὅρασις', pdf: 'βίβλος', video: 'κίνησις', audio: 'φωνή', geo: 'γῆ', data: 'ἀριθμός', file: 'ἀρχεῖον', hash: 'σύνοψις', encode: 'κῶδιξ', archive: 'θήκη', doc: 'λόγος', text: 'κείμενον', claude: 'νοῦς', fs: 'ὕλη', sys: 'σύστημα' };
const GR_PAIR = { th: 'θ', ph: 'φ', ch: 'χ', ps: 'ψ', ks: 'ξ', ou: 'ου', ee: 'η', oo: 'ω' };
const GR_ONE = { a: 'α', b: 'β', c: 'κ', d: 'δ', e: 'ε', f: 'φ', g: 'γ', h: 'η', i: 'ι', j: 'ι', k: 'κ', l: 'λ', m: 'μ', n: 'ν', o: 'ο', p: 'π', q: 'κ', r: 'ρ', s: 'σ', t: 'τ', u: 'υ', v: 'β', w: 'ω', x: 'ξ', y: 'υ', z: 'ζ' };
function greek(word) {
  const w = word.toLowerCase(); let out = '';
  for (let i = 0; i < w.length; i++) { const two = GR_PAIR[w.slice(i, i + 2)]; if (two) { out += two; i++; } else out += GR_ONE[w[i]] ?? w[i]; }
  return out.replace(/σ$/, 'ς');
}
const greekTool = (name) => { const [d, v] = name.split('.'); return `${GR_DOMAIN[d] || greek(d)}·${greek(v)}`; };
async function marquee() {
  const track = $('marquee-track'); if (!track) return;
  let names = [...M.tools.values()].filter((t) => M.exposed(t) && !['fs', 'sys'].includes(t.domain)).map((t) => t.name).sort();
  if (M.room.id === 'hub') { try { const m = await (await fetch(new URL('tools.json', M.room.root))).json(); names = m.tools.map((t) => t.name).filter((n) => !/^(fs|sys)\./.test(n)); } catch { /* manifest not published yet */ } }
  if (!names.length) names = [...M.tools.keys()].sort();
  const run = names.map((n) => `<span title="${esc(n)}">${esc(greekTool(n))}</span>`).join('');
  track.innerHTML = run + run; // two copies: the loop is seamless at -50%
  track.style.setProperty('--drift', `${Math.max(30, names.length * 2.2)}s`);
}

// chips and per-room verdicts: filled in after the banner, never blocking it (capability probes can take a moment)
async function indicators() {
  const env = await M.run('sys.env');
  const chip = (id, text, cls, tip) => { const e = $(id); if (!e) return; e.textContent = text; e.className = cls || ''; if (tip) e.parentElement.title = tip; };
  const d = M.diag; const f = d ? await d.probe() : {}; const b = d?.browser() || {};
  chip('chip-browser', `${(b.name || '?').toLowerCase()} ${b.major ?? ''}`.trim(), '', `${b.name} ${b.version || ''} · ${b.engine} · ${b.os}${b.mobile ? ' · mobile' : ''}`);
  chip('chip-gpu', env.gpu.available ? (env.gpu.fallback ? 'software' : env.gpu.vendor || 'webgpu') : 'cpu', env.gpu.available && !env.gpu.fallback ? '' : 'off', f.webgpu?.detail || '');
  chip('chip-wasm', env.wasm.simd ? 'simd' : env.wasm.supported ? 'no simd' : 'none', env.wasm.simd ? '' : 'bad', `simd ${env.wasm.simd ? 'yes' : 'NO'} · threads ${env.wasm.threads ? 'yes' : 'no (static host)'}`);
  chip('chip-mcp', env.webmcp.registered ? `${env.webmcp.native ? 'native' : 'polyfill'} ${env.webmcp.registered}` : 'off', env.webmcp.registered ? '' : 'off', f.webmcpNative?.detail || '');
  chip('chip-tools', String(env.tools));
  // per-room verdict for this browser: a mark on the nav, and a plain explanation if the room you are in is affected
  if (d) {
    const verdicts = await d.rooms();
    for (const v of verdicts) {
      if (v.status === 'ok') continue;
      const a = document.querySelector(`#rooms a[title="${v.id}"]`);
      if (a) { a.insertAdjacentHTML('beforeend', `<i class="${v.status}">${v.status === 'blocked' ? '✗' : '◐'}</i>`); a.title = `${v.id} — ${v.status}: ${v.issues.map((x) => `${x.feature} (${x.effect})`).join('; ')}`; }
      if (M.room.ids.includes(v.id)) for (const x of v.issues) if (x.need !== 'optional') line(x.need === 'required' ? 'err' : 'warn', `${b.name}: ${x.feature} is missing — ${x.effect}`);
    }
    const flag = $('diag-flag');
    const paint = ({ counts }) => { if (!flag) return; flag.hidden = !(counts.error + counts.warn); flag.textContent = `${counts.error ? `✗ ${counts.error}` : ''}${counts.error && counts.warn ? ' ' : ''}${counts.warn ? `△ ${counts.warn}` : ''}`; flag.classList.toggle('bad', counts.error > 0); };
    paint({ counts: d.counts }); M.on('diag', paint);
    if (flag) flag.onclick = () => exec('sys.log level=warn');
  }
}

export async function afterBoot() {
  nav(); listFiles(); marquee();
  indicators().catch((e) => M.diag?.log('error', 'ui', `indicators failed: ${e.message}`));
  const here = M.rooms.filter((r) => M.room.ids.includes(r.id));
  line('banner', `μεταμόρφωσις ${M.version} · ${M.room.id === 'hub' ? 'ἀρχή — the hub' : here.map((r) => `${r.gr} — ${r.id}`).join(' · ')}`);
  if (M.room.id === 'hub') {
    line('sys', 'Each room is a page holding one family of tools. Enter one; your files follow you.');
    line('out roomlist', M.rooms.map((r) => `<a href="${M.room.url(r.id)}">${esc(r.id)}/</a><span class="j-z">${r.gr}</span><span>${esc(r.about)}</span>`).join(''), true);
  } else {
    for (const r of here) line('sys', r.about);
    const names = [...M.tools.values()].filter((t) => M.exposed(t) && !['fs', 'sys'].includes(t.domain)).map((t) => t.name).sort();
    line('out', names.join('  ') || '(no tools loaded for this room)');
  }
  line('note', 'type a tool name · tab completes · `man <tool>` for its schema · `a | b` pipes outputs · `rooms` lists the other rooms · `diag` checks this browser');
  const x = new URLSearchParams(location.search).get('x');
  if (x) for (const cmd of x.split(';')) await exec(cmd);
  if (matchMedia('(pointer: fine)').matches) prompt.focus();
}
