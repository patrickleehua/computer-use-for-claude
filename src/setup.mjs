import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const SERVER = 'codex_cu';
const internal = [`mcp__${SERVER}__set_turn_context`, `mcp__${SERVER}__turn_ended`];
const turnEnd = event => ({ hooks: [{ type: 'mcp_tool', server: SERVER, tool: 'turn_ended', input: {
  hook_event_name: event, session_id: '${session_id}', turn_id: '${prompt_id}',
} }] });
export function bridgeHooks() {
  return {
    PreToolUse: [{ matcher: `^mcp__${SERVER}__(js|js_reset|open_browser|desktop)$`, hooks: [{ type: 'mcp_tool', server: SERVER, tool: 'set_turn_context', input: {
      session_id: '${session_id}', turn_id: '${prompt_id}', tool_use_id: '${tool_use_id}', agent_id: '${agent_id}', permission_mode: '${permission_mode}',
    } }] }],
    // SessionEnd runs after Claude disconnects MCP. Stdio close owns that cleanup.
    Stop: [turnEnd('Stop')], StopFailure: [turnEnd('Interrupt')],
    SubagentStop: [{ hooks: [{ type: 'mcp_tool', server: SERVER, tool: 'turn_ended', input: {
      hook_event_name: 'SubagentStop', session_id: '${agent_id}', turn_id: '${prompt_id}',
    } }] }],
  };
}
export const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } };
const owned = entry => entry.hooks?.some(hook => hook.type === 'mcp_tool' && hook.server === SERVER);
export async function save(path, content) {
  await mkdir(dirname(path), { recursive: true });
  // Only replace our own registration; all other settings survive installation/removal.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(content, null, 2)}\n`); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export function configureHooks(settings, { remove = false } = {}) {
  const hooks = settings.hooks ??= {};
  if (typeof hooks !== 'object' || Array.isArray(hooks)) throw Error('现有 hooks 格式错误，未写入配置。');
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries) || entries.some(entry => !Array.isArray(entry?.hooks))) throw Error(`现有 ${event} hooks 格式错误，未写入配置。`);
    // Keep mixed user/bridge groups: remove only our own hook, never the whole group.
    hooks[event] = entries.map(entry => owned(entry) ? { ...entry, hooks: entry.hooks.filter(h => h.type !== 'mcp_tool' || h.server !== SERVER) } : entry).filter(entry => entry.hooks?.length);
    if (!hooks[event].length) delete hooks[event];
  }
  if (!remove) for (const [event, entries] of Object.entries(bridgeHooks())) (hooks[event] ??= []).push(...entries);
  const deny = settings.permissions?.deny || [];
  if (!Array.isArray(deny)) throw Error('现有 permissions.deny 格式错误，未写入配置。');
  settings.permissions ??= {};
  settings.permissions.deny = [...deny.filter(rule => !internal.includes(rule)), ...(remove ? [] : internal)];
  return settings;
}
export async function setup(project = process.cwd(), { remove = false } = {}) {
  project = resolve(project);
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const mcpPath = join(project, '.mcp.json');
  const settingsPath = join(project, '.claude/settings.local.json');
  const mcp = await readJson(mcpPath);
  const settings = await readJson(settingsPath);
  if (remove) delete mcp.mcpServers?.[SERVER];
  else {
    const spec = { command: process.execPath, args: [join(root, 'src/bridge.mjs')] };
    const previous = mcp.mcpServers?.[SERVER];
    if (previous && JSON.stringify(previous) !== JSON.stringify(spec)) throw Error('已有同名 codex_cu 配置，未覆盖。请保留现有配置或使用其他项目。');
    (mcp.mcpServers ??= {})[SERVER] = spec;
  }
  configureHooks(settings, {remove});
  await save(mcpPath, mcp); await save(settingsPath, settings);
  return { project, mcpPath, settingsPath, disabled: settings.disabledMcpjsonServers?.includes(SERVER) || false };
}
