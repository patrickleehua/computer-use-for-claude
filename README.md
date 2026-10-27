# Codex Computer Use for Claude — Windows

让 Claude Code 使用本机 OpenAI 原版桌面与 Chrome 扩展能力。Claude 负责推理，桥接负责转发工具调用，不调用 Codex 模型，也不安装替代桌面驱动。

当前版本 **0.1.4**。仅支持并实测 **Windows x64 + Claude Code**；macOS、Linux、Windows ARM64 及 Claude Desktop 尚未适配或验收。

## 安装与使用

需要 Node.js 22+、已登录的 Claude Code，以及保持运行的 Codex 桌面应用。在 Codex 中启用 Computer Use 和 Chrome 插件，并在 Chrome 安装 OpenAI 原版扩展。

在源码目录安装一次：

```powershell
.\install.ps1
```

以后在任意项目目录直接运行：

```powershell
claude
```

在 Claude 中说：

> 使用 codex_cu 打开 YouTube。
>
> 打开这个 GitLab Job 链接，读取失败日志并分析 CI 报错。
>
> 使用 codex_cu，通过记事本界面打开指定测试文件，输入中文并保存。

安装器将独立软件包安装到 npm 全局目录，注册 Claude 用户级 MCP 和 hooks。移动源码目录不影响已安装副本；已有 Claude 会话需重启。升级时在新版源码目录重新运行 `install.ps1`。

项目明确禁用或覆盖同名服务的设置继续有效，在 `/mcp` 中检查 `codex_cu`。旧项目若要迁移到用户级接入，在该项目运行 `codex-cu remove .`；它只移除本桥接的项目注册与 hooks。`--strict-mcp-config` 或排除用户设置的 `--setting-sources` 会屏蔽用户级接入。

只想给单个项目接入时，仍可运行 `start.ps1`，或 `start.ps1 -Project 'D:\your-project'`。

## 工具和权限

| 工具 | 用途 |
|---|---|
| `open_browser` | 打开网页、恢复并聚焦结果窗口；核对可见状态后返回 `presented:true`，标记保留后返回 `retained:true` |
| `js` | 通过原版 Chrome 扩展读取和操作页面 |
| `desktop` | 读取已安装的原版文档，再用同一内核中的 `@oai/sky` 操作 Windows 应用；保留模态窗口的多张截图 |
| `js_reset` | 重置共享 JavaScript 内核 |

授权跟随每次调用时 Claude 的实际模式，不修改默认模式，不保存长期访问授权。

| Claude 模式 | 普通网站、低风险应用访问 |
|---|---|
| `auto` / `bypassPermissions` | 自动应答，普通连续操作无需反复确认 |
| `manual` / `default` / `acceptEdits` / `plan` | 保留交互确认；计划模式的执行限制仍由 Claude 控制 |
| `dontAsk` | 需要额外授权时取消，不弹框 |
| 未知或缺失模式 | 回退到交互确认 |

手动授权框中 Accept 允许本次、Decline 拒绝、Esc 取消。其他动作确认和原版策略拒绝继续生效，不通过其他路径绕过。

结果网页会保留；临时调研页遵循原版回合清理。Chrome 的“正在控制”提示在回答后消失，表示本轮接管结束，MCP 连接仍可供下一轮使用。中止后旧任务不续跑，新任务重新观察并绑定现有页面，不自动重放输入或保存。

## 诊断与卸载

```powershell
codex-cu --version
codex-cu status
codex-cu doctor
codex-cu uninstall
npm uninstall --global codex-computer-use-for-claude-windows
```

先运行 `codex-cu uninstall` 移除用户级接入，再卸载软件包。其他 MCP、hooks、模型设置与项目配置保留。安装或移除仅更新本桥接注册，用户设置合并写入；配置冲突、格式错误或检测到并发改动时停止。

用户级 MCP 通过官方 CLI 注册，hooks 位于 `~/.claude/settings.json`；设置 `CLAUDE_CONFIG_DIR` 时跟随该独立配置目录。参考：[MCP 配置作用域](https://code.claude.com/docs/en/mcp)、[hooks](https://code.claude.com/docs/en/hooks)。

诊断日志位于 `%LOCALAPPDATA%\codex-cu\logs`，只记录版本、耗时、图片数量、授权回应和清理状态，不记录页面内容、代码或截图。`CODEX_CU_LOG` 可指定日志路径，`CODEX_HOME` 可指定现有 Codex 数据目录。

## 开发与验证

```powershell
npm ci
npm test
node scripts/test-site.mjs
```

测试页只监听 `127.0.0.1`，打印实际地址；测试数据写入被忽略的 `.local/`。运行时从本机安装元数据中发现，不分发 OpenAI 二进制或文档。当前验证范围和遗留限制见 [验证记录](docs/verification.md)。

桌面操作需要解锁 Windows 并使用前台。某些既有最小化窗口存在原版观察/激活相互阻塞；新文件任务可用原版 API 创建专用窗口，要求继续特定旧窗口或未保存文档时不能擅自换目标。截图若显示其他应用，必须停止输入并重新观察。真人终端授权按钮及其他 Claude 宿主尚未完成本轮验收。

截图和界面文字会返回 Claude，可能发送到你配置的模型提供方。原版组件遵循其自身许可；本项目不修改扩展、Native Messaging 注册、浏览器 Profile、Cookies 或 Codex 配置。
