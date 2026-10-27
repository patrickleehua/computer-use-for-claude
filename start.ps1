param([string]$Project = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$Project = (Resolve-Path -LiteralPath $Project).Path
Push-Location -LiteralPath $PSScriptRoot
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '需要 Node.js 22 或更新版本。' }
  if (-not (Test-Path -LiteralPath 'node_modules/@modelcontextprotocol/sdk/package.json')) {
    npm ci --no-fund
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
  }
  node src/cli.mjs doctor
  if ($LASTEXITCODE -ne 0) { throw '请先打开 Codex，并启用 Computer Use 和 Chrome 插件。' }
  node src/cli.mjs setup $Project
  if ($LASTEXITCODE -ne 0) { throw '项目配置失败。' }
} finally { Pop-Location }
$claudeCommand = Get-Command claude -ErrorAction SilentlyContinue
$claudeEntry = if ($claudeCommand) { $claudeCommand.Source } else { Join-Path $env:APPDATA 'npm/claude.ps1' }
if (-not (Test-Path -LiteralPath $claudeEntry)) { throw '请先安装并登录 Claude Code。' }
Push-Location -LiteralPath $Project
try {
  Write-Host '配置已准备。进入 Claude 后用 /mcp 确认 codex_cu 已启用并连接。'
  Write-Host '授权跟随 Claude 当前模式：auto 自动处理普通访问；手动模式显示授权框；dontAsk 不弹框。'
  Write-Host '可输入：打开 google.com。网页会切到前台，并在任务结束后保留。'
  & $claudeEntry --no-chrome --mcp-config (Join-Path $Project '.mcp.json')
} finally { Pop-Location }
