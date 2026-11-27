// μεταμόρφωσις :: rooms — the tools are split across pages so an agent only ever sees one family at a time.
// Each room is a real URL (<root>/<id>/). It exposes its own domains plus fs.* and sys.*; nothing else is
// listed or offered over WebMCP there. Files persist across rooms (IndexedDB), so work carries over.

export const ROOMS = [
  { id: 'image',    gr: 'εἰκών',     domains: ['image'],                           about: 'raster transforms and filters: convert, resize, crop, blur, edges, morphology, colour (WASM kernel, WebGPU when present)' },
  { id: 'analysis', gr: 'ἀνάλυσις',  domains: ['analysis'],                        about: 'image measurement and forensics: histogram, stats, palette, sharpness, SSIM/PSNR, perceptual hash, FFT, ELA, components, corners, lines, LSB' },
  { id: 'synth',    gr: 'τέχνη',     domains: ['synth', 'dither', 'gpu'],          about: 'synthetic images, dithering and the WebGPU playground: noise, fractals, automata, test cards, error diffusion, palettes, custom WGSL shaders' },
  { id: 'vision',   gr: 'ὅρασις',    domains: ['vision'],                          about: 'machine perception: OCR, barcodes and QR codes, neural image classification' },
  { id: 'pdf',      gr: 'βίβλος',    domains: ['pdf'],                             about: 'PDF: inspect, extract text, render pages, merge, split, rotate, compress, watermark, build from images or markdown' },
  { id: 'video',    gr: 'κίνησις',   domains: ['video'],                           about: 'video and containers: probe, convert, compress, trim, frames, contact sheets, GIF, audio extraction (WebCodecs, ffmpeg.wasm fallback)' },
  { id: 'audio',    gr: 'φωνή',      domains: ['audio'],                           about: 'audio: convert, edit, loudness and spectral stats, spectrogram and waveform images, pitch, tempo, signal synthesis, DTMF and Morse' },
  { id: 'geo',      gr: 'γῆ',        domains: ['geo'],                             about: 'maps: GeoJSON / KML / GPX / TopoJSON / WKT / shapefile conversion, simplify, measure, reproject, render to an image' },
  { id: 'data',     gr: 'ἀριθμός',   domains: ['data'],                            about: 'tables and structured data: CSV / JSON / YAML / TOML / XML / XLSX / Markdown conversion, query, stats, schema, diff, charts' },
  { id: 'bytes',    gr: 'στοιχεῖα',  domains: ['file', 'hash', 'encode', 'archive'], about: 'raw bytes: identify by magic number, entropy, strings, binary diff, hashes, encodings, zip / tar / gzip' },
  { id: 'doc',      gr: 'λόγος',     domains: ['doc', 'text'],                     about: 'documents and text: docx / pptx / epub / html / ipynb / eml to Markdown and back, subtitles, chunking, token estimates, grep, diff, redaction' },
  { id: 'claude',   gr: 'νοῦς',      domains: ['claude'],                          about: 'make any file model-ready: fit images, PDFs, audio, video, maps and tables to what a Claude model can ingest' },
];

// fs.* and sys.* are present in every room.
export const COMMON = ['fs', 'sys'];

// which module file (web/tools/<module>.js) registers a domain
export const DOMAIN_MODULE = {
  fs: 'fs', sys: 'fs',
  image: 'image', analysis: 'analysis', dither: 'dither', gpu: 'gpu', synth: 'synth', vision: 'vision',
  pdf: 'pdf', video: 'video', audio: 'audio', geo: 'geo',
  data: 'data', file: 'data', hash: 'data', encode: 'data', archive: 'data',
  doc: 'doc', text: 'doc', claude: 'claude',
};
export const ALL_MODULES = [...new Set(Object.values(DOMAIN_MODULE))];

export const roomOfDomain = (domain) => ROOMS.find((r) => r.domains.includes(domain))?.id || null;

/** Resolve the current page: which room, which domains are exposed, and the site root URL. */
export function locate() {
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content;
  const q = new URLSearchParams(location.search);
  const root = new URL(meta('mu-root') || './', location.href);
  const want = q.get('rooms') || meta('mu-room') || '';
  const all = want === 'all' || want === '*';
  const ids = all ? ROOMS.map((r) => r.id) : want.split(',').map((s) => s.trim()).filter((id) => ROOMS.some((r) => r.id === id));
  const domains = new Set(COMMON);
  for (const id of ids) for (const d of ROOMS.find((r) => r.id === id).domains) domains.add(d);
  return { id: all ? 'all' : ids.join(',') || 'hub', ids, all, domains, root: root.href, url: (id) => new URL(id ? `${id}/` : './', root).href };
}
