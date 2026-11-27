// data/magic — identify a file from its bytes (magic numbers + light structural checks), independent of its name.

const asc = (b, off, len) => { let s = ''; for (let i = off; i < Math.min(b.length, off + len); i++) s += String.fromCharCode(b[i]); return s; };
const at = (b, off, sig) => { if (off + sig.length > b.length) return false; for (let i = 0; i < sig.length; i++) { const c = typeof sig === 'string' ? sig.charCodeAt(i) : sig[i]; if (c !== null && b[off + i] !== c) return false; } return true; };
const u16 = (b, o, le = true) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
const u32 = (b, o, le = true) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
const R = (format, mime, exts, category, description, confidence = 0.95, details) => ({ format, mime, extensions: exts, category, description, confidence, ...(details ? { details } : {}) });

// simple fixed-offset signatures: [offset, bytes|string, format, mime, [exts], category, description, confidence]
const SIGS = [
  [0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'png', 'image/png', ['png', 'apng'], 'image', 'PNG image', 0.99],
  [0, [0xff, 0xd8, 0xff], 'jpeg', 'image/jpeg', ['jpg', 'jpeg', 'jfif'], 'image', 'JPEG image', 0.98],
  [0, 'GIF87a', 'gif', 'image/gif', ['gif'], 'image', 'GIF image (87a)', 0.99],
  [0, 'GIF89a', 'gif', 'image/gif', ['gif'], 'image', 'GIF image (89a)', 0.99],
  [0, [0x49, 0x49, 0x2a, 0x00], 'tiff', 'image/tiff', ['tif', 'tiff', 'dng', 'nef', 'arw', 'cr2'], 'image', 'TIFF image (little-endian; also the container of many camera RAW formats)', 0.9],
  [0, [0x4d, 0x4d, 0x00, 0x2a], 'tiff', 'image/tiff', ['tif', 'tiff', 'dng', 'nef'], 'image', 'TIFF image (big-endian)', 0.9],
  [0, [0x49, 0x49, 0x2b, 0x00], 'bigtiff', 'image/tiff', ['tif', 'tiff'], 'image', 'BigTIFF image', 0.9],
  [0, '8BPS', 'psd', 'image/vnd.adobe.photoshop', ['psd', 'psb'], 'image', 'Adobe Photoshop document', 0.97],
  [0, [0x00, 0x00, 0x01, 0x00], 'ico', 'image/x-icon', ['ico'], 'image', 'Windows icon', 0.6],
  [0, [0x00, 0x00, 0x02, 0x00], 'cur', 'image/x-icon', ['cur'], 'image', 'Windows cursor', 0.5],
  [0, [0xff, 0x0a], 'jxl', 'image/jxl', ['jxl'], 'image', 'JPEG XL codestream', 0.7],
  [0, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a], 'jxl', 'image/jxl', ['jxl'], 'image', 'JPEG XL container', 0.99],
  [0, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a], 'jp2', 'image/jp2', ['jp2', 'jpx', 'j2k'], 'image', 'JPEG 2000', 0.99],
  [0, [0x76, 0x2f, 0x31, 0x01], 'exr', 'image/x-exr', ['exr'], 'image', 'OpenEXR image', 0.97],
  [0, '#?RADIANCE', 'hdr', 'image/vnd.radiance', ['hdr'], 'image', 'Radiance HDR image', 0.97],
  [0, 'qoif', 'qoi', 'image/qoi', ['qoi'], 'image', 'QOI image', 0.9],
  [0, 'DDS ', 'dds', 'image/vnd-ms.dds', ['dds'], 'image', 'DirectDraw surface', 0.95],
  [0, 'BPG\xfb', 'bpg', 'image/bpg', ['bpg'], 'image', 'BPG image', 0.95],
  [0, '%PDF-', 'pdf', 'application/pdf', ['pdf'], 'document', 'PDF document', 0.99],
  [0, '%!PS', 'ps', 'application/postscript', ['ps', 'eps', 'ai'], 'document', 'PostScript', 0.95],
  [0, '{\\rtf', 'rtf', 'application/rtf', ['rtf'], 'document', 'Rich Text Format', 0.97],
  [0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 'ole2', 'application/x-ole-storage', ['doc', 'xls', 'ppt', 'msi', 'msg'], 'document', 'OLE2 compound file (legacy Word/Excel/PowerPoint, MSI, Outlook MSG)', 0.95],
  [0, 'AT&TFORM', 'djvu', 'image/vnd.djvu', ['djvu', 'djv'], 'document', 'DjVu document', 0.97],
  [0, 'ID3', 'mp3', 'audio/mpeg', ['mp3'], 'audio', 'MP3 audio (ID3v2 tag)', 0.95],
  [0, 'fLaC', 'flac', 'audio/flac', ['flac'], 'audio', 'FLAC audio', 0.99],
  [0, 'MThd', 'midi', 'audio/midi', ['mid', 'midi'], 'audio', 'Standard MIDI file', 0.99],
  [0, '#!AMR', 'amr', 'audio/amr', ['amr'], 'audio', 'AMR audio', 0.97],
  [0, 'wvpk', 'wavpack', 'audio/x-wavpack', ['wv'], 'audio', 'WavPack audio', 0.95],
  [0, 'FORM', 'iff', 'application/x-iff', ['aiff', 'aif', 'iff'], 'audio', 'IFF container (AIFF audio if the form type is AIFF/AIFC)', 0.8],
  [0, 'FLV\x01', 'flv', 'video/x-flv', ['flv'], 'video', 'Flash video', 0.98],
  [0, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11], 'asf', 'video/x-ms-asf', ['wmv', 'wma', 'asf'], 'video', 'ASF container (WMV/WMA)', 0.97],
  [0, [0x00, 0x00, 0x01, 0xba], 'mpeg-ps', 'video/mpeg', ['mpg', 'mpeg', 'vob'], 'video', 'MPEG program stream', 0.9],
  [0, [0x00, 0x00, 0x01, 0xb3], 'mpeg-video', 'video/mpeg', ['mpg', 'mpeg', 'm2v'], 'video', 'MPEG video elementary stream', 0.85],
  [0, [0x1f, 0x8b, 0x08], 'gzip', 'application/gzip', ['gz', 'tgz', 'svgz'], 'archive', 'gzip compressed data', 0.98],
  [0, 'BZh', 'bzip2', 'application/x-bzip2', ['bz2', 'tbz2'], 'archive', 'bzip2 compressed data', 0.9],
  [0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], 'xz', 'application/x-xz', ['xz', 'txz'], 'archive', 'xz compressed data', 0.99],
  [0, [0x28, 0xb5, 0x2f, 0xfd], 'zstd', 'application/zstd', ['zst'], 'archive', 'Zstandard compressed data', 0.97],
  [0, [0x04, 0x22, 0x4d, 0x18], 'lz4', 'application/x-lz4', ['lz4'], 'archive', 'LZ4 frame', 0.97],
  [0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], '7z', 'application/x-7z-compressed', ['7z'], 'archive', '7-Zip archive', 0.99],
  [0, 'Rar!\x1a\x07\x00', 'rar', 'application/vnd.rar', ['rar'], 'archive', 'RAR archive (v1.5–4)', 0.99],
  [0, 'Rar!\x1a\x07\x01\x00', 'rar', 'application/vnd.rar', ['rar'], 'archive', 'RAR archive (v5)', 0.99],
  [0, 'MSCF', 'cab', 'application/vnd.ms-cab-compressed', ['cab'], 'archive', 'Microsoft Cabinet archive', 0.97],
  [0, '!<arch>\n', 'ar', 'application/x-archive', ['a', 'deb', 'lib'], 'archive', 'ar archive (static library or .deb package)', 0.97],
  [0, [0xed, 0xab, 0xee, 0xdb], 'rpm', 'application/x-rpm', ['rpm'], 'archive', 'RPM package', 0.97],
  [0, 'xar!', 'xar', 'application/x-xar', ['xar', 'pkg'], 'archive', 'XAR archive', 0.95],
  [0, [0x1f, 0x9d], 'compress', 'application/x-compress', ['z'], 'archive', 'Unix compress (LZW) data', 0.6],
  [0, [0x5d, 0x00, 0x00], 'lzma', 'application/x-lzma', ['lzma'], 'archive', 'LZMA-alone data', 0.4],
  [257, 'ustar', 'tar', 'application/x-tar', ['tar'], 'archive', 'tar archive (ustar)', 0.98],
  [0x8001, 'CD001', 'iso', 'application/x-iso9660-image', ['iso'], 'archive', 'ISO 9660 disc image', 0.98],
  [0, 'SQLite format 3\x00', 'sqlite', 'application/vnd.sqlite3', ['sqlite', 'db', 'sqlite3'], 'data', 'SQLite 3 database', 0.99],
  [0, 'PAR1', 'parquet', 'application/vnd.apache.parquet', ['parquet'], 'data', 'Apache Parquet', 0.95],
  [0, 'ARROW1', 'arrow', 'application/vnd.apache.arrow.file', ['arrow', 'feather'], 'data', 'Apache Arrow IPC file', 0.97],
  [0, 'Obj\x01', 'avro', 'application/avro', ['avro'], 'data', 'Apache Avro container', 0.95],
  [0, [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a], 'hdf5', 'application/x-hdf5', ['h5', 'hdf5', 'nc'], 'data', 'HDF5 data', 0.99],
  [0, [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59], 'npy', 'application/x-npy', ['npy'], 'data', 'NumPy array', 0.99],
  [0, 'GGUF', 'gguf', 'application/octet-stream', ['gguf'], 'data', 'GGUF model file', 0.95],
  [0, [0x7f, 0x45, 0x4c, 0x46], 'elf', 'application/x-elf', ['elf', 'so', 'o', ''], 'executable', 'ELF executable / shared object', 0.99],
  [0, [0xfe, 0xed, 0xfa, 0xce], 'macho', 'application/x-mach-binary', ['', 'dylib', 'o'], 'executable', 'Mach-O binary (32-bit, big-endian)', 0.97],
  [0, [0xce, 0xfa, 0xed, 0xfe], 'macho', 'application/x-mach-binary', ['', 'dylib', 'o'], 'executable', 'Mach-O binary (32-bit)', 0.97],
  [0, [0xcf, 0xfa, 0xed, 0xfe], 'macho', 'application/x-mach-binary', ['', 'dylib', 'o'], 'executable', 'Mach-O binary (64-bit)', 0.97],
  [0, [0x00, 0x61, 0x73, 0x6d], 'wasm', 'application/wasm', ['wasm'], 'executable', 'WebAssembly binary module', 0.99],
  [0, 'dex\n', 'dex', 'application/x-dex', ['dex'], 'executable', 'Android Dalvik executable', 0.97],
  [0, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00], 'lnk', 'application/x-ms-shortcut', ['lnk'], 'executable', 'Windows shortcut', 0.97],
  [0, [0x1b, 0x4c, 0x75, 0x61], 'luac', 'application/x-lua-bytecode', ['luac'], 'executable', 'Lua bytecode', 0.95],
  [0, 'wOFF', 'woff', 'font/woff', ['woff'], 'font', 'WOFF font', 0.99],
  [0, 'wOF2', 'woff2', 'font/woff2', ['woff2'], 'font', 'WOFF2 font', 0.99],
  [0, 'OTTO', 'otf', 'font/otf', ['otf'], 'font', 'OpenType font (CFF outlines)', 0.98],
  [0, [0x00, 0x01, 0x00, 0x00, 0x00], 'ttf', 'font/ttf', ['ttf'], 'font', 'TrueType font', 0.85],
  [0, 'ttcf', 'ttc', 'font/collection', ['ttc', 'otc'], 'font', 'TrueType/OpenType collection', 0.97],
  [34, [0x4c, 0x50], 'eot', 'application/vnd.ms-fontobject', ['eot'], 'font', 'Embedded OpenType font', 0.5],
  [0, 'glTF', 'glb', 'model/gltf-binary', ['glb'], 'model', 'glTF binary model', 0.98],
  [0, 'ply\n', 'ply', 'model/ply', ['ply'], 'model', 'PLY 3D model', 0.9],
  [0, 'Kaydara FBX Binary', 'fbx', 'application/octet-stream', ['fbx'], 'model', 'Autodesk FBX (binary)', 0.98],
  [0, 'BLENDER', 'blend', 'application/x-blender', ['blend'], 'model', 'Blender file', 0.97],
  [0, [0xd4, 0xc3, 0xb2, 0xa1], 'pcap', 'application/vnd.tcpdump.pcap', ['pcap'], 'data', 'pcap capture (little-endian)', 0.95],
  [0, [0xa1, 0xb2, 0xc3, 0xd4], 'pcap', 'application/vnd.tcpdump.pcap', ['pcap'], 'data', 'pcap capture (big-endian)', 0.95],
  [0, [0x0a, 0x0d, 0x0d, 0x0a], 'pcapng', 'application/x-pcapng', ['pcapng'], 'data', 'pcapng capture', 0.9],
  [0, '-----BEGIN ', 'pem', 'application/x-pem-file', ['pem', 'crt', 'key', 'cer', 'pub', 'asc'], 'text', 'PEM-armoured key/certificate', 0.95],
  [0, 'ssh-rsa ', 'ssh-key', 'text/plain', ['pub'], 'text', 'OpenSSH public key', 0.9],
  [0, 'ssh-ed25519 ', 'ssh-key', 'text/plain', ['pub'], 'text', 'OpenSSH public key', 0.9],
  [0, 'BEGIN:VCARD', 'vcard', 'text/vcard', ['vcf'], 'text', 'vCard', 0.95],
  [0, 'BEGIN:VCALENDAR', 'ical', 'text/calendar', ['ics'], 'text', 'iCalendar', 0.95],
  [0, 'WEBVTT', 'vtt', 'text/vtt', ['vtt'], 'text', 'WebVTT subtitles', 0.95],
  [0, 'd8:announce', 'torrent', 'application/x-bittorrent', ['torrent'], 'data', 'BitTorrent metainfo', 0.95],
  [0, [0x78, 0x01], 'zlib', 'application/zlib', ['zlib', 'zz'], 'archive', 'zlib stream (no/low compression)', 0.35],
  [0, [0x78, 0x9c], 'zlib', 'application/zlib', ['zlib', 'zz'], 'archive', 'zlib stream (default compression)', 0.4],
  [0, [0x78, 0xda], 'zlib', 'application/zlib', ['zlib', 'zz'], 'archive', 'zlib stream (best compression)', 0.4],
];

