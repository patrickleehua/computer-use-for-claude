import { readFile, readdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

// Read installed plugin metadata; never hard-code a package generation or native pipe.
export async function discoverRuntime({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex') } = {}) {
  const root = join(codexHome, 'plugins/cache/openai-bundled/unified-computer-use');
  let entries;
  try { entries = await readdir(root); } catch (error) {
    if (error.code === 'ENOENT') throw new Error('未找到 OpenAI Computer Use 插件。请打开 Codex 并启用 Computer Use 和 Chrome 插件。');
    throw error;
  }
  const versions = entries.filter(v => /^\d+(?:\.\d+)+$/.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const configPath = join(root, version, '.mcp.json');
    let config;
    try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch { continue; }
    const spec = config.mcpServers?.cua_repl;
    if (!spec?.command || !spec.args?.length) continue;
    try { await access(spec.command); await access(spec.args[0]); } catch { continue; }
    const env = { ...getDefaultEnvironment(), ...spec.env };
    for (const name of spec.env_vars || []) if (process.env[name] !== undefined) env[name] = process.env[name];
    const services = JSON.parse(env.NODE_REPL_TRUSTED_SERVICES || '{}');
    if (!Object.hasOwn(services, 'sky')) services.sky = '@oai/sky/service';
    env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify(services);
    env.CUA_REPL_ENABLED_SURFACES = 'browser,computer';
    // The bridge uses the original browser extension, not the app's embedded browser.
    env.BROWSER_USE_AVAILABLE_BACKENDS = 'chrome';
    const identity = `claude-codex-cu-${randomUUID()}`;
    env.NODE_REPL_REQUEST_META = JSON.stringify({ 'x-codex-turn-metadata': { session_id: identity, turn_id: `${identity}-probe` } });
    let runtimeManifest;
    try { runtimeManifest = JSON.parse(await readFile(join(dirname(dirname(spec.command)), 'manifest.json'), 'utf8')); } catch {}
    const nativeRoot = join(codexHome, 'plugins/cache/openai-bundled/computer-use', version);
    const desktopDocumentation = [join(nativeRoot, 'skills/computer-use/SKILL.md'),
      ...['guidance', 'api', 'confirmations'].map(name => join(nativeRoot, `docs/${name}.md`))];
    return { command: spec.command, args: spec.args, env, version, configPath, runtimeManifest, identity, desktopDocumentation };
  }
  throw new Error('未找到可用的 OpenAI 原版运行时。请打开 Codex，并启用 Computer Use 和 Chrome 插件。');
}
