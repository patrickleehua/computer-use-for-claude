import { randomUUID } from 'node:crypto';

export const openBrowserTool = {
  name: 'open_browser',
  description: 'Open and SHOW a website to the user in their real Chrome, using the original Codex extension. Use this tool by default when the user says open/show a website (打开网页), instead of js goto/createBrowserTab. It selects the result tab, restores/focuses its window, verifies active + focused + non-minimized, and keeps the page after the turn. A background DOM/screenshot alone is NOT success. Repeated opens reuse this bridge\'s unchanged result tab; inactive agent-created result tabs get a separate window. Read the actual URL/title and presented result before reporting success. Use js for further page interaction or background research.',
  inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Full http:// or https:// URL requested by the user.' } }, required: ['url'], additionalProperties: false },
};

// Only documented APIs on the installed original runtime are executed here.
// No browser driver, JS rewriting, runtime monkeypatch, or user-tab relocation.
export class BrowserPresenter {
  constructor() {
    this.variable = `codexCuPresentation_${randomUUID().replaceAll('-', '')}`;
    this.reset();
  }
  reset() { this.ready = false; this.owned = new Map(); }
  // Interrupt resets the original JS kernel, but retained pages still exist.
  // Rebind them from verified tab IDs instead of losing ownership or replaying.
  invalidateKernel() { this.ready = false; }

  async open(input, invoke) {
    const content = [];
    let requested;
    const marker = `CODEX_CU_PRESENTATION_${randomUUID()} `;
    const ref = this.variable;
    const write = expression => `nodeRepl.write(${JSON.stringify(marker)} + JSON.stringify(${expression}));`;
    const run = async (code, evidence = false) => {
      const result = await invoke(code);
      content.push(...(result.content || []));
      if (result.isError) throw Error('原版浏览器操作失败，未确认页面显示。');
      if (!evidence) return;
      const line = (result.content || []).filter(c => c.type === 'text').flatMap(c => c.text.split('\n')).find(line => line.startsWith(marker));
      if (!line) throw Error('原版运行时没有返回窗口验证结果，不能宣告已显示。');
      return JSON.parse(line.slice(marker.length));
    };
    try {
      if (typeof input.url !== 'string' || Object.keys(input).some(key => key !== 'url')) throw Error('请提供一个完整的 http(s) 网页地址。');
      const url = new URL(input.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('只支持不含登录凭据的 http(s) 网页地址。');
      requested = url.href;
      if (!this.ready) {
        // One documented entry point in the first call; inspect its docs before
        // obtaining the documented management capability in a separate call.
        await run(`var ${ref} = { browser: await cua.getBrowser({ id: 'chrome' }) };`);
        await run(`${ref}.management = await ${ref}.browser.capabilities.get('management'); nodeRepl.write(await ${ref}.management.documentation());`);
        this.ready = true;
      }
      const owned = this.owned.get(requested);
      let existing;
      if (owned) {
        existing = await run(`${ref}.existing = (await ${ref}.management.tabs.query({})).find(t => t.id === ${owned.id} && t.url === ${JSON.stringify(owned.url)}) || null; ${write(`${ref}.existing && {id:${ref}.existing.id}`)}`, true);
      }
      if (existing) {
        await run(`${ref}.tab = await cua.getTab(${JSON.stringify(String(existing.id))}, { browser: ${ref}.browser.browserId });`);
      } else {
        const created = await run(`${ref}.tab = await cua.createBrowserTab(${ref}.browser.browserId, ${JSON.stringify(requested)}, { sessionName: '🌐 打开网页' }); ${ref}.info = (await ${ref}.management.tabs.query({})).find(t => String(t.id) === ${ref}.tab.id); if (!${ref}.info) throw Error('Cannot correlate the created tab with the original extension.'); ${write(`{id:${ref}.info.id,url:${ref}.info.url}`)}`, true);
        if (!Number.isSafeInteger(created.id) || created.id < 0) throw Error('原版扩展返回了无法验证的标签标识。');
        this.owned.set(requested, created);
      }
      const id = this.owned.get(requested).id;
      // tabs.update({active:true}) is explicitly unavailable in this runtime.
      // Move only our exact created result tab when it is inactive. Focusing an
      // already selected tab preserves its current window and maximized state.
      const state = await run(`${ref}.info = await ${ref}.management.tabs.get(${id});
if (!${ref}.info.active) await ${ref}.management.windows.create({ tabId: ${id}, focused: true });
${ref}.info = await ${ref}.management.tabs.get(${id});
${ref}.window = await ${ref}.management.windows.get(${ref}.info.windowId, { populate: false });
await ${ref}.management.windows.update(${ref}.info.windowId, { focused: true, ...(${ref}.window.state === 'minimized' ? {state:'normal'} : {}) });
${ref}.info = await ${ref}.management.tabs.get(${id});
${ref}.window = await ${ref}.management.windows.get(${ref}.info.windowId, { populate: false });
${write(`{tab_id:${ref}.info.id,window_id:${ref}.window.id,url:${ref}.info.url,title:${ref}.info.title,active:${ref}.info.active,focused:${ref}.window.focused,window_state:${ref}.window.state}`)}`, true);
      const presented = state.tab_id === id && state.active === true && state.focused === true && ['normal', 'maximized', 'fullscreen'].includes(state.window_state);
      if (!presented) throw Error('网页可能在后台，但原版扩展未确认标签选中、窗口前台和非最小化，不能报告已显示。');
      // Re-mark each turn. A surviving background page alone is not completion.
      await run(`await ${ref}.tab.markDeliverable();`);
      // Bootstrap docs are consumed by this fixed adapter. Returning them here
      // makes Claude persist the entire result, hiding the actual verdict.
      // Raw js still relays original outputs; explicitly reload its docs before
      // using it after the adapter initialized the shared original kernel.
      return { content: [{ type: 'text', text: JSON.stringify({ presented: true, requested_url: requested, ...state,
        tab_id: String(state.tab_id), provider_tab_id: state.tab_id,
        retained: true,
        retention: 'Marked as a deliverable. This page stays open after this turn and bridge exit; do not tell the user it may be automatically closed at turn end.',
        js_guidance: 'Before further raw js interaction, use a separate call: await cua.rewriteDocumentation(); Read its documentation. Next bind this exact string tab_id with js_bind_code. Browser input requires a fresh AX element index as the first argument. Re-mark a result tab when using it in a later turn.',
        js_bind_code: `var page = await cua.getTab(${JSON.stringify(String(state.tab_id))}, { browser: 'chrome' }); await page.getAXState();`,
        js_input_example: 'await page.paste(elementIndexFromFreshAX, "text"); await page.getAXState(); // Or page.typeText(elementIndexFromFreshAX, "text"). Use null as the first argument only to target current focus.' }) }] };
    } catch (error) {
      content.push({ type: 'text', text: JSON.stringify({ presented: false, requested_url: requested, error: error.message }) });
      return { isError: true, content };
    }
  }
}
