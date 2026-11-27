// mind :: what is in the browser's model cache. Works on the page without loading the runtime: Transformers.js stores
// every Hub file in the Cache API bucket CACHE_NAME under its download URL (https://huggingface.co/<org>/<name>/resolve/<rev>/<file>).
import { CACHE_NAME, HUB, CATALOG } from './catalog.js';

export const cacheAvailable = () => typeof caches !== 'undefined';

const parse = (url) => {
  const m = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(url);
  return m ? { repo: m[1], revision: decodeURIComponent(m[2]), file: m[3] } : null;
};

/** → [{ url, repo, file, bytes }] for every cached model file (empty when the Cache API is unavailable). */
export async function entries() {
  if (!cacheAvailable()) return [];
  let cache; try { if (!(await caches.has(CACHE_NAME))) return []; cache = await caches.open(CACHE_NAME); } catch { return []; }
  const out = [];
  for (const req of await cache.keys()) {
    const p = parse(req.url); if (!p) continue;
    const res = await cache.match(req); if (!res) continue;
    let bytes = Number(res.headers.get('content-length'));
    if (!Number.isFinite(bytes) || bytes <= 0) { try { bytes = (await res.blob()).size; } catch { bytes = 0; } }
    out.push({ url: req.url, ...p, bytes });
  }
  return out;
}

const quantOf = (file) => { const m = /^onnx\/.*?(?:_(fp16|quantized|int8|uint8|q4f16|q4|bnb4))?\.onnx(_data.*)?$/.exec(file); return m ? (m[1] === 'quantized' ? 'q8' : m[1] || 'fp32') : null; };

/** → [{ repo, id, task, files, bytes, weights: ['onnx/…'], quantisations: [...] }] */
export async function byRepo() {
  const map = new Map();
  for (const e of await entries()) {
    let r = map.get(e.repo);
    if (!r) { const c = CATALOG.find((m) => m.repo === e.repo || m.wordRepo === e.repo); map.set(e.repo, r = { repo: e.repo, id: c ? (c.repo === e.repo ? c.id : `${c.id} (word-timestamp export)`) : null, task: c?.task || null, files: 0, bytes: 0, weights: [], quantisations: new Set() }); }
    r.files++; r.bytes += e.bytes;
    const q = quantOf(e.file); if (q) { r.weights.push(e.file); r.quantisations.add(q); }
  }
  return [...map.values()].map((r) => ({ ...r, quantisations: [...r.quantisations] }));
}

/** Are all of these weight files of a repo cached? → true | false | 'partial' */
export async function has(repo, files) {
  if (!cacheAvailable()) return false;
  try {
    if (!(await caches.has(CACHE_NAME))) return false;
    const cache = await caches.open(CACHE_NAME); let n = 0;
    for (const f of files) if (await cache.match(`${HUB}${repo}/resolve/main/${f}`)) n++;
    return n === files.length ? true : n ? 'partial' : false;
  } catch { return false; }
}

/** Delete every cached file of a repo (all quantisations, all revisions). → { repo, files, bytes } */
export async function removeRepo(repo) {
  const mine = (await entries()).filter((e) => e.repo.toLowerCase() === repo.toLowerCase());
  let files = 0, bytes = 0;
  if (mine.length) {
    const cache = await caches.open(CACHE_NAME);
    for (const e of mine) if (await cache.delete(e.url)) { files++; bytes += e.bytes; }
  }
  return { repo, files, bytes };
}

/** Origin storage numbers: usage/quota cover everything this origin stores (model cache + the VFS in IndexedDB). */
export async function storage() {
  const out = { usageBytes: null, quotaBytes: null, freeBytes: null, persistent: null };
  try {
    const e = await navigator.storage?.estimate?.();
    if (e) { out.usageBytes = e.usage ?? null; out.quotaBytes = e.quota ?? null; out.freeBytes = e.quota != null && e.usage != null ? e.quota - e.usage : null; }
    if (navigator.storage?.persisted) out.persistent = await navigator.storage.persisted();
  } catch { /* storage manager blocked */ }
  return out;
}

/**
 * Ask the browser not to evict this origin's storage under disk pressure. Chromium decides silently and at once; Firefox
 * shows a permission prompt and leaves the promise pending until the user answers — so never wait for it for long.
 * → true | false | 'pending' (prompt still open) | null (API missing)
 */
export async function requestPersistence(waitMs = 400) {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted?.()) return true;
    const asked = navigator.storage.persist().catch(() => false);
    return await Promise.race([asked, new Promise((r) => setTimeout(() => r('pending'), waitMs))]);
  } catch { return null; }
}
