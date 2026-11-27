# @ffmpeg/core 0.12.10 (single-thread build)

`ffmpeg-core.js` and `ffmpeg-core.wasm` are the unmodified `dist/esm` files of the npm package
[`@ffmpeg/core@0.12.10`](https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10) — FFmpeg n5.1.4 compiled to
WebAssembly by the ffmpeg.wasm project (https://github.com/ffmpegwasm/ffmpeg.wasm), built without threads.

**Licence: GPL-2.0-or-later** (see `LICENSE` in this directory). FFmpeg is configured with `--enable-gpl` and links
libx264 and libx265 (GPL-2.0-or-later), which makes the combined binary GPL. Per the project's Dockerfile it also contains libvpx (BSD-3-Clause),
LAME (LGPL-2.0-or-later), libopus (BSD-3-Clause), libvorbis/libogg/libtheora (BSD-3-Clause), zlib (Zlib),
libwebp (BSD-3-Clause), FreeType (FTL / GPL-2.0), FriBidi (LGPL-2.1-or-later), HarfBuzz (MIT), libass (ISC) and
zimg (WTFPL). FFmpeg's own code is LGPL-2.1-or-later / GPL-2.0-or-later.

It is shipped here as a separate, unmodified binary that the page loads on demand in a Web Worker and talks to only
through `postMessage`; the rest of this site is not derived from it and keeps its own licence.

Corresponding source: https://github.com/ffmpegwasm/ffmpeg.wasm at the revision that published core 0.12.10 (its
`Dockerfile` and `build/` scripts pin every dependency); FFmpeg sources at https://github.com/FFmpeg/FFmpeg/tree/n5.1.4.
