// μεταμόρφωσις :: img — shared raster helpers. An "img" is {width, height, data: Uint8ClampedArray} (RGBA, row-major, 8-bit).
import { vfs } from './core.js';

export const MIME_OF = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export function canvasOf(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas'); c.width = width; c.height = height; return c;
}

/** decode(pathOrBytes, {maxSide?}) → img. Anything the browser can decode: png jpeg webp gif(first frame) bmp avif svg ico. */
export async function decode(src, opts = {}) {
  let blob;
  if (typeof src === 'string') blob = vfs.blob(src);
  else if (src instanceof Blob) blob = src;
  else blob = new Blob([src]);
  let bmp;
  try { bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); } catch {
    try { bmp = await createImageBitmap(blob); } catch {
      // SVG (and a few exotic types) need the <img> path
      bmp = await new Promise((res, rej) => {
        const im = new Image(); const u = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: 'image/svg+xml' }));
        im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej(new Error(`cannot decode image${typeof src === 'string' ? ` "${src}"` : ''} (unsupported or corrupt)`)); };
        im.src = u;
      });
    }
  }
  let w = bmp.width || bmp.naturalWidth || 300, h = bmp.height || bmp.naturalHeight || 150;
  if (opts.maxSide && Math.max(w, h) > opts.maxSide) { const k = opts.maxSide / Math.max(w, h); w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k)); }
  const c = canvasOf(w, h); const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h); bmp.close?.();
  const id = g.getImageData(0, 0, w, h);
  return { width: w, height: h, data: id.data };
}

export function toCanvas(img) {
  const c = canvasOf(img.width, img.height);
  const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  c.getContext('2d').putImageData(new ImageData(data, img.width, img.height), 0, 0);
  return c;
}

export async function canvasBytes(canvas, format = 'png', quality) {
  const type = MIME_OF[format] || 'image/png';
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type, quality }) : await new Promise((r) => canvas.toBlob(r, type, quality));
  if (!blob) throw new Error(`encode failed (${format})`);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || type };
}

/** encode(img, {format:'png'|'jpeg'|'webp', quality:0..1}) → {bytes, mime} */
export async function encode(img, opts = {}) {
  const format = (opts.format || 'png').replace('jpg', 'jpeg');
  return canvasBytes(toCanvas(img), format, opts.quality);
}

/** save(img, path, {format?, quality?, meta?}) → vfs stat (with width/height). Format defaults to the path extension, else png. */
export async function save(img, path, opts = {}) {
  const ext = vfs.extOf(path);
  const format = opts.format || (MIME_OF[ext] ? ext : 'png');
  const { bytes, mime } = await encode(img, { format, quality: opts.quality });
  return vfs.write(path, bytes, { mime, meta: { width: img.width, height: img.height, ...opts.meta } });
}

export async function saveCanvas(canvas, path, opts = {}) {
  const ext = vfs.extOf(path);
  const format = opts.format || (MIME_OF[ext] ? ext : 'png');
  const { bytes, mime } = await canvasBytes(canvas, format, opts.quality);
  return vfs.write(path, bytes, { mime, meta: { width: canvas.width, height: canvas.height, ...opts.meta } });
}

export const blank = (width, height, rgba = [0, 0, 0, 255]) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2]; data[i + 3] = rgba[3]; }
  return { width, height, data };
};

/** Rec.709 luma plane as Float32Array(width*height), 0..255 */
export function luma(img) {
  const n = img.width * img.height, d = img.data, y = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) y[i] = 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
  return y;
}
