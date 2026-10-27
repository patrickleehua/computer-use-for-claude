import { readFile } from 'node:fs/promises';

export const DESKTOP_GUIDANCE = 'For Windows native apps, use desktop instead of cua.getApp. Call desktop with no code first and read the installed original Sky documentation. It supports activation, weak accessibility and multiple screenshot regions such as file dialogs. The desktop code uses sky, the original @oai/sky API, in the same original kernel and permission/lifecycle context as js. After interruption/reset, re-list windows and observe before any input; previous bindings and coordinates are stale. Perform one input then refresh and inspect before deciding the next input. In particular, click the editable surface and refresh to verify focus before typing; do not batch click, select-all and type. Select exactly one returned window by task/title, never windows[0]. If a minimized window cannot be observed and activate_window also requests a fresh observation, stop retrying that window. For an authorized OPEN FILE task, you may use the documented launch_app once to create a fresh task window; compare before/after window IDs, select only the unique new window, observe it, then open the requested file via its UI. Preserve old windows and unsaved documents. This is not recovery for a policy denial, stopped turn, or a request to continue a specific existing document; those must stop or report the blocker. Browser work continues to use open_browser/js and the original Chrome extension.';

export const desktopTool = {
  name: 'desktop',
  description: `Operate Windows native apps using the locally installed original OpenAI Sky API. ${DESKTOP_GUIDANCE} Screenshots are already emitted as image blocks: inspect all returned regions and use the matching screenshotId. A returned window ID alone does not prove that its image shows the right app. If the image shows another app, do not input; activate the exact selected window, refresh and verify once, then stop if still wrong. Never flatten regions to a single screenshot, require accessibility when unavailable, or blindly retry an input. Code must use only documented Sky UI APIs; no shell, filesystem or alternate automation.`,
  inputSchema: { type: 'object', properties: {
    code: { type: 'string', description: 'Omit to read original native documentation first. Then use the documented sky API; sky is initialized for each call.' },
    title: { type: 'string' },
    timeout_ms: { type: 'integer', minimum: 1 },
  }, additionalProperties: false },
};

// No new desktop driver or helper process: the installed original Sky service
// executes inside the very same original runtime, with identical call metadata.
export class WindowsDesktop {
  constructor(documentationPaths = []) { this.documentationPaths = documentationPaths; this.documented = false; }
  async call(args, invoke) {
    if (args.code !== undefined && typeof args.code !== 'string') throw Error('desktop code 必须为 JavaScript 字符串。');
    if (args.code === undefined) {
      if (!this.documentationPaths.length) throw Error('未找到与运行时匹配的原版 Windows Computer Use 文档。请更新 Codex 后重新连接。');
      const docs = await Promise.all(this.documentationPaths.map(path => readFile(path, 'utf8')));
      // Consume CUA's initial façade docs here; the native caller needs Sky's
      // installed window2 documentation, not the façade's single-image contract.
      const initialized = await invoke({ code: 'var sky = (await import("@oai/sky")).sky;', title: '加载原版 Windows 桌面能力' });
      if (initialized.isError) return initialized;
      this.documented = true;
      return { content: [{ type: 'text', text: `${DESKTOP_GUIDANCE}\n\n${docs.join('\n\n')}` }] };
    }
    if (!this.documented) throw Error('请先调用 desktop（不传 code），读取本机原版 Windows 操作规范及 API。尚未执行任何桌面操作。');
    // Re-import is cached and has no UI side effects. It restores only the API
    // binding after kernel cancellation; never repeat an action on failure.
    return invoke({ ...args, code: `var sky = (await import("@oai/sky")).sky;\n${args.code}` });
  }
}
