import { createServer } from 'node:http';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
const root = new URL('../.local/', import.meta.url);
await mkdir(root, { recursive: true });
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex CU MVP 验证页</title>
<style>body{font:20px system-ui;margin:60px;max-width:850px}textarea{display:block;width:650px;height:150px;font:22px system-ui}button{margin-top:20px;padding:12px 28px;font:20px system-ui}output{display:block;margin-top:24px;color:#17613a}</style>
<h1>Claude 使用 Codex 原版浏览器验证</h1><label for="note">测试内容</label><textarea id="note"></textarea><button id="save">保存测试内容</button><output id="result">尚未保存</output>
<script>document.querySelector('#save').onclick=async()=>{const note=document.querySelector('#note').value;const r=await fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note})});document.querySelector('#result').textContent=r.ok?'已保存：'+note:'保存失败';};</script></html>`;
const server = createServer(async (req, res) => {
  if (req.url === '/save' && req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const data = Buffer.concat(chunks).toString('utf8');
    await appendFile(new URL('saved-notes.jsonl', root), `${data}\n`);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"saved":true}');
  } else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); }
});
server.listen(Number(process.env.CODEX_CU_TEST_PORT || 0), '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  await writeFile(new URL('test-site.json', root), JSON.stringify({ url }));
  console.log(url);
});
