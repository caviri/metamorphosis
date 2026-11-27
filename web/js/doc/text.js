// text helpers for doc.* / text.* — pure functions (no DOM, no VFS) so they can also be exercised from node.

// ───────────────────────────────────────────────────── token estimate ──
// NOT a tokenizer. A character-class heuristic whose weights were fitted (grid search, .scratch calibration) against
// tiktoken cl100k_base and o200k_base on ten samples: English prose, Markdown with many URLs, technical docs with code,
// Python, JavaScript, JSON, German, Russian, Japanese and Chinese. Worst sample error after fitting: 19%.
//   ASCII word ≤ 8 letters = 1 token, longer = len / 4; digits = len / 2; non-ASCII word = len / 2.5;
//   each CJK ideograph / kana / hangul syllable = 1.1; each punctuation mark = 0.6 (a repeated mark adds 0.25);
//   a run of line breaks = 1; a single space is free, a longer run of spaces/tabs = 1; other symbols / emoji = 1.5.
export const TOKEN_HEURISTIC = 'character-class heuristic, NOT a tokenizer: ASCII word of \u22648 letters = 1 token, longer = len/4; digits = len/2; non-ASCII word = len/2.5; CJK/kana/hangul char = 1.1; punctuation mark = 0.6; newline run = 1; single space free; summed and rounded up. Weights were fitted against OpenAI cl100k_base/o200k_base on 10 samples (English prose, URL-heavy Markdown, technical docs, Python, JS, JSON, German, Russian, Japanese, Chinese): errors ranged from \u221219% (JSON) to +19% (code-heavy docs), within \u00b15% on English prose. Not measured against Claude tokenizers, which usually produce more tokens than these (assume this estimate can be 10\u201340% low for Claude); keep headroom.';
const TOKEN_RE = /[A-Za-z]+(?![\p{L}\p{M}])|[0-9]+|[ \t]+|[\r\n]+|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u8c48-\ufaff]|[\p{L}\p{M}]+|[\s\S]/gu;
/** fractional estimate; estimateTokens() rounds it up */
export function estimateTokensRaw(s) {
  if (!s) return 0;
  let t = 0; let m; let prev = '';
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(s))) {
    const w = m[0]; const c = w.charCodeAt(0); const len = w.length;
    if (c === 32 || c === 9) { if (len > 1) t += 1; prev = ''; continue; }
    if (c === 10 || c === 13) { t += 1; prev = ''; continue; }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { t += len <= 8 ? 1 : len / 4; prev = ''; continue; }
    if (c >= 48 && c <= 57) { t += len / 2; prev = ''; continue; }
    if (len === 1 && c < 128) { if (w === prev) t += 0.25; else { t += 0.6; prev = w; } continue; }
    prev = '';
    if (len === 1 && ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff))) { t += 1.1; continue; }
    if (/^[\p{L}\p{M}]/u.test(w)) { t += len / 2.5; continue; }
    t += 1.5;
  }
  return t;
}
export const estimateTokens = (s) => Math.ceil(estimateTokensRaw(s) - 1e-9);

export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } else n += 3;
  }
  return n;
}

export function excerpt(s, max = 600) {
  s = String(s ?? '');
  if (s.length <= max) return { excerpt: s, truncated: false };
  let cut = max; const c = s.charCodeAt(cut - 1); if (c >= 0xd800 && c <= 0xdbff) cut--;
  return { excerpt: s.slice(0, cut), truncated: true };
}

