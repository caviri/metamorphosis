// Subtitles: SRT / WebVTT parse + serialise, transcripts. Pure functions.

const toMs = (h, m, s, ms) => ((+h || 0) * 3600 + (+m || 0) * 60 + (+s || 0)) * 1000 + +(String(ms || '0').padEnd(3, '0').slice(0, 3));
const TIME = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const CUE = new RegExp(`^\\s*${TIME.source}\\s*-->\\s*${TIME.source}(.*)$`);
export function fmtTime(ms, sep = ',', short = false) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000); const m = Math.floor(ms / 60000) % 60; const s = Math.floor(ms / 1000) % 60; const f = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  if (short) return `${h ? `${p(h)}:` : ''}${p(m)}:${p(s)}`;
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}
export function sniffSubs(text) {
  const head = text.replace(/^\ufeff/, '').slice(0, 2000);
  if (/^WEBVTT(?:[ \t\r\n]|$)/.test(head)) return 'vtt';
  if (/^\s*\d+\s*\r?\n\s*\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head) || /^\s*\d{1,3}:\d{2}:\d{2},\d{1,3}\s*-->/.test(head)) return 'srt';
  return null;
}
/** \u2192 {format, cues:[{start,end,text,id?,settings?}], header?, notes, skipped} \u2014 times in ms; text keeps inline tags */
export function parseSubs(text) {
  text = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const format = /^WEBVTT/.test(text) ? 'vtt' : 'srt';
  const blocks = text.split(/\n{2,}/); const cues = []; let skipped = 0; let notes = 0; let header = null;
  for (let bi = 0; bi < blocks.length; bi++) {
    const lines = blocks[bi].split('\n').filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1));
    if (!lines.length) continue;
    if (format === 'vtt' && bi === 0 && /^WEBVTT/.test(lines[0])) { header = lines.join('\n'); continue; }
    if (format === 'vtt' && /^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) { notes++; continue; }
    let ti = lines.findIndex((l) => l.includes('-->'));
    const m = ti >= 0 ? CUE.exec(lines[ti]) : null;
    if (!m) { if (lines.some((l) => l.trim())) skipped++; continue; }
    const cue = { start: toMs(m[1], m[2], m[3], m[4]), end: toMs(m[5], m[6], m[7], m[8]), text: lines.slice(ti + 1).join('\n').trim() };
    if (ti > 0 && lines[ti - 1].trim()) cue.id = lines[ti - 1].trim();
    if (m[9] && m[9].trim()) cue.settings = m[9].trim();
    cues.push(cue);
  }
  return { format, cues, header, notes, skipped };
}
export const stripTags = (s) => s.replace(/<\/?(?:[a-zA-Z][^>]*|\d{1,3}:\d{2}(?::\d{2})?[.,]\d{1,3})>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&lrm;|&rlm;/g, '');
export function retime(cues, { shiftMs = 0, scale = 1 }) {
  let dropped = 0; const out = [];
  for (const c of cues) {
    const start = c.start * scale + shiftMs; const end = c.end * scale + shiftMs;
    if (end <= 0) { dropped++; continue; }
    out.push({ ...c, start: Math.max(0, Math.round(start)), end: Math.round(end) });
  }
  return { cues: out, dropped };
}
export function toSrt(cues, { strip = false } = {}) {
  return cues.map((c, i) => `${i + 1}\n${fmtTime(c.start, ',')} --> ${fmtTime(c.end, ',')}\n${(strip ? stripTags(c.text) : c.text.replace(/<\/?(?:c|v|lang|ruby|rt)(?:[.\s][^>]*)?>/g, '')).replace(/\n{2,}/g, '\n')}\n`).join('\n');
}
export function toVtt(cues, { strip = false, header = null } = {}) {
  const body = cues.map((c) => `${c.id && !/^\d+$/.test(c.id) ? c.id + '\n' : ''}${fmtTime(c.start, '.')} --> ${fmtTime(c.end, '.')}${c.settings ? ' ' + c.settings : ''}\n${(strip ? stripTags(c.text) : c.text.replace(/\{\\[^}]*\}/g, '')).replace(/\n{2,}/g, '\n')}\n`).join('\n');
  return `${header && /^WEBVTT/.test(header) ? header.split('\n')[0] : 'WEBVTT'}\n\n${body}`;
}
/**
 * Plain reading text. timestamps: 'keep' (one line per cue with its time range), 'collapse' (cues merged into paragraphs, one
 * [hh:mm:ss] stamp per paragraph), 'none' (paragraphs only). Rolling duplicate lines (auto-captions) are removed.
 */
export function toTranscript(cues, { timestamps = 'collapse', gapMs = 2500, maxChars = 700, markdown = false } = {}) {
  const clean = []; let lastLine = '';
  for (const c of cues) {
    const lines = stripTags(c.text).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).filter((l) => { if (l === lastLine) return false; lastLine = l; return true; });
    if (lines.length) clean.push({ start: c.start, end: c.end, text: lines.join(' ') });
  }
  const stamp = (t) => (markdown ? `**[${t}]**` : `[${t}]`);
  if (timestamps === 'keep') return clean.map((c) => `${stamp(`${fmtTime(c.start, '.')} \u2192 ${fmtTime(c.end, '.')}`)} ${c.text}`).join(markdown ? '\n\n' : '\n') + (clean.length ? '\n' : '');
  const paras = []; let cur = null;
  for (const c of clean) {
    if (!cur || c.start - cur.end > gapMs || (cur.text.length > maxChars && /[.!?\u3002\uff01\uff1f\u2026]["')\]]?$/.test(cur.text)) || cur.text.length > maxChars * 2) { cur = { start: c.start, end: c.end, text: c.text }; paras.push(cur); } else { cur.text += ' ' + c.text; cur.end = c.end; }
  }
  return paras.map((p) => (timestamps === 'none' ? p.text : `${stamp(fmtTime(p.start, '.', true))} ${p.text}`)).join('\n\n') + (paras.length ? '\n' : '');
}
