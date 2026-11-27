// mind :: dedicated module worker hosting the inference engine, so decoding audio windows or generating tokens
// (seconds to minutes, fully blocking on the single-threaded WASM backend) never freezes the page.
import { handle, setHost } from './engine.js';

setHost({ fatal: (error) => self.postMessage({ type: 'fatal', error }) });
self.onmessage = (e) => { handle(e.data, (msg) => self.postMessage(msg)); };
self.addEventListener('unhandledrejection', (e) => {
  // ONNX Runtime rejects stray promises when its device dies; report instead of leaving the page waiting
  const r = e.reason; const m = typeof r === 'number' ? `native exception ${r}` : (r?.message || String(r));
  if (/lost|out of memory|bad_alloc|Aborted\(/i.test(m) || typeof r === 'number') self.postMessage({ type: 'fatal', error: `inference engine failed outside a call: ${m}` });
});
self.postMessage({ type: 'ready' });
