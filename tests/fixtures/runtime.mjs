import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFile } from 'node:fs/promises';
import { consentForm } from '../../src/approvals.mjs';
import { environment } from './browser.mjs';
const browser = process.env.FIXTURE_BROWSER ? environment() : undefined;
const server = new Server({ name: 'test-original-runtime', version: '1' }, { capabilities: { tools: {} }, instructions: 'Fixture instructions must survive the relay.' });
const tools = ['js', 'js_reset', 'turn_ended', 'js_add_node_module_dir'].map(name => ({ name, description: name, inputSchema: { type: 'object', additionalProperties: true } }));
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {} } = request.params;
  if (args.code?.startsWith('var sky = (await import("@oai/sky")).sky;\n')) args.code=args.code.slice(args.code.indexOf('\n')+1);
  if (name === 'turn_ended') {
    if (args.hook_event_name !== 'Stop') browser?.resetKernel();
    if (process.env.FIXTURE_LOG) await appendFile(process.env.FIXTURE_LOG, `${JSON.stringify(args)}\n`);
    return { content: [{ type: 'text', text: 'ended' }] };
  }
  if (name === 'js_reset') browser?.resetKernel();
  if (args.code === 'approval' || args.code === 'approval-error') {
    const params = { mode: 'form', message: 'Allow test origin?', _meta: { connector_id: 'browser-use', codex_approval_kind: 'mcp_tool_call', persist: 'always' }, requestedSchema: { type: 'object', properties: {} } };
    const result = await server.elicitInput(process.env.FIXTURE_CONSENT_FORM ? consentForm(params).request : params, { signal: extra.signal });
    return args.code === 'approval-error'
      ? { isError: true, content: [{ type: 'text', text: 'Original policy blocked this action.' }] }
      : { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
  if (['browser-access', 'native-access', 'high-risk-access', 'action-approval'].includes(args.code)) {
    const browser = args.code === 'browser-access';
    const _meta = browser
      ? { connector_id: 'browser-use', codex_request_type: 'approval_request', tool_name: 'access_browser_origin', origin: 'http://127.0.0.1:55202', tool_params: { origin: 'http://127.0.0.1:55202' }, persist: 'always' }
      : { connector_id: 'computer-use', riskLevel: args.code === 'high-risk-access' ? 'high' : 'low', tool_params: { app: 'notepad.exe' }, persist: ['session', 'always'], ...(args.code === 'action-approval' ? { tool_name: 'send_message' } : {}) };
    const result = await server.elicitInput({ mode:'form', message:'Allow test resource?', requestedSchema:{type:'object',properties:{}}, _meta:{..._meta, codex_approval_kind:'mcp_tool_call', 'x-codex-turn-metadata':request.params._meta?.['x-codex-turn-metadata']} }, {signal:extra.signal});
    return {content:[{type:'text',text:JSON.stringify(result)}]};
  }
  if (args.code === 'wait') await new Promise(resolve => extra.signal.addEventListener('abort', resolve, { once: true }));
  if (args.code === 'error') return { isError: true, content: [{ type: 'text', text: 'original error' }] };
  if (browser && /codexCuPresentation_/.test(args.code)) return browser.invoke(args.code);
  return { _meta: { fixture: true }, content: [{ type: 'text', text: JSON.stringify(request.params._meta) }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] };
});
await server.connect(new StdioServerTransport());
