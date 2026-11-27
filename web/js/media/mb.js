// μεταμόρφωσις :: media/mb — Mediabunny (demux/mux/convert on top of WebCodecs), loaded lazily from vendor/.
import { M, vfs } from '../core.js';

const V = (p) => new URL(`../../vendor/mediabunny/${p}`, import.meta.url).href;
let libP = null;
/** the Mediabunny module namespace (cached). Also exposed as globalThis.Mediabunny for the encoder extensions. */
export function mb() {
  libP ||= import(V('mediabunny.min.mjs')).then((lib) => {
    // The encoder extensions (IIFE builds) look for a global `Mediabunny`. Give them a copy whose registerEncoder counts
    // encoder start-ups, so tools can tell "re-encoded with a WASM encoder" from "packets copied".
    globalThis.Mediabunny ||= { ...lib, registerEncoder: (cls) => lib.registerEncoder(class extends cls { init(...a) { wasmUse.n++; return super.init(...a); } }) };
    return lib;
  }).catch((e) => { libP = null; throw new Error(`Mediabunny failed to load: ${e.message}`); });
  return libP;
}
export const hasWebCodecs = () => typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';

// WASM audio encoders for what WebCodecs usually lacks (MP3: LAME, FLAC: libFLAC, AAC: libavcodec). ~0.3–1.1 MB each, on demand.
const EXT = { mp3: ['mediabunny-mp3-encoder.min.js', 'MediabunnyMp3Encoder', 'registerMp3Encoder'], flac: ['mediabunny-flac-encoder.min.js', 'MediabunnyFlacEncoder', 'registerFlacEncoder'], aac: ['mediabunny-aac-encoder.min.js', 'MediabunnyAacEncoder', 'registerAacEncoder'] };
const extP = {}; const wasmEncoders = new Set();
/** n = how many times a bundled WASM audio encoder has been started */
export const wasmUse = { n: 0 };
/**
 * Make sure `codec` (Mediabunny audio codec name) can be encoded, optionally with a concrete {numberOfChannels, sampleRate, bitrate}
 * (browser encoders are picky: Chrome's AAC only takes 96/128/160/192 kbit/s). Loads the WASM encoder when the browser cannot.
 * → 'webcodecs' | 'wasm' | null (cannot)
 */
export async function ensureAudioEncoder(codec, opts) {
  const lib = await mb();
  const can = () => lib.canEncodeAudio(codec, opts).catch(() => false);
  if (wasmEncoders.has(codec)) return (await can()) ? 'wasm' : null;
  if (await can()) return 'webcodecs';
  if (!EXT[codec]) return null;
  extP[codec] ||= (async () => {
    const [file, global, fn] = EXT[codec];
    await M.loadScript(V(file));
    globalThis[global][fn]();
    wasmEncoders.add(codec);
  })().catch((e) => { delete extP[codec]; throw new Error(`could not load the WASM ${codec} encoder: ${e.message}`); });
  await extP[codec];
  return (await can()) ? 'wasm' : null;
}
export const audioEncoderKind = (codec) => (wasmEncoders.has(codec) ? 'wasm' : 'webcodecs');

/** open a VFS file as a Mediabunny Input (caller disposes) */
export async function openInput(path) {
  const lib = await mb();
  return new lib.Input({ source: new lib.BlobSource(vfs.blob(path)), formats: lib.ALL_FORMATS });
}