function zipKind(b) {
  // peek at the first local file names (up to ~40 entries / 64 KiB)
  const names = []; let p = 0; const lim = Math.min(b.length, 262144);
  let mimetype = null;
  while (p + 30 <= lim && at(b, p, [0x50, 0x4b, 0x03, 0x04]) && names.length < 60) {
    const flags = u16(b, p + 6); const csize = u32(b, p + 18); const nl = u16(b, p + 26); const el = u16(b, p + 28);
    const name = new TextDecoder().decode(b.subarray(p + 30, Math.min(b.length, p + 30 + nl))); names.push(name);
    if (name === 'mimetype' && u16(b, p + 8) === 0) mimetype = asc(b, p + 30 + nl + el, Math.min(csize, 80));
    if (flags & 8) break; // sizes unknown (data descriptor) — stop walking
    p += 30 + nl + el + csize;
  }
  const has = (re) => names.some((n) => re.test(n));
  const Z = (f, m, e, c, d) => R(f, m, e, c, d, 0.93, { firstEntries: names.slice(0, 5) });
  if (mimetype === 'application/epub+zip') return Z('epub', 'application/epub+zip', ['epub'], 'document', 'EPUB e-book (zip)');
  if (mimetype && mimetype.startsWith('application/vnd.oasis.opendocument.')) { const k = mimetype.split('.').pop(); const e = { text: 'odt', spreadsheet: 'ods', presentation: 'odp', graphics: 'odg' }[k] || 'odt'; return Z(e, mimetype, [e], 'document', `OpenDocument ${k} (zip)`); }
  if (has(/^word\//)) return Z('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['docx', 'docm', 'dotx'], 'document', 'Word document (OOXML zip)');
  if (has(/^xl\//)) return Z('xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['xlsx', 'xlsm', 'xltx'], 'document', 'Excel workbook (OOXML zip)');
  if (has(/^ppt\//)) return Z('pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ['pptx', 'pptm', 'ppsx'], 'document', 'PowerPoint presentation (OOXML zip)');
  if (has(/^\[Content_Types\]\.xml$/)) return Z('ooxml', 'application/zip', ['docx', 'xlsx', 'pptx', 'vsdx', 'nupkg', 'xps'], 'document', 'Open Packaging Conventions zip (Office document or similar; main part not seen in the first entries)');
  if (has(/^AndroidManifest\.xml$/) || has(/^classes\.dex$/)) return Z('apk', 'application/vnd.android.package-archive', ['apk'], 'archive', 'Android package (zip)');
  if (has(/^META-INF\/MANIFEST\.MF$/) || has(/\.class$/)) return Z('jar', 'application/java-archive', ['jar', 'war', 'ear'], 'archive', 'Java archive (zip)');
  if (has(/^doc\.kml$/)) return Z('kmz', 'application/vnd.google-earth.kmz', ['kmz'], 'archive', 'KMZ (zipped KML)');
  if (has(/\.dist-info\//)) return Z('wheel', 'application/zip', ['whl'], 'archive', 'Python wheel (zip)');
  return R('zip', 'application/zip', ['zip'], 'archive', 'ZIP archive', 0.97, { firstEntries: names.slice(0, 5) });
}

function textKind(b) {
  // decide whether this is text, and which kind
  let bom = null; let text; const head = b.subarray(0, Math.min(b.length, 65536));
  if (at(b, 0, [0xef, 0xbb, 0xbf])) { bom = 'UTF-8'; text = new TextDecoder().decode(head.subarray(3)); } else if (at(b, 0, [0xff, 0xfe]) && !at(b, 0, [0xff, 0xfe, 0, 0])) { bom = 'UTF-16LE'; text = new TextDecoder('utf-16le').decode(head.subarray(2)); } else if (at(b, 0, [0xfe, 0xff])) { bom = 'UTF-16BE'; text = new TextDecoder('utf-16be').decode(head.subarray(2)); } else {
    let ctl = 0; for (let i = 0; i < head.length; i++) { const c = head[i]; if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27)) ctl++; }
    if (!head.length || ctl / head.length > 0.01) return null;
    let cut = head; if (head.length < b.length) { let e = head.length; while (e > 0 && (head[e - 1] & 0xc0) === 0x80) e--; if (e > 0 && head[e - 1] >= 0xc0) e--; cut = head.subarray(0, e); }
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(cut); } catch { text = null; }
    if (text === null) return R('text', 'text/plain', ['txt'], 'text', 'Text in a legacy 8-bit encoding (not valid UTF-8; probably windows-1252/latin1)', 0.5, { encoding: 'unknown-8bit' });
  }
  const enc = bom || (/[^\x00-\x7f]/.test(text) ? 'UTF-8' : 'ASCII'); const d = { encoding: enc, ...(bom ? { bom: true } : {}) };
  const t = text.trimStart(); const whole = head.length === b.length;
  const T = (f, m, e, desc, conf) => R(f, m, e, 'text', desc, conf, d);
  if (/^<\?xml/i.test(t) || /^<[A-Za-z!]/.test(t)) {
    if (/<svg[\s>]/i.test(t.slice(0, 4096))) return T('svg', 'image/svg+xml', ['svg'], 'SVG image (XML)', 0.95);
    if (/^<!doctype html/i.test(t) || /<html[\s>]/i.test(t.slice(0, 2048))) return T('html', 'text/html', ['html', 'htm', 'xhtml'], 'HTML document', 0.95);
    if (/<kml[\s>]/.test(t.slice(0, 2048))) return T('kml', 'application/vnd.google-earth.kml+xml', ['kml'], 'KML (XML)', 0.95);
    if (/<gpx[\s>]/.test(t.slice(0, 2048))) return T('gpx', 'application/gpx+xml', ['gpx'], 'GPX track (XML)', 0.95);
    if (/<plist[\s>]/.test(t.slice(0, 2048))) return T('plist', 'application/x-plist', ['plist'], 'Apple property list (XML)', 0.95);
    if (/<(rss|feed)[\s>]/.test(t.slice(0, 2048))) return T('feed', 'application/xml', ['xml', 'rss', 'atom'], 'RSS/Atom feed (XML)', 0.9);
    if (/^<\?xml/i.test(t)) return T('xml', 'application/xml', ['xml', 'xsd', 'xsl', 'xslt'], 'XML document', 0.95);
    if (/^<(head|body|div|p|table|span|script|style|h[1-6]|ul|a)[\s>]/i.test(t)) return T('html', 'text/html', ['html', 'htm'], 'HTML fragment', 0.7);
    if (/^<[A-Za-z][\w:.-]*[\s>/]/.test(t)) return T('xml', 'application/xml', ['xml'], 'XML-like markup (no declaration)', 0.6);
  }
  if (t.startsWith('#!')) { const line = t.split('\n')[0]; const m = /(python|node|bash|sh|zsh|perl|ruby|php|lua|deno|pwsh)/.exec(line); const e = { python: 'py', node: 'js', bash: 'sh', sh: 'sh', zsh: 'sh', perl: 'pl', ruby: 'rb', php: 'php', lua: 'lua', deno: 'ts', pwsh: 'ps1' }[m?.[1]] || 'sh'; return R('script', 'text/x-script', [e, ''], 'text', `Script with shebang (${line.slice(0, 60)})`, 0.9, d); }
  if (t.startsWith('{') || t.startsWith('[')) {
    if (whole) { try { JSON.parse(text); const geo = /"type"\s*:\s*"(FeatureCollection|Feature)"/.test(t.slice(0, 4096)); return geo ? T('geojson', 'application/geo+json', ['geojson', 'json'], 'GeoJSON', 0.95) : T('json', 'application/json', ['json', 'geojson', 'topojson', 'ipynb', 'map', 'har'], 'JSON document', 0.97); } catch { /* fallthrough */ } }
    const lines = t.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
    if (lines.length > 1 && lines.slice(0, -1).every((l) => { try { JSON.parse(l); return true; } catch { return false; } })) return T('jsonl', 'application/x-ndjson', ['jsonl', 'ndjson'], 'JSON Lines', 0.9);
    if (!whole && t.startsWith('{')) return T('json', 'application/json', ['json', 'geojson', 'ipynb'], 'JSON document (only the head was checked)', 0.6);
    if (/^\[[\w.\-" ]+\]\s*$/m.test(lines[0] || '') && /^\s*[\w."-]+\s*=/.test(lines[1] || '')) return T('toml', 'application/toml', ['toml', 'ini', 'cfg'], 'TOML/INI configuration', 0.7);
  }
  if (/^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3} --> /.test(t)) return T('srt', 'application/x-subrip', ['srt'], 'SubRip subtitles', 0.95);
  if (/^%YAML|^---\s*$/m.test(t.slice(0, 200)) && /^[\w"'-]+:\s/m.test(t)) return T('yaml', 'application/yaml', ['yaml', 'yml', 'md'], 'YAML document', 0.7);
  if (/^(# |## |\* |- \[)/m.test(t.slice(0, 2000)) && /\[[^\]]+\]\([^)]+\)|^#{1,6} /m.test(t.slice(0, 8000))) return T('markdown', 'text/markdown', ['md', 'markdown', 'txt'], 'Markdown text', 0.55);
  const ls = t.split(/\r?\n/).filter((l) => l.length).slice(0, 12);
  if (ls.length >= 2) for (const [dl, f, m, e] of [['\t', 'tsv', 'text/tab-separated-values', ['tsv', 'tab', 'txt']], [',', 'csv', 'text/csv', ['csv', 'txt']], [';', 'csv', 'text/csv', ['csv', 'txt']]]) {
    const counts = ls.slice(0, -1).map((l) => l.split(dl).length - 1);
    if (counts[0] >= 1 && counts.every((c) => c === counts[0])) return T(f, m, e, `Delimiter-separated values (${dl === '\t' ? 'tab' : dl}, ${counts[0] + 1} columns)`, 0.75);
  }
  return R('text', 'text/plain', ['txt', 'log', 'md', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'js', 'mjs', 'ts', 'py', 'c', 'h', 'cpp', 'rs', 'go', 'java', 'css', 'sh', 'sql', 'tex', 'wkt', 'srt'], 'text', `Plain text (${enc})`, 0.7, d);
}

/** identify(bytes) → {format, mime, extensions, category, description, confidence, details?} */
export function identify(b) {
  if (!b.length) return R('empty', 'application/x-empty', [], 'empty', 'Empty file (0 bytes)', 1);
  // text with a byte-order mark first (FF FE would otherwise look like an MPEG audio frame sync)
  if (at(b, 0, [0xef, 0xbb, 0xbf]) || ((at(b, 0, [0xff, 0xfe]) || at(b, 0, [0xfe, 0xff])) && b.length >= 4 && b.length % 2 === 0)) { const t = textKind(b); if (t && !/[\u0000-\u0008\u000e-\u001f]/.test(new TextDecoder(at(b, 0, [0xef]) ? 'utf-8' : at(b, 0, [0xff]) ? 'utf-16le' : 'utf-16be').decode(b.subarray(0, 512)).slice(1))) return t; }
  // containers needing a closer look first
  if (at(b, 0, 'RIFF') || at(b, 0, 'RIFX')) {
    const k = asc(b, 8, 4);
    if (k === 'WAVE') return R('wav', 'audio/wav', ['wav'], 'audio', 'WAVE audio (RIFF)', 0.99);
    if (k === 'AVI ') return R('avi', 'video/x-msvideo', ['avi'], 'video', 'AVI video (RIFF)', 0.99);
    if (k === 'WEBP') { const sub = asc(b, 12, 4); return R('webp', 'image/webp', ['webp'], 'image', 'WebP image (RIFF)', 0.99, { variant: sub === 'VP8 ' ? 'lossy' : sub === 'VP8L' ? 'lossless' : sub === 'VP8X' ? 'extended' : sub }); }
    if (k === 'sfbk') return R('sf2', 'audio/x-soundfont', ['sf2'], 'audio', 'SoundFont 2 (RIFF)', 0.97);
    if (k === 'ACON') return R('ani', 'application/x-navi-animation', ['ani'], 'image', 'Animated cursor (RIFF)', 0.97);
    return R('riff', 'application/x-riff', [], 'container', `RIFF container (form type "${k}")`, 0.8);
  }
  if (at(b, 0, 'FORM') && ['AIFF', 'AIFC'].includes(asc(b, 8, 4))) return R('aiff', 'audio/aiff', ['aiff', 'aif', 'aifc'], 'audio', 'AIFF audio', 0.99);
  if (at(b, 4, 'ftyp') && b.length >= 12) {
    const brand = asc(b, 8, 4); const size = u32(b, 0, false); const compat = []; for (let p = 16; p + 4 <= Math.min(size, b.length, 64); p += 4) compat.push(asc(b, p, 4));
    const all = [brand, ...compat].map((s) => s.trim()); const d = { brand: brand.trim(), compatible: compat.map((s) => s.trim()).filter(Boolean).slice(0, 8) };
    const hasB = (...xs) => xs.some((x) => all.includes(x));
    if (hasB('avif', 'avis')) return R('avif', 'image/avif', ['avif'], 'image', 'AVIF image (ISO BMFF)', 0.98, d);
    if (hasB('heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1')) return R('heic', 'image/heic', ['heic', 'heif'], 'image', 'HEIF/HEIC image (ISO BMFF)', 0.95, d);
    if (brand === 'qt  ') return R('mov', 'video/quicktime', ['mov', 'qt'], 'video', 'QuickTime movie', 0.98, d);
    if (/^M4A|^M4B|^M4P/.test(brand)) return R('m4a', 'audio/mp4', ['m4a', 'm4b', 'm4p'], 'audio', 'MPEG-4 audio (ISO BMFF)', 0.97, d);
    if (/^3g[p2]/.test(brand)) return R('3gp', 'video/3gpp', ['3gp', '3g2'], 'video', '3GPP media (ISO BMFF)', 0.97, d);
    if (brand === 'crx ') return R('cr3', 'image/x-canon-cr3', ['cr3'], 'image', 'Canon CR3 raw image', 0.97, d);
    return R('mp4', 'video/mp4', ['mp4', 'm4v', 'm4a', 'mov', 'f4v'], 'video', 'MPEG-4 / ISO base media file', 0.95, d);
  }
  if (b.length >= 12 && ['moov', 'mdat', 'free', 'wide', 'skip'].includes(asc(b, 4, 4))) return R('mov', 'video/quicktime', ['mov', 'mp4'], 'video', 'QuickTime/ISO media (no ftyp box)', 0.75);
  if (at(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    const head = asc(b, 0, 96);
    if (head.includes('webm')) return R('webm', 'video/webm', ['webm', 'weba'], 'video', 'WebM (Matroska/EBML)', 0.98);
    if (head.includes('matroska')) return R('mkv', 'video/x-matroska', ['mkv', 'mka', 'mks'], 'video', 'Matroska (EBML)', 0.98);
    return R('ebml', 'application/x-ebml', ['mkv', 'webm'], 'video', 'EBML container', 0.8);
  }
  if (at(b, 0, 'OggS')) {
    const h = asc(b, 28, 16);
    if (h.startsWith('OpusHead')) return R('opus', 'audio/ogg', ['opus', 'ogg'], 'audio', 'Ogg Opus audio', 0.98);
    if (h.startsWith('\x01vorbis')) return R('ogg', 'audio/ogg', ['ogg', 'oga'], 'audio', 'Ogg Vorbis audio', 0.98);
    if (h.startsWith('\x80theora')) return R('ogv', 'video/ogg', ['ogv', 'ogg'], 'video', 'Ogg Theora video', 0.98);
    if (h.startsWith('\x7fFLAC')) return R('oga', 'audio/ogg', ['oga', 'ogg'], 'audio', 'Ogg FLAC audio', 0.98);
    return R('ogg', 'application/ogg', ['ogg', 'ogx'], 'audio', 'Ogg container', 0.9);
  }
  if (at(b, 0, [0x50, 0x4b, 0x03, 0x04])) return zipKind(b);
  if (at(b, 0, [0x50, 0x4b, 0x05, 0x06])) return R('zip', 'application/zip', ['zip'], 'archive', 'ZIP archive (empty)', 0.97);
  if (at(b, 0, [0x50, 0x4b, 0x07, 0x08])) return R('zip', 'application/zip', ['zip'], 'archive', 'ZIP archive (spanned)', 0.9);
  if (at(b, 0, 'MZ')) {
    const pe = b.length >= 64 ? u32(b, 60) : 0;
    if (pe && pe + 24 < b.length && at(b, pe, [0x50, 0x45, 0, 0])) {
      const mach = u16(b, pe + 4); const chars = u16(b, pe + 22); const dll = !!(chars & 0x2000);
      const arch = { 0x14c: 'x86', 0x8664: 'x86-64', 0xaa64: 'ARM64', 0x1c0: 'ARM', 0x1c4: 'ARMv7' }[mach] || `machine 0x${mach.toString(16)}`;
      return R('pe', 'application/vnd.microsoft.portable-executable', dll ? ['dll', 'ocx', 'sys'] : ['exe', 'scr', 'sys', 'dll'], 'executable', `Windows PE ${dll ? 'DLL' : 'executable'} (${arch})`, 0.99, { arch, dll });
    }
    return R('mz', 'application/x-msdownload', ['exe', 'com'], 'executable', 'DOS MZ executable', 0.8);
  }
  if (at(b, 0, [0xca, 0xfe, 0xba, 0xbe]) && b.length >= 8) { const n = u32(b, 4, false); return n < 40 ? R('macho-fat', 'application/x-mach-binary', ['', 'dylib'], 'executable', `Mach-O universal binary (${n} architectures)`, 0.9) : R('class', 'application/java-vm', ['class'], 'executable', `Java class file (version ${u16(b, 6, false)})`, 0.95); }
  if (at(b, 0, 'BM') && b.length >= 26 && [12, 40, 52, 56, 64, 108, 124].includes(u32(b, 14))) return R('bmp', 'image/bmp', ['bmp', 'dib'], 'image', 'Windows bitmap', 0.97);
  if (/^P[1-6]\s/.test(asc(b, 0, 3))) { const k = b[1] - 48; const e = ['pbm', 'pgm', 'ppm'][(k - 1) % 3]; return R(e, `image/x-portable-${['bitmap', 'graymap', 'pixmap'][(k - 1) % 3]}`, [e, 'pnm'], 'image', `Netpbm ${e.toUpperCase()} image (${k > 3 ? 'binary' : 'ASCII'})`, 0.9); }
  if (at(b, 0, 'bplist0')) return R('bplist', 'application/x-plist', ['plist'], 'data', 'Apple binary property list', 0.98);
  if (at(b, 0, [0x25, 0x50, 0x44, 0x46]) === false && b.length > 1024) { const p = asc(b, 0, 1024).indexOf('%PDF-'); if (p > 0) return R('pdf', 'application/pdf', ['pdf'], 'document', `PDF document (header at offset ${p}, junk before it)`, 0.8); }
  for (const [off, sig, format, mime, exts, cat, desc, conf] of SIGS) if (at(b, off, sig)) {
    const details = {};
    if (format === 'png' && b.length >= 24) { details.width = u32(b, 16, false); details.height = u32(b, 20, false); }
    if (format === 'gif' && b.length >= 10) { details.width = u16(b, 6); details.height = u16(b, 8); }
    if (format === 'elf' && b.length >= 20) { const le = b[5] !== 2; details.bits = b[4] === 2 ? 64 : 32; details.endian = le ? 'little' : 'big'; const m = u16(b, 18, le); details.machine = { 3: 'x86', 62: 'x86-64', 40: 'ARM', 183: 'AArch64', 243: 'RISC-V', 8: 'MIPS' }[m] || m; details.type = { 1: 'relocatable', 2: 'executable', 3: 'shared/PIE', 4: 'core' }[u16(b, 16, le)] || 'unknown'; }
    if (format === 'wasm' && b.length >= 8) details.version = u32(b, 4);
    if (format === 'gzip' && b.length > 10 && (b[3] & 8)) { let e = 10; while (e < b.length && e < 266 && b[e]) e++; details.originalName = asc(b, 10, e - 10); }
    if (format === 'zlib' && ((b[0] << 8) | b[1]) % 31 !== 0) continue;
    if ((format === 'ico' || format === 'cur') && !(u16(b, 4) > 0 && u16(b, 4) < 256 && b.length >= 22 && b[9] === 0)) continue;
    if (format === 'lzma' && !(b.length > 13 && (b[4] === 0 || b[4] === 1 || b[4] === 2 || b[4] === 4 || b[4] === 8))) continue;
    if (format === 'jxl' && sig.length === 2 && b.length < 12) continue;
    return R(format, mime, exts, cat, desc, conf, Object.keys(details).length ? details : undefined);
  }
  // MPEG audio frame sync / ADTS / AC-3 / TS
  if (b.length > 4 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return R('aac', 'audio/aac', ['aac'], 'audio', 'AAC audio (ADTS)', 0.8);
  if (b.length > 4 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x18) !== 0x08 && (b[1] & 0x06) !== 0 && (b[2] & 0xf0) !== 0xf0 && (b[2] & 0x0c) !== 0x0c) { const layer = 4 - ((b[1] >> 1) & 3); return R('mp3', 'audio/mpeg', layer === 3 ? ['mp3'] : ['mp2', 'mp1', 'mp3'], 'audio', `MPEG audio (layer ${layer}, frame sync, no ID3 tag)`, 0.75); }
  if (b.length > 2 && b[0] === 0x0b && b[1] === 0x77) return R('ac3', 'audio/ac3', ['ac3'], 'audio', 'Dolby AC-3 audio', 0.8);
  if (b.length >= 376 && b[0] === 0x47 && b[188] === 0x47) return R('mpeg-ts', 'video/mp2t', ['ts', 'm2ts', 'mts'], 'video', 'MPEG transport stream', 0.85);
  if (b.length >= 512 && b[510] === 0x55 && b[511] === 0xaa && b.length % 512 === 0) return R('mbr', 'application/octet-stream', ['img', 'bin', 'vhd'], 'data', 'Disk image with an MBR boot signature', 0.5);
  // tar without the ustar magic (v7): header checksum check
  if (b.length >= 512) { let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[i]; const stored = parseInt(asc(b, 148, 8).replace(/[^0-7]/g, ''), 8); if (stored === sum && sum > 256) return R('tar', 'application/x-tar', ['tar'], 'archive', 'tar archive (v7, checksum-verified header)', 0.85); }
  const t = textKind(b);
  if (t) return t;
  // UTF-16 without BOM
  if (b.length >= 8) { let z0 = 0; let z1 = 0; const n = Math.min(b.length & ~1, 4096); for (let i = 0; i < n; i += 2) { if (b[i] === 0) z0++; if (b[i + 1] === 0) z1++; } if (z1 > n * 0.4 && z0 < n * 0.05) return R('text', 'text/plain', ['txt'], 'text', 'Text, probably UTF-16LE without BOM', 0.6, { encoding: 'UTF-16LE' }); if (z0 > n * 0.4 && z1 < n * 0.05) return R('text', 'text/plain', ['txt'], 'text', 'Text, probably UTF-16BE without BOM', 0.6, { encoding: 'UTF-16BE' }); }
  return R('unknown', 'application/octet-stream', [], 'unknown', 'Unrecognised binary data', 0);
}

/** extensions that are just another name for the detected content (containers etc.) */
export const EXT_OK = { svgz: 'gzip', tgz: 'gzip', apk: 'jar', xpi: 'zip', crx: 'zip', cbz: 'zip', ipa: 'zip', nupkg: 'ooxml', vsix: 'ooxml', docm: 'docx', xlsm: 'xlsx', pptm: 'pptx', ogg: 'opus', oga: 'ogg', deb: 'ar', webmanifest: 'json', har: 'json', ipynb: 'json', topojson: 'json', geojson: 'json', bin: '*', dat: '*', tmp: '*', bak: '*', part: '*' };
