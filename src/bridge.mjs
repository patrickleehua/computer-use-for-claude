import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { discoverRuntime } from './runtime.mjs';
import { consentForm, consentAnswer, automaticAccess } from './approvals.mjs';
import { BrowserPresenter, openBrowserTool } from './presentation.mjs';
import { WindowsDesktop, desktopTool, DESKTOP_GUIDANCE } from './desktop.mjs';

const ORIGINAL = new Set(['js', 'js_reset']);
const PUBLIC = new Set([...ORIGINAL, 'open_browser', 'desktop']);
const META = 'x-codex-turn-metadata';
const TOOL_ID = 'claudecode/toolUseId';
const TAB_GUIDANCE = 'For user requests to OPEN or SHOW a website (打开网页), use open_browser with its full URL. It uses the original extension, selects the result tab, restores/focuses the window and verifies visibility. Do not replace it with js goto/createBrowserTab plus a screenshot: those can succeed in a minimized background window. Report visible opening only for presented:true; otherwise report the concrete error. open_browser also returns retained:true after marking the page as a deliverable: that page stays open after the turn and bridge exit. Report this confirmed state accurately; do not append a warning that it may close at turn end. Only unmarked temporary agent-created tabs are cleaned at turn end. For background research and general interaction use js. When a live tab is a user-facing output, call await tab.markDeliverable() before replying or asking a follow-up (open_browser already does this). For unfinished work awaiting human input, call await tab.markHandoff() before yielding; re-mark when needed in a later turn. Keep normal Stop/Interrupt cleanup enabled. Screenshots return as MCP image blocks; use host-provided image files or normal host file tools to save them, not filesystem writes inside cua_repl. Continue an already authorized task without asking the user to approve each routine step.';
const errorResult = text => ({ isError: true, content: [{ type: 'text', text }] });
const ok = text => ({ content: [{ type: 'text', text }] });
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
export const lifeKey = (session, prompt, agent = '') => JSON.stringify([session, prompt, agent]);

export class Turns {
  contexts = new Map();
  lives = new Map();
  ended = new Set();
  bind(input) {
    if (!nonempty(input.session_id) || !nonempty(input.turn_id) || !nonempty(input.tool_use_id)) throw Error('缺少 Claude 会话或工具标识，请运行 setup 修复项目配置。');
    const key = lifeKey(input.session_id, input.turn_id, input.agent_id || '');
    if (this.ended.has(key)) throw Error('本轮已停止。请发送一条新消息后继续。');
    if (!this.lives.has(key)) this.lives.set(key, {
      key, session_id: input.agent_id || input.session_id,
      turn_id: createHash('sha256').update(`claude-codex-cu:${key}`).digest('hex'),
      prompt: input.turn_id, parent: input.session_id, agent: input.agent_id || '', ended: false,
    });
    if (this.contexts.size >= 256) throw Error('待执行工具过多，请等待当前任务结束。');
    this.contexts.set(input.tool_use_id, { life: this.lives.get(key), permissionMode: input.permission_mode || '' });
  }
  take(id) {
    const binding = this.contexts.get(id);
    this.contexts.delete(id);
    if (!binding || binding.life.ended) throw Error('没有匹配的 Claude PreToolUse 上下文，本次操作未执行。');
    return binding;
  }
  finish(life) {
    life.ended = true;
    this.lives.delete(life.key);
    this.ended.add(life.key);
    for (const [id, current] of this.contexts) if (current.life === life) this.contexts.delete(id);
    if (this.ended.size > 4096) this.ended.delete(this.ended.values().next().value);
  }
}

const contextTool = {
  name: 'set_turn_context', description: 'Internal Claude host hook only. Not a model tool.',
  inputSchema: { type: 'object', properties: {
    session_id: { type: 'string' }, turn_id: { type: 'string' }, tool_use_id: { type: 'string' }, agent_id: { type: 'string' }, permission_mode: { type: 'string' },
  }, required: ['session_id', 'turn_id', 'tool_use_id'], additionalProperties: false },
};

