import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runBridge, Turns } from '../src/bridge.mjs';
import { consentForm, consentAnswer, automaticAccess } from '../src/approvals.mjs';
import { setup } from '../src/setup.mjs';

async function fixture(t, { approve = false, response, capability = true, hostError = false, permissionMode = '', browser = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-cu-test-'));
  const log = join(directory, 'lifecycle.jsonl');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const bridge = await runBridge({ transport: a, logPath: join(directory, 'bridge.jsonl'), runtime: { command: process.execPath, args: [resolve('tests/fixtures/runtime.mjs')], env: { ...getDefaultEnvironment(), FIXTURE_LOG: log, ...(browser ? {FIXTURE_BROWSER:'1'} : {}) }, desktopDocumentation:[new URL('./fixtures/browser.mjs',import.meta.url)] } });
  const client = new Client({ name: 'fixture-client', version: '1' }, { capabilities: capability ? { elicitation: { form: {}, url: {} } } : {} });
  let prompts = 0;
  if (capability) client.setRequestHandler(ElicitRequestSchema, async request => {
    prompts++;
    assert.deepEqual(request.params.requestedSchema, { type: 'object', properties: {} });
    assert.match(request.params.message, /Accept = 仅允许这一次/);
    if (hostError) throw Error('Simulated host dialog failure');
    return response || (approve ? { action: 'accept', content: {} } : { action: 'decline' });
  });
  await client.connect(b);
  t.after(async () => { await bridge.close(); await client.close(); await bridge.server.close(); await rm(directory, { recursive: true, force: true }); });
  const bind = async (id = 'call', prompt = 'prompt', mode = permissionMode) => client.callTool({ name: 'set_turn_context', arguments: { session_id: 'session', turn_id: prompt, tool_use_id: id, permission_mode: mode } });
  const call = (code, id = 'call', options) => client.callTool({ name: 'js', arguments: { code }, _meta: { 'claudecode/toolUseId': id } }, undefined, options);
  return { client, bridge, log, bind, call, prompts: () => prompts };
}

test('preserves original tools, instructions, image blocks, metadata and errors', async t => {
  const { client, bind, call } = await fixture(t);
  assert.match(client.getInstructions(), /Fixture instructions must survive/);
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['js', 'js_reset', 'open_browser', 'desktop', 'turn_ended', 'set_turn_context']);
  await bind(); const result = await call('ok');
  assert.equal(result.content[1].data, 'iVBORw0KGgo=');
  assert.equal(result._meta.fixture, true);
  assert.equal(JSON.parse(result.content[0].text)['x-codex-turn-metadata'].session_id, 'session');
  await bind('error'); const error = await call('error', 'error');
  assert.equal(error.isError, true); assert.equal(error.content[0].text, 'original error');
});
test('refuses missing, replayed and ended call identities', async t => {
  const { client, bind, call } = await fixture(t);
  assert.equal((await call('ok')).isError, true);
  await bind(); assert.equal((await call('ok')).isError, undefined);
  assert.equal((await call('ok')).isError, true);
  await client.callTool({ name: 'turn_ended', arguments: { hook_event_name: 'Stop', session_id: 'session', turn_id: 'prompt' } });
  assert.equal((await bind('late')).isError, true);
  await bind('new', 'next-prompt'); assert.equal((await call('ok', 'new')).isError, undefined);
});

test('visible opener binds every original step to the host identity and fails without real presentation evidence', async t => {
  const {client,bind}=await fixture(t,{permissionMode:'auto'});
  const open=()=>client.callTool({name:'open_browser',arguments:{url:'https://example.com'},_meta:{'claudecode/toolUseId':'visible'}});
  assert.equal((await open()).isError,true);
  await bind('visible');
  const result=await open();
  assert.equal(result.isError,true);
  assert.equal(JSON.parse(result.content.at(-1).text).presented,false);
  const originals=result.content.filter(c=>c.type==='text'&&c.text.startsWith('{"claudecode/toolUseId"')).map(c=>JSON.parse(c.text));
  assert.equal(originals.length,3);
  for(const original of originals) {
    assert.equal(original['claudecode/toolUseId'],'visible');
    assert.equal(original['x-codex-turn-metadata'].call_id,'visible');
    assert.equal(original['x-codex-turn-metadata'].session_id,'session');
  }
  assert.equal((await open()).isError,true);
});
test('forwards human decline and does not persist one-time approval', async t => {
  const denied = await fixture(t);
  await denied.bind(); assert.equal(JSON.parse((await denied.call('approval')).content[0].text).action, 'decline');
  const allowed = await fixture(t, { approve: true });
  await allowed.bind(); assert.deepEqual(JSON.parse((await allowed.call('approval')).content[0].text), { action: 'accept', content: {} });
});
test('cancellation ends only the matching original turn and permits a new prompt', async t => {
  const { bind, call, log, bridge } = await fixture(t);
  await bind(); const controller = new AbortController();
  const pending = call('wait', 'call', { signal: controller.signal, timeout: 3000 });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(pending);
  await new Promise(resolve => setTimeout(resolve, 150));
  const events = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 1); assert.equal(events[0].hook_event_name, 'Interrupt');
  assert.equal(bridge.turns.lives.size, 0);
  await bind('next', 'next'); assert.equal((await call('ok', 'next')).isError, undefined);
});
test('host tools cannot be called as a model tool', async t => {
  const { client } = await fixture(t);
  for (const name of ['set_turn_context', 'turn_ended']) {
    const result = await client.callTool({ name, arguments: {}, _meta: { 'claudecode/toolUseId': 'model-call' } });
    assert.equal(result.isError, true);
  }
});

