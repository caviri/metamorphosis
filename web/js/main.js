// μεταμόρφωσις :: boot — find out which room this page is, load only that room's tool families,
// restore the persisted files, open WebMCP for the exposed tools, start the terminal.
import { M } from './core.js';
import { locate, DOMAIN_MODULE, ROOMS } from './rooms.js';

let resolveReady;
M.ready = new Promise((r) => { resolveReady = r; });
M.room = locate();
M.rooms = ROOMS;
M.modules = {};

async function boot() {
  const ui = await import('./term.js').catch((e) => { console.error('[μ] terminal failed to load', e); return null; });
  const modules = [...new Set([...M.room.domains].map((d) => DOMAIN_MODULE[d]).filter(Boolean))];
  await Promise.all([
    M.vfs.restore().catch((e) => console.warn('[μ] vfs restore failed', e)),
    ...modules.map(async (m) => {
      M.modules[m] = await M.summon(m);
      if (M.modules[m] !== 'ok') M.emit('log', { level: 'warn', tool: 'boot', msg: `module ${m} not loaded — ${M.modules[m]}` });
    }),
  ]);
  try { const { startWebMCP } = await import('./mcp.js'); await startWebMCP(); } catch (e) { console.warn('[μ] webmcp bridge failed', e); }
  resolveReady(M);
  M.emit('ready', { tools: M.tools.size });
  ui?.afterBoot?.();
}
boot();
