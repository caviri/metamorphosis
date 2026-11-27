// μεταμόρφωσις :: WebMCP bridge — every registered tool is offered to in-browser agents through
// document.modelContext (W3C WebMCP draft; native in Chrome behind the origin trial, polyfilled otherwise).
import { M } from './core.js';

const state = (M.webmcp = { native: false, api: null, count: 0, names: {} });
const ac = new AbortController();
const mcpName = (n) => n.replace(/\./g, '_');

async function execute(name, input) {
  const env = await M.call(name, input || {});
  // WebMCP hands the caller a JSON string of whatever we return; keep failures explicit and in-band.
  return env.ok ? env.result : { error: env.error, tool: name, hint: `call sys_help {"tool":"${name}"} for the schema` };
}

async function offer(ctx, t) {
  const name = mcpName(t.name);
  if (state.names[name] || !M.exposed(t)) return; // only this room's tools are offered
  state.names[name] = t.name;
  try {
    await ctx.registerTool({
      name, title: t.name, description: t.description, inputSchema: t.schema,
      annotations: { readOnlyHint: !!t.readOnly },
      execute: (input) => execute(t.name, input),
    }, { signal: ac.signal });
    state.count++;
  } catch (e) { delete state.names[name]; console.warn(`[μ] webmcp: could not register ${name}:`, e?.name || e); }
}

export async function startWebMCP() {
  state.native = 'modelContext' in document;
  if (!state.native) {
    try { await M.loadScript(new URL('../vendor/webmcp/polyfill.js', import.meta.url)); } catch (e) { console.warn('[μ] webmcp polyfill missing', e); }
  }
  const ctx = document.modelContext || navigator.modelContext;
  if (!ctx?.registerTool) return state;
  state.api = document.modelContext ? 'document.modelContext' : 'navigator.modelContext';
  for (const t of M.tools.values()) await offer(ctx, t);
  M.on('register', ({ name }) => { const t = M.tools.get(name); if (t) offer(ctx, t); });
  return state;
}
