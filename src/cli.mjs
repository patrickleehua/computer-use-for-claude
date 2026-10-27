#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { discoverRuntime } from './runtime.mjs';
import { setup } from './setup.mjs';
import { installUser, userStatus } from './user-install.mjs';
import { readFile } from 'node:fs/promises';

const [command = 'status', project] = process.argv.slice(2);
try {
  if (['install', 'uninstall'].includes(command)) {
    if (project) throw Error('用户级安装无需项目目录。用法：codex-cu install | uninstall');
    const result = await installUser({ remove: command === 'uninstall' });
    console.log(`${command === 'install' ? '已安装到 Claude 用户级：以后在任意目录直接运行 claude。' : '已移除 Claude 用户级注册及本桥接 hooks；其他配置保留。'}\n${result.mcpPath}\n${result.settingsPath}`);
    if (command === 'install') console.log('请重新启动已有 Claude 会话。被项目禁用/覆盖的同名服务仍遵循原项目设置；在 /mcp 检查 codex_cu。Codex 桌面应用仍需保持运行。');
  } else if (command === 'status') {
    console.log(JSON.stringify(await userStatus(), null, 2));
  } else if (command === '--version' || command === '-v') {
    console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  } else if (command === 'setup' || command === 'remove') {
    const result = await setup(project, { remove: command === 'remove' });
    console.log(`${command === 'setup' ? '已配置' : '已移除'}：${result.project}`);
    if (command === 'setup' && result.disabled) console.log('项目配置有 codex_cu 的禁用记录，请在 Claude 的 /mcp 中确认实际状态；若为 Disabled，选择 Enable 后连接。安装不会覆盖你的禁用选择。');
  } else if (command === 'doctor') {
    const runtime = await discoverRuntime();
    const client = new Client({ name: 'codex-cu-doctor', version: '0.1.4' });
    try {
      await client.connect(new StdioClientTransport({ command: runtime.command, args: runtime.args, env: runtime.env, stderr: 'inherit' }), { timeout: 20000 });
      const { tools } = await client.listTools();
      console.log(JSON.stringify({ status: '运行时可连接', plugin: runtime.version, runtime: runtime.runtimeManifest?.runtime_archive_version, tools: tools.map(t => t.name), note: '连接检查不代表桌面或浏览器操作验收。' }, null, 2));
    } finally { await client.close(); }
  } else if (['help','--help','-h'].includes(command)) {
    console.log('codex-cu install        一次安装到 Claude 用户级，所有项目可用\ncodex-cu status         查看用户级接入状态\ncodex-cu doctor         检查原版运行时连接\ncodex-cu uninstall      移除用户级接入（保留其他配置）\ncodex-cu setup [目录]   可选：仅为一个项目接入\ncodex-cu remove [目录]  移除该项目接入\ncodex-cu --version      查看版本');
  } else throw Error('未知命令。运行 codex-cu --help 查看用法。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
