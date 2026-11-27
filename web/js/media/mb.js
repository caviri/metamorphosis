// μεταμόρφωσις :: media/mb — Mediabunny (demux/mux/convert on top of WebCodecs), loaded lazily from vendor/.
import { M, vfs } from '../core.js';

const V = (p) => new URL(`../../vendor/mediabunny/${p}`, import.meta.url).href;
let libP = null;
/** the Mediabunny module namespace (cached). Also exposed as globalThis.Mediabunny for the encoder extensions. */
export function mb() {
  libP ||= import(V('mediabunny.min.mjs')).then((lib) => { globalThis.Mediabunny ||= lib; return lib; }).catch((e) => { libP = null; throw new Error(`Mediabunny failed to load: ${e.message}`); });
  return libP;
}
export const hasWebCodecs = () => typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';

// WASM audio encoders for what WebCodecs usually lacks (MP3: LAME, FLAC: libFLAC, AAC: libavcodec). ~0.3–1.1 MB each, on demand.
const EXT = { mp3: ['mediabunny-mp3-encoder.min.js', 'MediabunnyMp3Encoder', 'registerMp3Encoder'], flac: ['mediabunny-flac-encoder.min.js', 'MediabunnyFlacEncoder', 'registerFlacEncoder'], aac: ['mediabunny-aac-encoder.min.js', 'MediabunnyAacEncoder', 'registerAacEncoder'] };
const extP = {}; const wasmEncoders = new Set();
/** make sure `codec` (mediabunny audio codec name) can be encoded; → 'webcodecs' | 'wasm' | null (cannot) */
export async function ensureAudioEncoder(codec) {
  const lib = await mb();
  if (wasmEncoders.has(codec)) return 'wasm';
  if (await lib.canEncodeAudio(codec).catch(() => false)) return 'webcodecs';
  if (!EXT[codec]) return null;
  extP[codec] ||= (async () => {
    const [file, global, fn] = EXT[codec];
    await M.loadScript(V(file));
    globalThis[global][fn]();
    wasmEncoders.add(codec);
  })().catch((e) => { delete extP[codec]; throw new Error(`could not load the WASM ${codec} encoder: ${e.message}`); });
  await extP[codec];
  return 'wasm';
}
export const audioEncoderKind = (codec) => (wasmEncoders.has(codec) ? 'wasm' : 'webcodecs');

/** open a VFS file as a Mediabunny Input (caller disposes) */
export async function openInput(path) {
  const lib = await mb();
  return new lib.Input({ source: new lib.BlobSource(vfs.blob(path)), formats: lib.ALL_FORMATS });
}