export const diagnosticDirectory = () => join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'codex-cu', 'logs');
export async function runBridge({ runtime, transport = new StdioServerTransport(), logPath = process.env.CODEX_CU_LOG || join(diagnosticDirectory(), `bridge-${new Date().toISOString().slice(0, 10)}-${process.pid}.jsonl`) } = {}) {
  runtime ??= await discoverRuntime();
  const event = async (name, fields = {}) => {
    const line = JSON.stringify({ time: new Date().toISOString(), event: name, ...fields });
    // Diagnostics must never change an authorization decision or break a tool call.
    if (logPath) try { await mkdir(dirname(logPath), { recursive: true }); await appendFile(logPath, `${line}\n`); }
    catch { process.stderr.write('Codex CU: 诊断日志无法写入。\n'); }
  };
  const turns = new Turns();
  const presenter = new BrowserPresenter();
  const desktop = new WindowsDesktop(runtime.desktopDocumentation);
  let server, closed = false, busy = false, approvalNote, activeCall, cleanup = Promise.resolve();
  const upstreamTransport = new StdioClientTransport({ command: runtime.command, args: runtime.args, env: runtime.env, stderr: 'pipe' });
  upstreamTransport.stderr?.on('data', data => process.stderr.write(data));
  const upstream = new Client({ name: 'claude-codex-cu', version: '0.1.4' }, { capabilities: { elicitation: { form: {}, url: {} } } });
  upstream.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    if (!activeCall || extra.signal.aborted || closed || activeCall.life.ended) return { action: 'cancel' };
    const automatic = automaticAccess(request.params, activeCall);
    if (automatic) {
      await event('approval_answered', { action: 'accept', source: 'claude_mode', mode: activeCall.permissionMode, kind: automatic.kind });
      return { action: 'accept', content: {} };
    }
    if (activeCall?.permissionMode === 'dontAsk') {
      approvalNote = 'Claude 当前为 dontAsk 模式，此授权未获自动允许，已取消且未弹框。';
      await event('approval_cancelled', { reason: 'dontAsk', source: 'claude_mode' });
      return { action: 'cancel' };
    }
    const capability = server?.getClientCapabilities()?.elicitation;
    if (!capability || extra.signal.aborted || closed) {
      await event('approval_unavailable', { reason: !capability ? 'host_capability_missing' : 'request_ended' });
      if (!capability) approvalNote = 'Claude 宿主没有提供交互授权能力，本次已取消。请使用支持 MCP elicitation 的交互式 Claude Code。没有收到用户的拒绝决定。';
      return { action: 'cancel' };
    }
    const started = Date.now();
    await event('approval_requested', { mode: request.params.mode || 'form', connector: request.params._meta?.connector_id });
    try {
      const form = consentForm(request.params);
      const raw = await server.elicitInput(form?.request || request.params, { signal: extra.signal, timeout: 600000 });
      const response = form ? consentAnswer(form, raw) : raw;
      if (response.action === 'cancel') approvalNote = '授权界面已取消，未收到允许。桥接没有提交持久化决定；不要把取消解释为用户永久拒绝。';
      if (response.action === 'decline') approvalNote = 'Claude 宿主返回了 Decline，桥接按原样拒绝本次请求。仅凭此响应不能确定拒绝来自人工选择还是宿主 hook，也不能确定原版设置的保存时长。';
      await event('approval_answered', { action: response.action, hostAction: raw.action, ms: Date.now() - started });
      return response;
    } catch (error) {
      await event('approval_cancelled', { code: error.code, reason: extra.signal.aborted ? 'request_ended' : 'host_error', ms: Date.now() - started });
      process.stderr.write(`Codex CU: 授权表单未完成（${extra.signal.aborted ? '操作已取消' : `宿主错误 ${error.code ?? 'unknown'}`}），本次未授权。\n`);
      approvalNote = 'Claude 授权表单未完成，本次已取消。没有收到用户的拒绝决定。请先检查宿主授权界面，不要用其他执行路径绕过原版策略。';
      return { action: 'cancel' };
    }
  });
  try {
    await upstream.connect(upstreamTransport, { timeout: 20000 });
    const all = (await upstream.listTools()).tools;
    if (!all.some(t => t.name === 'turn_ended') || [...ORIGINAL].some(name => !all.some(t => t.name === name))) throw Error('原版运行时缺少必要工具，请更新 Codex 后重试。');
    // Claude may persist the runtime's long first-use documentation to a file.
    // Keep this lifecycle contract in the always-visible descriptor as well.
    const tools = [...all.filter(t => ORIGINAL.has(t.name)).map(tool => tool.name === 'js'
      ? { ...tool, description: `${tool.description}\n\nWindows Claude bridge: ${TAB_GUIDANCE}\n${DESKTOP_GUIDANCE}` } : tool), openBrowserTool, desktopTool];
    const endTool = all.find(t => t.name === 'turn_ended');
    await event('runtime_connected', { plugin: runtime.version, runtime: runtime.runtimeManifest?.runtime_archive_version, bridgePid: process.pid, runtimePid: upstreamTransport.pid });
    server = new Server({ name: 'codex-cu', version: '0.1.4' }, {
      capabilities: { tools: {} },
      instructions: `${upstream.getInstructions() || ''}\nThis server connects Claude to the original locally installed OpenAI computer and Chrome extension runtime. Use open_browser for visible website opening, js for browser/general interaction, desktop for Windows native apps, and js_reset to reset the shared kernel. For raw js, the first UI call must be one documented entry point, such as await cua.getState(). Inspect returned instructions before continuing. open_browser performs its own documented initialization. set_turn_context and turn_ended are host hooks; never call them yourself. Screenshots and text may be sent to your configured Claude model provider. Respect the original runtime's permissions and user stops.\n${TAB_GUIDANCE}\n${DESKTOP_GUIDANCE}`,
    });
    async function finish(life, hook = 'Stop') {
      if (life.ended) return life.finishing;
      turns.finish(life);
      if (hook !== 'Stop') presenter.invalidateKernel();
      // Stop/Interrupt can arrive concurrently with a cancelled tool. Wait for
      // cleanup before another operation; never publish an idle bridge early.
      life.finishing = cleanup = cleanup.then(async () => {
        const result = await upstream.callTool({ name: 'turn_ended', arguments: { hook_event_name: hook, session_id: life.session_id, turn_id: life.turn_id } }, undefined, { timeout: 10000 });
        await event('turn_ended', { hook, ok: !result.isError });
        if (result.isError) throw Error('原版运行时未能完成本轮清理，请停止本次任务并重新连接。');
      });
      return life.finishing;
    }
    async function close() {
      if (closed) return;
      closed = true;
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      if (transport instanceof StdioServerTransport) process.stdin.removeListener('end', stop);
      await Promise.race([
        Promise.allSettled([...turns.lives.values()].map(life => finish(life, 'Interrupt'))),
        new Promise(resolve => { const timer = setTimeout(resolve, 2500); timer.unref(); }),
      ]);
      // Reset the original private kernel before the stdio process exits. On
      // Windows a forced parent exit otherwise need not terminate grandchildren.
      await upstream.callTool({ name: 'js_reset', arguments: {} }, undefined, { timeout: 750 }).catch(() => {});
      await upstream.close();
      await event('bridge_closed');
    }
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools, endTool, contextTool] }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args = {}, _meta = {} } = request.params;
      const id = _meta[TOOL_ID];
      if (name === 'set_turn_context') {
        if (id) return errorResult('仅 Claude 宿主 hook 可设置会话上下文。');
        try { turns.bind(args); return ok('Context bound.'); } catch (error) { return errorResult(error.message); }
      }
      if (name === 'turn_ended') {
        if (id) return errorResult('仅 Claude 宿主 hook 可结束会话。');
        const matches = [...turns.lives.values()].filter(life =>
          life.prompt === args.turn_id && (life.parent === args.session_id || life.session_id === args.session_id));
        await Promise.all(matches.map(life => finish(life, args.hook_event_name === 'Stop' ? 'Stop' : 'Interrupt')));
        return ok('Turn released.');
      }
      if (!PUBLIC.has(name)) return errorResult(`Unknown tool: ${name}`);
      let binding;
      try { binding = turns.take(id); } catch (error) { return errorResult(error.message); }
      const { life, permissionMode } = binding;
      if (closed) return errorResult('桥接已关闭，请重新连接。');
      if (busy && (activeCall?.life.ended || activeCall?.signal.aborted)) await activeCall.settled;
      if (busy) return errorResult('正在执行另一项电脑操作，请等待其完成后重新观察界面。');
      busy = true;
      approvalNote = undefined;
      const metadata = { session_id: life.session_id, turn_id: life.turn_id, call_id: id };
      let release;
      const settled = new Promise(resolve => { release = resolve; });
      activeCall = { life, permissionMode, metadata, signal: extra.signal, settled };
      const started = Date.now();
      try {
        await cleanup;
        const invoke = (tool, arguments_) => {
          if (extra.signal.aborted || life.ended || closed) throw Error('本轮已停止，未继续浏览器操作。');
          return upstream.callTool({ name: tool, arguments: arguments_, _meta: { ..._meta, [META]: metadata } }, undefined,
            { signal: extra.signal, timeout: 660000 });
        };
        if (name === 'js_reset') presenter.reset();
        const result = name === 'open_browser'
          ? await presenter.open(args, code => invoke('js', { code, title: '打开并显示网页' }))
          : name === 'desktop' ? await desktop.call(args, input => invoke('js', input)) : await invoke(name, args);
        await event('tool_result', { tool: name, mode: permissionMode || 'unknown', ok: !result.isError, ms: Date.now() - started, images: result.content?.filter(c => c.type === 'image').length || 0 });
        const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
        if (result.isError && /explicitly stopped|stopped by the user|turn ended|user stopped/i.test(text)) await finish(life, 'Interrupt');
        return result.isError && approvalNote ? { ...result, content: [...result.content, { type: 'text', text: `Codex CU 授权诊断：${approvalNote}` }] } : result;
      } finally {
        if (extra.signal.aborted) await finish(life, 'Interrupt').catch(error => process.stderr.write(`${error.message}\n`));
        activeCall = undefined;
        busy = false;
        release();
      }
    });
    server.onerror = error => process.stderr.write(`Codex CU: ${error.message}\n`);
    server.onclose = () => { void close().catch(error => process.stderr.write(`${error.message}\n`)); };
    const stop = () => { void close().finally(() => server.close()); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    // The SDK's stdio server listens to data/errors, not EOF. Without this,
    // Claude closes stdin then force-kills the bridge before its child can exit.
    if (transport instanceof StdioServerTransport) process.stdin.once('end', stop);
    await server.connect(transport);
    return { server, upstream, close, turns };
  } catch (error) { await upstream.close().catch(() => {}); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBridge().catch(error => { process.stderr.write(`Codex CU: ${error.message}\n`); process.exitCode = 1; });
}
