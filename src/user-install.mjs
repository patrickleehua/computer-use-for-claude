import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SERVER, configureHooks, readJson, save } from './setup.mjs';

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const userPaths = () => ({
  mcpPath: process.env.CLAUDE_CONFIG_DIR ? join(resolve(process.env.CLAUDE_CONFIG_DIR), '.claude.json') : join(homedir(), '.claude.json'),
  settingsPath: join(process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude'), 'settings.json'),
});
export const installedSpec = () => ({ type: 'stdio', command: process.execPath, args: [join(root, 'src/bridge.mjs')] });
export const sameServer = (a, b) => a?.command === b.command && (a.type || 'stdio') === 'stdio' &&
  JSON.stringify(a.args) === JSON.stringify(b.args) && !a.url && !Object.keys(a.env || {}).length;

// Claude's official CLI owns .claude.json (which also contains live session
// preferences). Do not rewrite that whole file to register one MCP server.
export async function claudeCommand(args) {
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
  const candidates = (process.env.PATH || '').split(delimiter).flatMap(path => names.map(name => join(path, name)));
  if (process.platform === 'win32') candidates.push(join(homedir(), '.local/bin/claude.exe'),
    join(process.env.APPDATA || join(homedir(), 'AppData/Roaming'), 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
  for (const command of candidates) {
    try { await access(command); } catch { continue; }
    return execute(command, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  }
  throw Error('找不到 Claude Code 可执行程序。请先安装 Claude Code，并确保 claude 命令可用。');
}

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const raw = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if(error.code === 'ENOENT') return null; throw error; } };
export async function installUser({ remove = false, paths = userPaths(), spec = installedSpec(), runClaude = claudeCommand } = {}) {
  const { mcpPath, settingsPath } = paths;
  const config = await readJson(mcpPath);
  if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) throw Error('现有 Claude 用户 MCP 配置格式错误，未写入。');
  const previous = config.mcpServers?.[SERVER];
  if (previous && !sameServer(previous, spec)) throw Error('用户级已有不同的 codex_cu 配置，未覆盖或删除。请先确认原服务来源。');
  const before = await raw(settingsPath);
  const settings = before === null ? {} : JSON.parse(before);
  if (!object(settings)) throw Error('现有 Claude 用户设置格式错误，未写入。');
  configureHooks(settings, { remove });
  // Check every settings input before the CLI mutates MCP registration. The
  // settings file is replaced atomically only if no other host changed it.
  let added = false, removed = false;
  try {
    if (!remove && !previous) {
      await runClaude(['mcp', 'add-json', '--scope', 'user', SERVER, JSON.stringify(spec)]);
      added = true;
    }
    const current = await readJson(mcpPath);
    if (!remove && !sameServer(current.mcpServers?.[SERVER], spec)) throw Error('Claude 未确认用户级 MCP 注册成功，未写入 hooks。');
    if (await raw(settingsPath) !== before) throw Error('用户设置在安装期间被其他程序修改，未覆盖。请重新执行安装。');
    // Unregister first; if that fails, leave the existing hooks usable.
    if (remove && previous) { await runClaude(['mcp', 'remove', '--scope', 'user', SERVER]); removed = true; }
    if (remove && (await readJson(mcpPath)).mcpServers?.[SERVER]) throw Error('Claude 未确认用户级 MCP 已移除，保留原 hooks。');
    await save(settingsPath, settings);
  } catch (error) {
    if (added && sameServer((await readJson(mcpPath)).mcpServers?.[SERVER], spec)) {
      await runClaude(['mcp', 'remove', '--scope', 'user', SERVER]).catch(() => {});
    }
    if (removed && !(await readJson(mcpPath)).mcpServers?.[SERVER]) {
      await runClaude(['mcp', 'add-json', '--scope', 'user', SERVER, JSON.stringify(previous)]).catch(() => {});
    }
    throw error;
  }
  return { scope: 'user', mcpPath, settingsPath, command: spec.command, bridgePath: spec.args[0] };
}

export async function userStatus() {
  const paths = userPaths(), spec = installedSpec();
  const config = await readJson(paths.mcpPath), settings = await readJson(paths.settingsPath);
  const installed = sameServer(config.mcpServers?.[SERVER], spec);
  const hooks = settings.hooks?.PreToolUse?.some(entry => entry.hooks?.some(h => h.type === 'mcp_tool' && h.server === SERVER && h.tool === 'set_turn_context')) || false;
  return { installed, hooks, ...paths, bridgePath: spec.args[0], note: '用户级配置状态；具体项目仍可能禁用或覆盖同名服务。' };
}
