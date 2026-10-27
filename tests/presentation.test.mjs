import test from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './fixtures/browser.mjs';
import { BrowserPresenter } from '../src/presentation.mjs';

// Execute the production programs against a stateful original-API contract.
// No tabs.update(active), raw driver, or native input exists in this fixture.
const evidence = result => JSON.parse(result.content.at(-1).text);

test('an inactive background result becomes selected, focused, persistent; user tab stays in place', async () => {
  const env=environment(), presenter=new BrowserPresenter();
  const result=await presenter.open({url:'https://example.com'},env.invoke);
  assert.equal(result.isError,undefined);
  assert.equal(result.content.length,1); assert.ok(JSON.stringify(result).length<2000,'The visibility verdict must stay directly readable by Claude');
  const state=evidence(result);
  assert.equal(state.presented,true); assert.equal(state.active,true); assert.equal(state.focused,true); assert.equal(state.window_state,'normal');
  assert.equal(state.retained,true);
  assert.equal(typeof state.tab_id,'string'); assert.equal(Number(state.tab_id),state.provider_tab_id);
  assert.equal(env.tabs.get(1).windowId,1); assert.equal(env.tabs.get(1).url,'https://user.example/');
  assert.deepEqual(env.marks,[state.provider_tab_id]);
});

test('repeated open restores a minimized owned window without a duplicate, and re-marks the next turn', async () => {
  const env=environment(), presenter=new BrowserPresenter();
  const first=evidence(await presenter.open({url:'https://example.com'},env.invoke));
  env.windows.get(first.window_id).state='minimized'; env.windows.get(first.window_id).focused=false;
  const second=evidence(await presenter.open({url:'https://example.com/'},env.invoke));
  assert.equal(second.presented,true); assert.equal(second.tab_id,first.tab_id); assert.equal(second.window_id,first.window_id); assert.equal(second.window_state,'normal');
  assert.equal(env.mutations.filter(m=>m.type==='create').length,1); assert.equal(env.marks.length,2);
});

test('closed or repurposed result is not reused; a new page is shown without overwriting user work', async () => {
  const env=environment(), presenter=new BrowserPresenter();
  const first=evidence(await presenter.open({url:'https://example.com'},env.invoke));
  env.tabs.get(first.provider_tab_id).url='https://user-changed.example/';
  const second=evidence(await presenter.open({url:'https://example.com'},env.invoke));
  assert.notEqual(second.tab_id,first.tab_id); assert.equal(env.tabs.get(first.provider_tab_id).url,'https://user-changed.example/');
  env.tabs.delete(second.provider_tab_id);
  const third=evidence(await presenter.open({url:'https://example.com'},env.invoke));
  assert.notEqual(third.tab_id,second.tab_id); assert.equal(third.presented,true);
});

test('failed focus and unavailable original capability fail explicitly without claiming success', async () => {
  for(const options of [{refuseFocus:true},{missingCapability:true}]) {
    const env=environment(options), presenter=new BrowserPresenter();
    const result=await presenter.open({url:'https://example.com'},env.invoke);
    assert.equal(result.isError,true); assert.equal(evidence(result).presented,false); assert.equal(env.marks.length,0);
  }
});

test('stopping between original calls does not focus, retain or replay a page', async () => {
  const env=environment(), presenter=new BrowserPresenter(); let calls=0;
  const result=await presenter.open({url:'https://example.com'},async code=>{if(++calls===4) throw Error('本轮已停止'); return env.invoke(code);});
  assert.equal(result.isError,true); assert.equal(evidence(result).presented,false); assert.equal(calls,4);
  assert.equal(env.mutations.filter(m=>m.type==='focus'||m.type==='move').length,0); assert.equal(env.marks.length,0);
});

test('reset discards handles/ownership and invalid URLs do not invoke any original API', async () => {
  const env=environment(), presenter=new BrowserPresenter();
  for(const url of ['file:///C:/secret','javascript:alert(1)','https://user:password@example.com','not a url']) assert.equal((await presenter.open({url},env.invoke)).isError,true);
  assert.equal(env.programs.length,0);
  const first=evidence(await presenter.open({url:'https://example.com'},env.invoke));
  presenter.reset();
  const second=evidence(await presenter.open({url:'https://example.com'},env.invoke));
  assert.notEqual(first.tab_id,second.tab_id); assert.equal(second.presented,true);
});

test('kernel invalidation rebinds a retained result without repeating creation or losing its window', async () => {
  const env=environment(),presenter=new BrowserPresenter();
  const first=evidence(await presenter.open({url:'https://example.com'},env.invoke));
  env.resetKernel();presenter.invalidateKernel();
  const next=evidence(await presenter.open({url:'https://example.com'},env.invoke));
  assert.equal(next.tab_id,first.tab_id);assert.equal(next.window_id,first.window_id);
  assert.equal(next.retained,true);assert.equal(env.mutations.filter(m=>m.type==='create').length,1);
});
