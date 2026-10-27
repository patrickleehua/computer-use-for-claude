import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowsDesktop} from '../src/desktop.mjs';

test('desktop requires installed documentation before actions and fails without executing when missing', async () => {
  let calls=0;const invoke=async()=>{calls++;return {content:[]};};
  const missing=new WindowsDesktop();
  await assert.rejects(missing.call({},invoke),/未找到/);
  await assert.rejects(missing.call({code:'await sky.list_windows()'},invoke),/先调用 desktop/);
  const unreadable=new WindowsDesktop(['not-an-installed-guide.md']);
  await assert.rejects(unreadable.call({},invoke),/ENOENT/);assert.equal(calls,0);
});

test('native adapter preserves all original screenshot regions and errors, and never retries actions', async () => {
  const desktop=new WindowsDesktop([new URL(import.meta.url)]),programs=[];
  const output={content:[{type:'text',text:'two regions'},{type:'image',mimeType:'image/png',data:'region1'},{type:'image',mimeType:'image/png',data:'region2'}],_meta:{original:true}};
  const invoke=async args=>{programs.push(args);return output;};
  const guide=await desktop.call({},invoke);assert.match(guide.content[0].text,/multiple screenshot regions/);
  assert.strictEqual(await desktop.call({code:'await sky.get_window_state({window:targetWindow});'},invoke),output);
  assert.match(programs.at(-1).code,/import\("@oai\/sky"\)/);
  const error={isError:true,content:[{type:'text',text:'original failure'}]};let attempts=0;
  assert.strictEqual(await desktop.call({code:'await sky.click({window:targetWindow,x:1,y:1});'},async()=>{attempts++;return error;}),error);
  assert.equal(attempts,1);
});