// ───────────────────────────────────────────────────────────── stats ──
const STOP = {
  en: 'the and of to in is that it for was with as on be at by this have from or had not are but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know',
  de: 'der die und in den von zu das mit sich des auf f\u00fcr ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem \u00fcber einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei',
  fr: 'de la le et les des en un du une que est pour qui dans a par plus pas au sur ne se ce il sont la mais comme ou si leur y dont nous vous avec tout elle \u00e9t\u00e9 cette \u00eatre fait aux son ont ses ces deux m\u00eame aussi',
  es: 'de la que el en y a los del se las por un para con no una su al lo como m\u00e1s pero sus le ya o este s\u00ed porque esta entre cuando muy sin sobre tambi\u00e9n me hasta hay donde quien desde todo nos durante todos uno les',
  it: 'di e il la che in a per un \u00e8 del non una le con si da i dei come al pi\u00f9 ma gli nel anche della sono lo ha alla o se su questo tra delle ci ai essere suo fra tutti hanno nei alle',
  pt: 'de a o que e do da em um para \u00e9 com n\u00e3o uma os no se na por mais as dos como mas foi ao ele das tem \u00e0 seu sua ou ser quando muito h\u00e1 nos j\u00e1 est\u00e1 eu tamb\u00e9m s\u00f3 pelo pela at\u00e9 isso ela entre',
  nl: 'de van het een en in is dat op te zijn met voor niet aan er door ook als om bij maar uit naar nog wordt dan of over tot je hij ze heeft hebben deze werd meer dit die al zo',
  sv: 'och i att det som en p\u00e5 \u00e4r av f\u00f6r med till den har de inte om ett han men var sig jag fr\u00e5n s\u00e5 kan n\u00e4r \u00e5r vi man eller hade nu ocks\u00e5 efter h\u00e4r mot ska vid',
  da: 'og i at det en den til er som p\u00e5 de med han af for ikke der var mig sig men et har om vi min havde ham hun nu over da fra du ud sin dem os op man hans hvor eller hvad skal selv',
  pl: 'w i z na do si\u0119 nie to \u017ce jest o a jak po co tak za od ale przez dla czy by\u0107 ten by\u0142 tym ju\u017c go s\u0105 przy mo\u017ce tylko lub ich tego oraz te\u017c zosta\u0142 kt\u00f3re kt\u00f3ra',
  tr: 've bir bu da de i\u00e7in ile olarak \u00e7ok daha olan gibi en ne var ben o kadar sonra ise ama veya her ki mi de\u011fil bunu \u015fey ya g\u00f6re diye',
  id: 'yang dan di ke dari ini itu dengan untuk pada tidak dalam akan adalah juga oleh atau ada mereka sudah saya kami kita bisa karena sebagai dapat lebih telah',
  fi: 'ja on ei ett\u00e4 oli se h\u00e4n mutta kun niin kuin my\u00f6s ovat joka tai sen ole vain jos olla sek\u00e4 mit\u00e4 t\u00e4m\u00e4 siit\u00e4',
};
let stopSets;
const SCRIPTS = [
  ['Latin', /\p{Script=Latin}/gu], ['Cyrillic', /\p{Script=Cyrillic}/gu], ['Greek', /\p{Script=Greek}/gu], ['Han', /\p{Script=Han}/gu],
  ['Hiragana', /\p{Script=Hiragana}/gu], ['Katakana', /\p{Script=Katakana}/gu], ['Hangul', /\p{Script=Hangul}/gu], ['Arabic', /\p{Script=Arabic}/gu],
  ['Hebrew', /\p{Script=Hebrew}/gu], ['Devanagari', /\p{Script=Devanagari}/gu], ['Thai', /\p{Script=Thai}/gu],
];
export function guessLanguage(text) {
  const sample = text.length > 200000 ? text.slice(0, 200000) : text;
  const scripts = {}; let total = 0;
  for (const [name, re] of SCRIPTS) { const n = (sample.match(re) || []).length; if (n) { scripts[name] = n; total += n; } }
  if (!total) return { language: null, script: null, confidence: 0, scripts: {}, method: 'no letters found' };
  const share = (k) => (scripts[k] || 0) / total;
  const top = Object.entries(scripts).sort((a, b) => b[1] - a[1])[0][0];
  const scriptShares = Object.fromEntries(Object.entries(scripts).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / total).toFixed(3)]));
  const by = (language, confidence, note) => ({ language, script: top, confidence: +confidence.toFixed(2), scripts: scriptShares, method: note });
  if (share('Hiragana') + share('Katakana') > 0.08) return by('ja', 0.9, 'script: kana present');
  if (share('Hangul') > 0.3) return by('ko', 0.9, 'script: Hangul');
  if (share('Han') > 0.4) return by('zh', 0.75, 'script: Han without kana (Chinese assumed)');
  const scriptLang = { Cyrillic: ['ru', 'script only: Cyrillic (Russian assumed; could be Ukrainian, Bulgarian, Serbian\u2026)', 0.5], Greek: ['el', 'script: Greek', 0.85], Arabic: ['ar', 'script only: Arabic (could be Persian, Urdu\u2026)', 0.5], Hebrew: ['he', 'script: Hebrew', 0.8], Devanagari: ['hi', 'script only: Devanagari (Hindi assumed)', 0.5], Thai: ['th', 'script: Thai', 0.9] };
  if (scriptLang[top]) return by(scriptLang[top][0], scriptLang[top][2], scriptLang[top][1]);
  stopSets ||= Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(' '))]));
  const words = (sample.toLowerCase().match(/[\p{L}]+/gu) || []).slice(0, 20000);
  if (words.length < 3) return by(null, 0, 'too few words');
  const hits = {}; for (const k in stopSets) hits[k] = 0;
  for (const w of words) for (const k in stopSets) if (stopSets[k].has(w)) hits[k]++;
  const ranked = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  const [best, n1] = ranked[0]; const n2 = ranked[1][1];
  if (n1 / words.length < 0.08) return by(null, 0, 'stop-word match too weak (code, data or an unsupported language)');
  const conf = Math.min(0.99, (n1 - n2) / Math.max(1, n1) + Math.min(0.3, words.length / 1000));
  return by(best, conf, `stop-word frequency over ${Object.keys(STOP).join('/')}`);
}

