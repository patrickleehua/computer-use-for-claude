param()
$ErrorActionPreference = 'Stop'
# Install a packed copy. `npm install -g .` can create a link to the development
# checkout; packing first makes future use independent of this source folder.
$packageDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-cu-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $packageDirectory | Out-Null
Push-Location -LiteralPath $PSScriptRoot
try {
  $packOutput = & npm pack --json --pack-destination $packageDirectory
  if ($LASTEXITCODE -ne 0) { throw '打包失败，未修改用户接入。' }
  $packed = @($packOutput | ConvertFrom-Json)[0]
  $archive = Join-Path $packageDirectory $packed.filename
  & npm install --global $archive --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw '全局软件包安装失败，未注册 Claude 用户接入。' }
  $prefix = (& npm prefix --global).Trim()
  if ($LASTEXITCODE -ne 0) { throw '无法读取 npm 全局安装目录。' }
  $entry = Join-Path $prefix 'node_modules/codex-computer-use-for-claude-windows/src/cli.mjs'
  & node $entry install
  if ($LASTEXITCODE -ne 0) { throw '软件包已安装，但 Claude 用户接入未完成；修复后运行 codex-cu install 重试。' }
  Write-Host '完成。以后在任意项目直接运行 claude；无需再运行 start.ps1。'
} finally {
  Pop-Location
  # Remove only the precise archive created by this invocation; no recursive
  # deletion and no paths obtained from an untrusted workspace enumeration.
  if ($archive -and (Test-Path -LiteralPath $archive)) { Remove-Item -LiteralPath $archive }
  if ((Test-Path -LiteralPath $packageDirectory) -and @(Get-ChildItem -LiteralPath $packageDirectory).Count -eq 0) { Remove-Item -LiteralPath $packageDirectory }
}
