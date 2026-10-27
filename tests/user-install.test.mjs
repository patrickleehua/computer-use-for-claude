import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installUser } from '../src/user-install.mjs';
import { bridgeHooks } from '../src/setup.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('the packaged CLI entry runs from an unrelated directory and reports its package version',async()=>{
  const entry=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const {stdout}=await promisify(execFile)(process.execPath,[entry,'--version'],{cwd:tmpdir(),windowsHide:true});
  assert.equal(stdout.trim(),pkg.version);assert.equal(pkg.bin['codex-cu'],'src/cli.mjs');
});

async function environment(t) {
  const directory=await mkdtemp(join(tmpdir(),'codex-cu-user-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const paths={mcpPath:join(directory,'.claude.json'),settingsPath:join(directory,'.claude/settings.json')};
  await mkdir(join(directory,'.claude'));
  const config={projects:{'D:/user-project':{hasTrustDialogAccepted:true}},mcpServers:{other:{command:'other'}}};
  const settings={model:'keep-model',env:{EXAMPLE:'keep-value'},hooks:{PreToolUse:[{matcher:'Read',hooks:[{type:'command',command:'keep'}]}]},permissions:{allow:['Read'],deny:['Bash(danger)']},disabledMcpjsonServers:['codex_cu']};
  await writeFile(paths.mcpPath,JSON.stringify(config));await writeFile(paths.settingsPath,JSON.stringify(settings));
  const spec={type:'stdio',command:process.execPath,args:[join(directory,'installed package/src/bridge.mjs')]},commands=[];
  const runClaude=async args=>{
    commands.push(args);assert.equal(args[3],'user');assert.equal(args[4],'codex_cu');
    const current=JSON.parse(await readFile(paths.mcpPath,'utf8'));
    if(args[1]==='add-json')current.mcpServers.codex_cu=JSON.parse(args[5]);else delete current.mcpServers.codex_cu;
    await writeFile(paths.mcpPath,JSON.stringify(current));
  };
  return{directory,paths,spec,runClaude,commands,config,settings};
}

test('user install is repeatable, updates only its own hooks and uninstalls without losing user settings',async t=>{
  const env=await environment(t);
  await installUser(env);await installUser(env);assert.equal(env.commands.length,1);
  let config=JSON.parse(await readFile(env.paths.mcpPath,'utf8'));
  assert.deepEqual(config,{...env.config,mcpServers:{...env.config.mcpServers,codex_cu:env.spec}});
  const settings=JSON.parse(await readFile(env.paths.settingsPath,'utf8'));
  for(const key of ['model','env','disabledMcpjsonServers'])assert.deepEqual(settings[key],env.settings[key]);
  assert.deepEqual(settings.permissions.allow,['Read']);assert.ok(settings.permissions.deny.includes('Bash(danger)'));
  assert.equal(settings.hooks.PreToolUse.length,2);
  // Model a mixed group and stale previously installed hooks during upgrade.
  settings.hooks.Stop[0].hooks.push({type:'command',command:'keep stop'});
  await writeFile(env.paths.settingsPath,JSON.stringify(settings));await installUser(env);
  const upgraded=JSON.parse(await readFile(env.paths.settingsPath,'utf8'));
  assert.deepEqual(upgraded.hooks.Stop.find(x=>x.hooks[0].type==='mcp_tool'),bridgeHooks().Stop[0]);
  await installUser({...env,remove:true});await installUser({...env,remove:true});
  config=JSON.parse(await readFile(env.paths.mcpPath,'utf8'));assert.deepEqual(config,env.config);
  const removed=JSON.parse(await readFile(env.paths.settingsPath,'utf8'));
  assert.deepEqual(removed.hooks.PreToolUse,env.settings.hooks.PreToolUse);
  assert.deepEqual(removed.hooks.Stop,[{hooks:[{type:'command',command:'keep stop'}]}]);
  assert.deepEqual(removed.permissions,env.settings.permissions);assert.deepEqual(removed.env,env.settings.env);
});

test('conflicting user MCP and malformed user hooks/JSON fail before any write or CLI call',async t=>{
  for(const problem of ['conflict','json','hooks','hookGroup']){
    const env=await environment(t);
    if(problem==='conflict')await writeFile(env.paths.mcpPath,JSON.stringify({...env.config,mcpServers:{codex_cu:{command:'someone-else',args:[]}}}));
    if(problem==='json')await writeFile(env.paths.settingsPath,'{bad JSON');
    if(problem==='hooks')await writeFile(env.paths.settingsPath,JSON.stringify({hooks:{Stop:{broken:true}}}));
    if(problem==='hookGroup')await writeFile(env.paths.settingsPath,JSON.stringify({hooks:{Stop:[{hooks:'broken'}]}}));
    const before=await Promise.all(Object.values(env.paths).map(path=>readFile(path,'utf8')));
    await assert.rejects(installUser(env));
    assert.deepEqual(await Promise.all(Object.values(env.paths).map(path=>readFile(path,'utf8'))),before);
    assert.equal(env.commands.length,0);
  }
});

test('a concurrent settings change aborts install and removes only the newly added own server',async t=>{
  const env=await environment(t),concurrent={...env.settings,newUserValue:'preserve'};
  const runClaude=async args=>{await env.runClaude(args);if(args[1]==='add-json')await writeFile(env.paths.settingsPath,JSON.stringify(concurrent));};
  await assert.rejects(installUser({...env,runClaude}),/其他程序修改/);
  assert.deepEqual(JSON.parse(await readFile(env.paths.mcpPath,'utf8')),env.config);
  assert.deepEqual(JSON.parse(await readFile(env.paths.settingsPath,'utf8')),concurrent);
});

test('registration failure leaves user settings untouched and unconfirmed success never writes hooks',async t=>{
  const env=await environment(t),before=await readFile(env.paths.settingsPath,'utf8');
  await assert.rejects(installUser({...env,runClaude:async()=>{throw Error('CLI unavailable');}}),/CLI unavailable/);
  assert.equal(await readFile(env.paths.settingsPath,'utf8'),before);
  await assert.rejects(installUser({...env,runClaude:async()=>{}}),/未确认/);
  assert.equal(await readFile(env.paths.settingsPath,'utf8'),before);
});