export function splitSentences(text) {
  return text.split(/(?<=[.!?\u3002\uff01\uff1f]["'\u201d\u2019)\]]*)\s+|(?<=[\u3002\uff01\uff1f])(?=[^\s\u3002\uff01\uff1f\u300d\u300f\uff09])|\n{2,}/u).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

export function textStats(text) {
  const lines = text === '' ? 0 : text.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0);
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const wordList = text.match(/[\p{L}\p{N}]+(?:['\u2019\-][\p{L}\p{N}]+)*/gu) || [];
  // CJK runs are not space-delimited: count them out of the "words" and report them separately.
  let words = 0; let wordChars = 0;
  for (const w of wordList) { if (/^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/.test(w)) continue; words++; wordChars += w.length; }
  const chars = [...text].length;
  const paragraphs = text.split(/(?:\r?\n[ \t]*){2,}/).filter((p) => p.trim()).length;
  const sentences = splitSentences(text).length;
  let longest = 0; for (const l of text.split(/\r\n|\r|\n/)) if (l.length > longest) longest = l.length;
  const minutes = words / 230 + cjk / 500;
  return {
    bytes: utf8Length(text), characters: chars, charactersNoSpaces: chars - (text.match(/\s/g) || []).length,
    words, cjkCharacters: cjk, lines, paragraphs, sentences, longestLine: longest,
    avgWordLength: words ? +(wordChars / words).toFixed(2) : 0,
    readingTimeMinutes: +minutes.toFixed(1), readingTimeBasis: '230 words/min + 500 CJK chars/min',
  };
}

// ───────────────────────────────────────────────────────── markdown ──
/** Scan markdown lines for headings (ATX + setext), ignoring fenced code. \u2192 [{level, text, line (1-based), start (char offset)}] */
export function scanHeadings(text) {
  const out = []; let pos = 0; let fence = null; let prevLine = null; let prevStart = 0; let prevBlank = true;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]; const line = raw.replace(/\r$/, '');
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null; } else if (f) fence = f[1];
    else {
      const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (m) out.push({ level: m[1].length, text: (m[2] || '').trim(), line: i + 1, start: pos });
      else if (/^ {0,3}(=+|-+)[ \t]*$/.test(line) && prevLine !== null && !prevBlank && !/^ {0,3}([-*+>]|\d+[.)])\s/.test(prevLine) && !/^\s*\|/.test(prevLine)) {
        if (line.trim()[0] === '=' || line.trim().length >= 2) out.push({ level: line.trim()[0] === '=' ? 1 : 2, text: prevLine.trim(), line: i, start: prevStart });
      }
    }
    prevBlank = !line.trim() || !!fence || !!f; prevLine = line; prevStart = pos;
    pos += raw.length + 1;
  }
  return out;
}

/** Shift ATX heading levels outside fenced code by `offset`, clamped to 1..6. */
export function shiftHeadings(md, offset) {
  if (!offset) return md;
  let fence = null;
  return md.split('\n').map((line) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return line; }
    if (f) { fence = f[1]; return line; }
    return line.replace(/^( {0,3})(#{1,6})(?=[ \t]|$)/, (_, sp, h) => sp + '#'.repeat(Math.max(1, Math.min(6, h.length + offset))));
  }).join('\n');
}

export function outline(text) {
  const hs = scanHeadings(text);
  const bounds = hs.map((h) => h.start); bounds.push(text.length);
  let byte = 0; let last = 0; const byteAt = (pos) => { byte += utf8Length(text.slice(last, pos)); last = pos; return byte; };
  const preambleEnd = hs.length ? hs[0].start : text.length;
  const preamble = { tokens: estimateTokens(text.slice(0, preambleEnd)), byteStart: 0, byteEnd: byteAt(preambleEnd) };
  const nodes = hs.map((h, i) => {
    const own = text.slice(h.start, bounds[i + 1]);
    const byteStart = byteAt(h.start);
    return { index: i, level: h.level, title: h.text, line: h.line, byteStart, ownTokens: estimateTokens(own), _end: bounds[i + 1] };
  });
  // section end = next heading of same or higher level; totals include sub-sections
  for (let i = 0; i < nodes.length; i++) {
    let j = i + 1; let total = nodes[i].ownTokens;
    while (j < nodes.length && nodes[j].level > nodes[i].level) { total += nodes[j].ownTokens; j++; }
    nodes[i].tokens = total; nodes[i]._endPos = j < nodes.length ? hs[j].start : text.length; nodes[i].children = j - i - 1;
  }
  const byPos = [...new Set(nodes.map((n) => n._endPos))].sort((a, b) => a - b); const endBytes = new Map();
  byte = 0; last = 0; for (const p of byPos) endBytes.set(p, byteAt(p));
  const stack = [];
  for (const n of nodes) {
    while (stack.length && stack[stack.length - 1].level >= n.level) stack.pop();
    n.path = [...stack.map((s) => s.title), n.title]; n.depth = stack.length; stack.push(n);
    n.byteEnd = endBytes.get(n._endPos); delete n._end; delete n._endPos;
  }
  return { preamble, nodes };
}

// ───────────────────────────────────────────────────────────── chunk ──
function hardSplit(text, start, end, cap, out, rank) {
  // split [start,end) on word boundaries, then on code points, so every atom is ≤ cap tokens
  const seg = text.slice(start, end);
  const words = seg.match(/\s*\S+\s*/g) || [seg];
  let pos = start; let first = true;
  for (const w of words) {
    const tok = estimateTokensRaw(w);
    if (tok <= cap) { out.push({ start: pos, end: pos + w.length, rank: first ? rank : 0.5, tokens: tok }); pos += w.length; first = false; continue; }
    const cps = [...w]; let buf = ''; let bufStart = pos;
    for (const cp of cps) {
      if (buf && estimateTokensRaw(buf + cp) > cap) { out.push({ start: bufStart, end: bufStart + buf.length, rank: first ? rank : 0, tokens: estimateTokensRaw(buf) }); first = false; bufStart += buf.length; buf = ''; }
      buf += cp;
    }
    if (buf) { out.push({ start: bufStart, end: bufStart + buf.length, rank: first ? rank : 0, tokens: estimateTokensRaw(buf) }); first = false; }
    pos += w.length;
  }
}
function splitBlock(text, b, cap, out) {
  const whole = estimateTokensRaw(text.slice(b.start, b.end));
  if (whole <= cap) { out.push({ start: b.start, end: b.end, rank: b.rank, tokens: whole }); return; }
  // lines (code) or sentences (prose), keeping trailing whitespace with the piece before it
  const seg = text.slice(b.start, b.end);
  const re = b.kind === 'code' || b.kind === 'table' ? /[^\n]*\n|[^\n]+$/g : /[\s\S]*?(?:[.!?\u3002\uff01\uff1f]+["'\u201d\u2019)\]]*\s+|\n+|$)/g;
  let m; let first = true; let guard = 0;
  re.lastIndex = 0;
  while ((m = re.exec(seg)) && guard++ < 1e7) {
    if (!m[0]) { if (re.lastIndex >= seg.length) break; re.lastIndex++; continue; }
    const s = b.start + m.index; const e = s + m[0].length; const tok = estimateTokensRaw(m[0]);
    const rank = first ? b.rank : (b.kind === 'code' || b.kind === 'table' || seg.charCodeAt(m.index - 1) === 10 ? 2 : 1);
    if (tok <= cap) out.push({ start: s, end: e, rank, tokens: tok }); else hardSplit(text, s, e, cap, out, rank);
    first = false;
    if (e >= b.end) break;
  }
}
/**
 * chunkText(text, {budget, overlap, mode}) \u2192 {chunks:[{start,end,newStart,tokens,headingPath}], atoms}
 * Chunks are exact slices text.slice(start,end); [start,newStart) repeats the tail of the previous chunk.
 */
export function chunkText(text, { budget = 800, overlap = 0, markdown = true } = {}) {
  if (overlap > budget / 2) throw new Error(`overlap (${overlap}) must be at most half the budget (${budget})`);
  // 1. blocks
  const blocks = []; const paths = [[]]; let stack = [];
  const lineRe = /[^\n]*\n|[^\n]+$/g; let m; let cur = null; let fence = null;
  const close = () => { if (cur) { blocks.push(cur); cur = null; } };
  while ((m = lineRe.exec(text))) {
    const line = m[0]; const s = m.index; const e = s + line.length; const bare = line.replace(/\r?\n$/, '');
    const f = markdown ? /^ {0,3}(`{3,}|~{3,})/.exec(bare) : null;
    if (fence) { cur.end = e; if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(bare)) { fence = null; cur.closed = true; } continue; }
    if (f) { close(); fence = f[1]; cur = { start: s, end: e, kind: 'code', rank: 3, path: paths.length - 1 }; continue; }
    if (!bare.trim()) { if (cur) { cur.end = e; cur.blank = true; } else if (blocks.length) blocks[blocks.length - 1].end = e; else cur = { start: s, end: e, kind: 'para', rank: 3, path: paths.length - 1, blank: true }; continue; }
    const h = markdown ? /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(bare) : null;
    if (h) {
      close();
      const level = h[1].length; stack = stack.filter((x) => x.level < level); stack.push({ level, title: (h[2] || '').trim() });
      paths.push(stack.map((x) => x.title));
      cur = { start: s, end: e, kind: 'heading', rank: 4 + (7 - level) / 10, path: paths.length - 1, blank: true }; // blank:true \u2192 next line starts a new block
      continue;
    }
    if (cur && (cur.blank || cur.closed)) close();
    const isTable = markdown && /^\s*\|/.test(bare);
    if (!cur) cur = { start: s, end: e, kind: isTable ? 'table' : 'para', rank: 3, path: paths.length - 1 }; else cur.end = e;
  }
  close();
  // 2. atoms ≤ budget/4
  const cap = Math.max(1, Math.floor(budget / 4)); const atoms = [];
  for (const b of blocks) { const n0 = atoms.length; splitBlock(text, b, cap, atoms); for (let i = n0; i < atoms.length; i++) atoms[i].path = b.path; }
  // 3. greedy packing with boundary preference
  const chunks = []; const N = atoms.length; let i = 0; let prevEnd = 0;
  while (prevEnd < N) {
    let sum = 0; let j = i; const firstNew = prevEnd;
    while (j < N && (sum + atoms[j].tokens <= budget || j < firstNew + 1)) { sum += atoms[j].tokens; j++; }
    if (j < N) { // choose the best boundary in the back part of the window
      let acc = 0; let best = j; let bestRank = atoms[j].rank; const floor = budget * 0.55;
      for (let k = i; k < j; k++) { if (k > firstNew && acc >= floor && (atoms[k].rank > bestRank || (atoms[k].rank === bestRank && best !== j))) { best = k; bestRank = atoms[k].rank; } acc += atoms[k].tokens; }
      j = best;
    }
    // exact check on the real slice (sum of atom estimates can differ at the seams)
    let tokens = estimateTokens(text.slice(atoms[i].start, atoms[j - 1].end));
    while (tokens > budget && (j - 1 > firstNew || i < firstNew)) {
      if (j - 1 > firstNew) j--; else i++;
      tokens = estimateTokens(text.slice(atoms[i].start, atoms[j - 1].end));
    }
    chunks.push({ start: atoms[i].start, end: atoms[j - 1].end, newStart: atoms[firstNew].start, tokens, headingPath: paths[atoms[firstNew].path] });
    prevEnd = j;
    let ni = j; let ov = 0;
    while (overlap > 0 && ni - 1 > i && ni - 1 >= 0 && ov + atoms[ni - 1].tokens <= overlap) { ni--; ov += atoms[ni].tokens; }
    i = ni;
  }
  return { chunks, atoms: N };
}

// ────────────────────────────────────────────────────────────── diff ──
function splitLinesEol(text) {
  if (text === '') return { lines: [], noEol: false };
  const lines = text.split('\n'); let noEol = true;
  if (lines[lines.length - 1] === '') { lines.pop(); noEol = false; }
  return { lines, noEol };
}
/** Myers O(ND) line diff. \u2192 {ops: [' '|'-'|'+', aIndex, bIndex][], approximate} */
export function diffLines(a, b, maxD = 3000) {
  const ids = new Map(); const id = (s) => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v); } return v; };
  const A = Int32Array.from(a, id); const B = Int32Array.from(b, id);
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const n = A.length - pre - suf; const m = B.length - pre - suf;
  const ops = []; for (let i = 0; i < pre; i++) ops.push([' ', i, i]);
  let approximate = false;
  const mid = [];
  if (n && m) {
    const max = Math.min(n + m, maxD); const off = max; let v = new Int32Array(2 * max + 2); const trace = []; let found = -1;
    outer: for (let d = 0; d <= max; d++) {
      trace.push(v.slice(off - d, off + d + 1));
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && A[pre + x] === B[pre + y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) { found = d; break outer; }
      }
    }
    if (found < 0) { approximate = true; for (let i = 0; i < n; i++) mid.push(['-', pre + i, -1]); for (let j = 0; j < m; j++) mid.push(['+', -1, pre + j]); } else {
      let x = n; let y = m; const rev = [];
      for (let d = found; d > 0; d--) {
        const pv = trace[d]; const at = (k) => pv[k + d]; // snapshot taken before round d = state after round d-1, indices -d..d
        const k = x - y;
        const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
        const prevX = at(prevK); const prevY = prevX - prevK;
        while (x > prevX && y > prevY) { x--; y--; rev.push([' ', pre + x, pre + y]); }
        if (x === prevX) { y--; rev.push(['+', -1, pre + y]); } else { x--; rev.push(['-', pre + x, -1]); }
      }
      while (x > 0 && y > 0) { x--; y--; rev.push([' ', pre + x, pre + y]); }
      for (let i = rev.length - 1; i >= 0; i--) mid.push(rev[i]);
    }
  } else { for (let i = 0; i < n; i++) mid.push(['-', pre + i, -1]); for (let j = 0; j < m; j++) mid.push(['+', -1, pre + j]); }
  for (const o of mid) ops.push(o);
  for (let i = 0; i < suf; i++) ops.push([' ', A.length - suf + i, B.length - suf + i]);
  return { ops, approximate };
}
export function unifiedDiff(textA, textB, { nameA = 'a', nameB = 'b', context = 3, ignoreWhitespace = false, ignoreCase = false, maxD } = {}) {
  const sa = splitLinesEol(textA.replace(/\r\n/g, '\n')); const sb = splitLinesEol(textB.replace(/\r\n/g, '\n'));
  const key = (l) => { let k = l; if (ignoreWhitespace) k = k.replace(/\s+/g, ' ').trim(); if (ignoreCase) k = k.toLowerCase(); return k; };
  const ka = sa.lines.map(key); const kb = sb.lines.map(key);
  if (sa.noEol !== sb.noEol && !ignoreWhitespace) { if (sa.noEol && ka.length) ka[ka.length - 1] += '\u0000noeol'; if (sb.noEol && kb.length) kb[kb.length - 1] += '\u0000noeol'; }
  const { ops, approximate } = diffLines(ka, kb, maxD);
  let added = 0; let removed = 0; for (const o of ops) { if (o[0] === '+') added++; else if (o[0] === '-') removed++; }
  const out = []; let hunks = 0;
  if (added || removed) {
    out.push(`--- ${nameA}`, `+++ ${nameB}`);
    let i = 0; let cur = 0; let ai = 0; let bi = 0;
    while (i < ops.length) {
      if (ops[i][0] === ' ') { i++; continue; }
      let s = Math.max(0, i - context); let e = i; let lastChange = i;
      while (e < ops.length && (ops[e][0] !== ' ' || e - lastChange <= context * 2)) { if (ops[e][0] !== ' ') lastChange = e; e++; }
      e = Math.min(ops.length, lastChange + context + 1);
      let aStart = 0; let bStart = 0; let aLen = 0; let bLen = 0; const body = [];
      // line numbers before the hunk
      for (; cur < s; cur++) { if (ops[cur][0] !== '+') ai++; if (ops[cur][0] !== '-') bi++; }
      aStart = ai + 1; bStart = bi + 1;
      for (let k = s; k < e; k++) {
        const [t, x, y] = ops[k];
        const line = t === '+' ? sb.lines[y] : sa.lines[x];
        body.push(t + line);
        if (t !== '+') { aLen++; if (sa.noEol && x === sa.lines.length - 1) body.push('\\ No newline at end of file'); }
        if (t !== '-') { bLen++; if (t === '+' && sb.noEol && y === sb.lines.length - 1) body.push('\\ No newline at end of file'); }
      }
      out.push(`@@ -${aLen ? aStart : aStart - 1}${aLen === 1 ? '' : ',' + aLen} +${bLen ? bStart : bStart - 1}${bLen === 1 ? '' : ',' + bLen} @@`, ...body);
      hunks++; i = e;
    }
  }
  const common = ops.length - added - removed;
  return {
    diff: out.length ? out.join('\n') + '\n' : '', identical: !added && !removed, added, removed, unchanged: common, hunks, approximate,
    linesA: sa.lines.length, linesB: sb.lines.length,
    similarity: sa.lines.length + sb.lines.length ? +((2 * common) / (sa.lines.length + sb.lines.length)).toFixed(4) : 1,
  };
}

// ───────────────────────────────────────────────────────── normalize ──
const QUOTES = { '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\u2032': "'", '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"', '\u2033': '"', '\u00ab': '"', '\u00bb': '"', '\u2039': "'", '\u203a': "'", '\u2013': '-', '\u2014': '--', '\u2015': '--', '\u2212': '-', '\u2010': '-', '\u2011': '-', '\u2026': '...', '\u00a0': ' ', '\u2009': ' ', '\u200a': ' ', '\u202f': ' ', '\u2002': ' ', '\u2003': ' ', '\u3000': ' ' };
export function normalizeText(text, o) {
  const changes = {}; const count = (k, n) => { if (n) changes[k] = (changes[k] || 0) + n; };
  if (o.stripBom && text.charCodeAt(0) === 0xfeff) { text = text.slice(1); count('bomRemoved', 1); }
  if (o.unicode && o.unicode !== 'none') { const t = text.normalize(o.unicode); if (t !== text) { count('unicodeNormalized', 1); text = t; } }
  if (o.asciiQuotes) text = text.replace(/[\u2018\u2019\u201a\u201b\u2032\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb\u2039\u203a\u2013\u2014\u2015\u2212\u2010\u2011\u2026\u00a0\u2009\u200a\u202f\u2002\u2003\u3000]/g, (c) => { count('punctuationAsciified', 1); return QUOTES[c]; });
  if (o.stripControl) text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff\ufffe\uffff]|\u00ad/g, () => { count('controlCharsRemoved', 1); return ''; });
  if (o.eol !== 'keep') {
    const crlf = (text.match(/\r\n/g) || []).length; const cr = (text.match(/\r(?!\n)/g) || []).length; const lf = (text.match(/(?<!\r)\n/g) || []).length;
    text = text.replace(/\r\n?/g, '\n');
    if (o.eol === 'crlf') { text = text.replace(/\n/g, '\r\n'); count('lineEndingsConverted', lf + cr); } else count('lineEndingsConverted', crlf + cr);
  }
  if (o.tabs > 0) text = text.replace(/\t/g, () => { count('tabsExpanded', 1); return ' '.repeat(o.tabs); });
  if (o.trimTrailing || o.collapseWhitespace) text = text.replace(/[ \t]+(?=\r?\n|$)/g, () => { count('trailingWhitespaceTrimmed', 1); return ''; });
  if (o.collapseWhitespace) {
    text = text.replace(/([^\s])[ \t]{2,}/g, (_, c) => { count('spaceRunsCollapsed', 1); return c + ' '; });
    text = text.replace(/(\r?\n){3,}/g, (m, nl) => { count('blankLineRunsCollapsed', 1); return nl + nl; });
  }
  if (o.finalNewline && text && !/\n$/.test(text)) { text += o.eol === 'crlf' ? '\r\n' : '\n'; count('finalNewlineAdded', 1); }
  return { text, changes };
}

// ─────────────────────────────────────────────────── extract / redact ──
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const isV6 = (s) => { if (!s.includes('::') && s.split(':').length !== 8) return false; try { new URL(`http://[${s}]/`); return true; } catch { return false; } };
const luhn = (digits) => { let sum = 0; let alt = false; for (let i = digits.length - 1; i >= 0; i--) { let d = digits.charCodeAt(i) - 48; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; } return sum % 10 === 0; };
export const FINDERS = {
  emails: { re: /[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63}){1,8}/g, fix: (s) => s.replace(/[.-]+$/, '') },
  urls: { re: /\b(?:https?|ftp):\/\/[^\s<>"'`\\^{}|]{2,2000}/gi, fix: (s) => { for (;;) { const t = s.replace(/[.,;:!?'*]+$/, ''); const last = t.at(-1); const open = last === ')' ? '(' : last === ']' ? '[' : null; if (open && t.split(last).length > t.split(open).length) { s = t.slice(0, -1); continue; } return t; } } },
  ips: { re: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w]|\.\d)|(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:[0-9A-Fa-f]{1,4}|:)?(?![\w:])/g, ok: (s) => (s.includes(':') ? isV6(s) : s.split('.').every((o) => +o <= 255 && (o === '0' || !o.startsWith('0')))) },
  dates: { re: new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:?\\d{2})?)?\\b|\\b\\d{1,2}[/.]\\d{1,2}[/.](?:\\d{4}|\\d{2})\\b|\\b(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?${MONTH}\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?\\d{4}\\b`, 'g') },
  hashes: { re: /\b(?:[a-fA-F0-9]{128}|[a-fA-F0-9]{64}|[a-fA-F0-9]{40}|[a-fA-F0-9]{32})\b/g, ok: (s) => /[a-fA-F]/.test(s) && /\d/.test(s) },
  uuids: { re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
  phones: { re: /(?<![\w.+-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d{2,4}(?:[ .-]\d{2,4}){1,4}(?![\w-]|\.\d)/g, ok: (s) => { const d = s.replace(/\D/g, ''); return d.length >= 7 && d.length <= 15 && !/^\d{4}-\d{2}-\d{2}$/.test(s) && !/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(s) && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(s); } },
  cards: { re: /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g, ok: (s) => luhn(s.replace(/\D/g, '')) },
  numbers: { re: /(?<![\w.,])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?%?(?![\w]|[.,]\d)/g },
};
export function findAll(text, kind) {
  const f = FINDERS[kind]; const out = []; let m; f.re.lastIndex = 0;
  while ((m = f.re.exec(text))) {
    if (!m[0]) { f.re.lastIndex++; continue; }
    const s = f.fix ? f.fix(m[0]) : m[0];
    if (s && (!f.ok || f.ok(s))) out.push({ index: m.index, value: s });
  }
  return out;
}

// ────────────────────────────────────────────────────── regex worker ──
// User regexes run in a Worker that is terminated after a deadline: the only reliable defence against catastrophic backtracking.
export function regexJobBody(job) {
  const re = new RegExp(job.source, job.flags);
  if (job.kind === 'replace') {
    let count = 0; re.lastIndex = 0;
    const text = job.text.replace(re, (...a) => { count++; return job.expand(a); });
    return { text, count };
  }
  if (job.kind === 'grep') {
    const matches = []; let total = 0; let filesWithMatches = 0; const perFile = [];
    for (const f of job.files) {
      const lines = f.text.split(/\r?\n/); let n = 0;
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i]; const long = line.length > job.maxLine; if (long) line = line.slice(0, job.maxLine);
        re.lastIndex = 0; const m = re.exec(line);
        if (!!m === !!job.invert) continue;
        n++; total++;
        if (matches.length < job.max) {
          const clip = (s) => (s.length > job.maxText ? s.slice(0, job.maxText) + '\u2026' : s);
          const e = { path: f.path, line: i + 1, text: clip(line) };
          if (m && !job.invert) { e.column = m.index + 1; e.match = clip(m[0]); if (m.length > 1) e.groups = m.slice(1, 10).map((g) => (g === undefined ? null : clip(g))); }
          if (job.context > 0) { e.before = lines.slice(Math.max(0, i - job.context), i).map(clip); e.after = lines.slice(i + 1, i + 1 + job.context).map(clip); }
          if (long) e.lineTruncated = true;
          matches.push(e);
        }
      }
      if (n) { filesWithMatches++; perFile.push({ path: f.path, count: n }); }
    }
    return { matches, total, filesWithMatches, perFile };
  }
  throw new Error('bad job');
}
const expandSrc = `(tpl) => (a) => { const groups = typeof a[a.length - 1] === 'object' && a[a.length - 1] !== null ? a.pop() : undefined; const input = a.pop(); const offset = a.pop(); const m = a;
  return tpl.replace(/\\$(\\$|&|\`|'|\\d{1,2}|<[^>]*>)/g, (all, k) => { if (k === '$') return '$'; if (k === '&') return m[0]; if (k === '\`') return input.slice(0, offset); if (k === "'") return input.slice(offset + m[0].length);
    if (k[0] === '<') return groups ? (groups[k.slice(1, -1)] ?? '') : all; let n = +k; if (n >= m.length && k.length === 2) { const n1 = +k[0]; return n1 >= 1 && n1 < m.length ? (m[n1] ?? '') + k[1] : all; } return n >= 1 && n < m.length ? (m[n] ?? '') : all; }); }`;
export function runRegexJob(job, timeoutMs) {
  const prep = (j) => { if (j.kind === 'replace') j.expand = j.literalReplacement ? (() => j.replacement) : (0, eval)(expandSrc)(j.replacement); return j; };
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return Promise.resolve({ ...regexJobBody(prep({ ...job })), guard: 'none (no Worker available)' });
  return new Promise((resolve, reject) => {
    const src = `const regexJobBody = ${regexJobBody.toString()}; const mk = ${expandSrc};
self.onmessage = (e) => { try { const j = e.data; if (j.kind === 'replace') j.expand = j.literalReplacement ? (() => j.replacement) : mk(j.replacement); self.postMessage({ ok: true, r: regexJobBody(j) }); } catch (err) { self.postMessage({ ok: false, error: String(err && err.message || err) }); } };`;
    let url; let w;
    try { url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); w = new Worker(url); } catch (e) {
      try { resolve({ ...regexJobBody(prep({ ...job })), guard: 'none (Worker blocked)' }); } catch (err) { reject(err); }
      return;
    }
    const done = () => { clearTimeout(timer); w.terminate(); URL.revokeObjectURL(url); };
    const timer = setTimeout(() => { done(); reject(new Error(`regex timed out after ${timeoutMs} ms and was killed \u2014 the pattern probably backtracks catastrophically on this input (nested quantifiers like (a+)+ or (.*)*). Simplify it, anchor it, or raise timeoutMs.`)); }, timeoutMs);
    w.onmessage = (e) => { done(); if (e.data.ok) resolve({ ...e.data.r, guard: 'worker' }); else reject(new Error(e.data.error)); };
    w.onerror = (e) => { done(); reject(new Error(`regex worker failed: ${e.message || 'unknown error'}`)); };
    w.postMessage(job);
  });
}
export function buildRegex(pattern, { flags = '', literal = false, ignoreCase = false, global = false } = {}) {
  if (typeof pattern !== 'string' || !pattern.length) throw new Error('pattern must be a non-empty string');
  if (pattern.length > 2000) throw new Error('pattern too long (max 2000 characters)');
  let fl = [...new Set((flags || '').replace(/[^imsuv]/g, ''))].join('');
  if (/[^gimsuvy]/.test(flags || '')) throw new Error(`bad regex flags "${flags}" \u2014 accepted: i m s u v (g is managed by the tool)`);
  if (ignoreCase && !fl.includes('i')) fl += 'i';
  if (global) fl += 'g';
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  try { new RegExp(source, fl); } catch (e) { throw new Error(`invalid regular expression: ${e.message} (JavaScript syntax; use literal=true to search for the exact text)`); }
  return { source, flags: fl };
}
