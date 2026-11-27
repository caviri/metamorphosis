# vendored

Everything the page needs at runtime lives here; nothing is fetched from a CDN.

| lib | version | license | files | used by |
|---|---|---|---|---|
| @w3c/webmcp-polyfill | 0.2.0 | Apache-2.0 | webmcp/polyfill.js | js/mcp.js |
| fflate | 0.8.3 | MIT | fflate/fflate.js (ESM browser build) | tools/data.js (zip, gzip, zlib, xlsx) — shared with doc/geo |
| js-yaml | 5.5.0 | MIT | js-yaml/js-yaml.mjs | tools/data.js (YAML read/write) |
| smol-toml | 1.9.1 | BSD-3-Clause | smol-toml/*.js (ESM dist) | tools/data.js (TOML read/write) |
| mammoth | 1.13.0 | BSD-2-Clause (bundles jszip MIT, bluebird MIT, underscore MIT, xmlbuilder MIT and others) | mammoth/mammoth.browser.min.js (UMD → window.mammoth, 405 KB) | tools/doc.js (docx → HTML → Markdown) |
| turndown | 7.2.5 | MIT | turndown/turndown.js (browser ESM build) | tools/doc.js (HTML → Markdown) |
| turndown-plugin-gfm | 1.0.2 | MIT | turndown/turndown-plugin-gfm.js (browser ESM build) | tools/doc.js (strikethrough, task lists) |
| marked | 18.3.0 | MIT | marked/marked.js (ESM build, sourcemap comment removed) | tools/doc.js (Markdown → HTML / tokens for docx) |
| tesseract.js | 7.0.0 | Apache-2.0 | tesseract/tesseract.esm.min.js, tesseract/worker.min.js (sourceMappingURL comment stripped) | tools/vision.js (vision.ocr, vision.ocrOverlay) |
| tesseract.js-core (Tesseract 5 LSTM, WASM) | 7.0.0 | Apache-2.0 | tesseract/tesseract-core-simd-lstm.{js,wasm} (2.9 MB), tesseract/tesseract-core-lstm.{js,wasm} (non-SIMD fallback, 2.9 MB) | tools/vision.js (OCR engine, runs in a worker) |
| tessdata_fast (eng, deu, fra, spa) | main @ 2026-11-27 (4.0.0 models) | Apache-2.0 | tesseract/lang/{eng,deu,fra,spa}.traineddata.gz (gzip -9 of upstream; 2.0 + 0.9 + 0.6 + 1.1 MB) | tools/vision.js (OCR language models) |
| zxing-wasm (ZXing-C++ + zint) | 3.1.8 | MIT (wrapper), Apache-2.0 (zxing-cpp), BSD-3-Clause (zint) | zxing-wasm/full/index.js, zxing-wasm/share.js, zxing-wasm/full/zxing_full.wasm (1.4 MB) | tools/vision.js (vision.barcodeRead/Write, vision.qrRead/Write) |
| onnxruntime-web | 1.31.1 | MIT | onnxruntime-web/ort.webgpu.min.mjs (sourceMappingURL comment stripped), ort-wasm-simd-threaded.asyncify.{mjs,wasm} (28.7 MB; one binary serves both the WebGPU and the single-threaded WASM execution provider) | tools/vision.js (vision.classify) |
| MobileNetV2 ImageNet-1k (ONNX model zoo, opset 12) | mobilenetv2-12 | Apache-2.0 | models/mobilenetv2/mobilenetv2-12.onnx (14.0 MB), models/mobilenetv2/synset.txt (labels) | tools/vision.js (vision.classify) |