test('desktop executes through the same identity and mode authorization as original js', async t => {
  const {client,bind,prompts}=await fixture(t,{permissionMode:'auto'});
  const desktop=(id,args)=>client.callTool({name:'desktop',arguments:args,_meta:{'claudecode/toolUseId':id}});
  assert.equal((await desktop('missing',{})).isError,true);
  await bind('guide');assert.ok(!(await desktop('guide',{})).isError);
  await bind('metadata');const result=await desktop('metadata',{code:'original code'});
  const meta=JSON.parse(result.content[0].text)['x-codex-turn-metadata'];
  assert.equal(meta.session_id,'session');assert.equal(meta.call_id,'metadata');assert.equal(result.content[1].type,'image');
  for(const [index,mode] of ['auto','manual','dontAsk'].entries()) {
    const id=`desktop-${index}`;await bind(id,'prompt',mode);
    const response=await desktop(id,{code:'native-access'});
    assert.equal(JSON.parse(response.content[0].text).action,mode==='auto'?'accept':mode==='dontAsk'?'cancel':'decline');
  }
  assert.equal(prompts(),1);
});

test('interruption invalidates kernel bindings, preserves the retained target and waits for cleanup', async t => {
  const {client,bind,call}=await fixture(t,{browser:true,permissionMode:'auto'});
  const open=async id=>{
    const result=await client.callTool({name:'open_browser',arguments:{url:'https://example.com'},_meta:{'claudecode/toolUseId':id}});
    assert.ok(!result.isError,JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  await bind('first'); const first=await open('first');
  assert.equal(first.retained,true);
  await bind('wait');const controller=new AbortController();
  const pending=call('wait','wait',{signal:controller.signal,timeout:3000});
  setTimeout(()=>controller.abort(),80);await assert.rejects(pending);
  await bind('next','new-prompt');const next=await open('next');
  assert.equal(next.tab_id,first.tab_id);assert.equal(next.presented,true);assert.equal(next.retained,true);
  // A host-only interrupt can reset the kernel even without a cancelled call.
  await client.callTool({name:'turn_ended',arguments:{hook_event_name:'Interrupt',session_id:'session',turn_id:'new-prompt'}});
  await bind('after-hook','third-prompt');assert.equal((await open('after-hook')).tab_id,first.tab_id);
});
test('turn identities remain distinct and empty input fails closed', () => {
  const turns = new Turns(); assert.throws(() => turns.bind({}));
  turns.bind({ session_id: 's', turn_id: 'p', tool_use_id: 'a' });
  turns.bind({ session_id: 's', turn_id: 'p', tool_use_id: 'b', agent_id: 'child' });
  assert.notEqual(turns.take('a').life.turn_id, turns.take('b').life.turn_id);
});

test('auto and bypass modes perform repeated app/site access without any host dialog', async t => {
  for (const permissionMode of ['auto', 'bypassPermissions']) {
    const { bind, call, prompts } = await fixture(t, { permissionMode, capability: false });
    for (const [index, code] of ['browser-access', 'native-access', 'native-access'].entries()) {
      const id = `call-${index}`; await bind(id);
      assert.deepEqual(JSON.parse((await call(code, id)).content[0].text), { action: 'accept', content: {} });
    }
    assert.equal(prompts(), 0);
  }
});

test('switching Claude modes on the next call restores dialogs; dontAsk cancels without a dialog', async t => {
  const { bind, call, prompts } = await fixture(t);
  for (const [index, mode] of ['auto', 'manual', 'acceptEdits', 'plan', 'dontAsk', 'auto'].entries()) {
    const id = `mode-${index}`; await bind(id, 'same-prompt', mode);
    const response = JSON.parse((await call('native-access', id)).content[0].text);
    assert.equal(response.action, mode === 'auto' ? 'accept' : mode === 'dontAsk' ? 'cancel' : 'decline');
  }
  assert.equal(prompts(), 3);
});

test('auto resource consent does not accept a high-risk or separately named action approval', async t => {
  const { bind, call, prompts } = await fixture(t, { permissionMode: 'auto' });
  for (const [index, code] of ['high-risk-access', 'action-approval'].entries()) {
    const id = `risk-${index}`; await bind(id);
    assert.equal(JSON.parse((await call(code, id)).content[0].text).action, 'decline');
  }
  assert.equal(prompts(), 2);
});

test('automatic consent refuses another call identity and forms asking for data', () => {
  const metadata = { session_id:'s', turn_id:'t', call_id:'c' };
  const params = { mode:'form', requestedSchema:{type:'object',properties:{}}, _meta:{ connector_id:'computer-use',codex_approval_kind:'mcp_tool_call',riskLevel:'low',tool_params:{app:'notepad.exe'},'x-codex-turn-metadata':metadata } };
  assert.equal(automaticAccess(params, { permissionMode:'auto', metadata:{...metadata,call_id:'another-call'} }), null);
  assert.equal(automaticAccess({...params,requestedSchema:{type:'object',properties:{password:{type:'string'}}}}, { permissionMode:'auto', metadata }), null);
});
test('native consent accepts the real empty form response and never adds persistence', () => {
  const form = consentForm({ mode: 'form', message: 'Allow?', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', persist: ['session'] } });
  assert.deepEqual(form.request.requestedSchema, { type: 'object', properties: {} });
  assert.deepEqual(consentAnswer(form, { action: 'accept' }), { action: 'accept', content: {} });
  assert.deepEqual(consentAnswer(form, { action: 'accept', content: {}, _meta: { persist: 'always' } }), { action: 'accept', content: {} });
  assert.deepEqual(consentAnswer(form, { action: 'cancel' }), { action: 'cancel' });
  assert.equal(consentForm({ mode: 'form', requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } }), null);
});
test('a cancelled or unsupported host does not turn into an explicit decline', async t => {
  for (const options of [{ response: { action: 'cancel' } }, { capability: false }]) {
    const { bind, call } = await fixture(t, options);
    await bind(); assert.deepEqual(JSON.parse((await call('approval')).content[0].text), { action: 'cancel' });
  }
});
test('authorization UI failures preserve the original error and explain the missing decision', async t => {
  for (const options of [{ capability: false }, { hostError: true }]) {
    const { bind, call } = await fixture(t, options);
    await bind(); const result = await call('approval-error');
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'Original policy blocked this action.');
    assert.match(result.content[1].text, /没有收到用户的拒绝决定/);
  }
});
test('setup is repeatable, preserves unrelated settings, and removal keeps user hooks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-cu-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { existing: { command: 'existing' } } }));
  await setup(directory);
  const settingsPath = join(directory, '.claude/settings.local.json');
  const settings = JSON.parse(await readFile(settingsPath));
  settings.hooks.PreToolUse.push({ matcher: 'Read', hooks: [{ type: 'command', command: 'echo keep' }] });
  settings.hooks.Stop[0].hooks.push({ type: 'command', command: 'echo keep mixed' });
  settings.permissions.allow = ['Read']; settings.disabledMcpjsonServers = ['codex_cu']; await writeFile(settingsPath, JSON.stringify(settings));
  await setup(directory); await setup(directory);
  const installed = JSON.parse(await readFile(settingsPath));
  assert.equal(installed.hooks.PreToolUse.length, 2);
  assert.equal(installed.hooks.PreToolUse.find(entry => entry.matcher.includes('codex_cu')).hooks[0].input.permission_mode, '${permission_mode}');
  assert.ok(new RegExp(installed.hooks.PreToolUse.find(entry => entry.matcher.includes('codex_cu')).matcher).test('mcp__codex_cu__open_browser'));
  assert.ok(new RegExp(installed.hooks.PreToolUse.find(entry => entry.matcher.includes('codex_cu')).matcher).test('mcp__codex_cu__desktop'));
  assert.deepEqual(installed.disabledMcpjsonServers, ['codex_cu']);
  assert.equal((await setup(directory)).disabled, true);
  assert.equal(installed.hooks.SessionEnd, undefined);
  await setup(directory, { remove: true });
  const removed = JSON.parse(await readFile(settingsPath));
  assert.deepEqual(removed.hooks.PreToolUse, [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo keep' }] }]);
  assert.deepEqual(removed.permissions.allow, ['Read']);
  assert.equal(removed.hooks.Stop[0].hooks[0].command, 'echo keep mixed');
  assert.deepEqual(JSON.parse(await readFile(join(directory, '.mcp.json'))).mcpServers, { existing: { command: 'existing' } });
});
