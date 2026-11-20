<#
.SYNOPSIS
  One-shot Windows full-stack deployment for ZeroG Code:
  Node.js check -> Antigravity CLI (agy) check & auto-install -> build/use VS Code / Cursor VSIX
  -> deploy & start local Web Bridge (~/.gemini/web-bridge) + Chrome MV3 extension
  -> register gemini-web-agent MCP -> verify agy sign-in & Chrome Extension connection.
.PARAMETER RepoDir
  Path to the cloned ZeroG-Code repository root. Auto-detected if run from inside the repo.
.PARAMETER AutoClone
  If RepoDir cannot be found locally, clone https://github.com/orinplin99-maker/ZeroG-Code-release.git automatically.
.PARAMETER Editor
  Editor CLI(s) to install into: code, cursor, or code,cursor. Default: code.
.PARAMETER InstallAgy
  Deprecated compatibility alias (agy CLI is now auto-installed by default when missing).
.PARAMETER NoInstallAgy
  Do not auto-install Antigravity CLI (agy) when missing; fail with exit code 2 instead.
.PARAMETER UsePrebuilt
  Install the prebuilt dist/zerog-code-<ver>.vsix directly instead of rebuilding from source.
.PARAMETER SkipAuthCheck
  Skip the "agy -p /usage" sign-in verification.
.PARAMETER SkipVsCode
  Skip building and installing the VS Code / Cursor extension.
.PARAMETER SkipWebBridge
  Skip deploying and starting the local Web Bridge daemon & Chrome extension files.
.PARAMETER SkipMcp
  Skip registering the gemini-web-agent MCP server in ~/.gemini/config/mcp_config.json.
.PARAMETER InstallSkill
  Copy this zerog-code-deploy skill into ~/.gemini/config/skills/ (and ~/.claude/skills/ if present).
.PARAMETER OpenChromeExt
  Open File Explorer at ~/.gemini/web-bridge/chrome-extension and open Chrome at chrome://extensions.
.NOTES
  Exit codes:
    0 = ok (all components deployed and agy signed in)
    1 = Node.js (>=18) missing
    2 = agy CLI missing or auto-install failed
    3 = all components deployed, but agy is not signed in yet (interactive login required)
    4 = VSIX build / lookup failed
    5 = VS Code / Cursor install verification failed
    6 = Local Web Bridge failed to start
    7 = ZeroG-Code repository not found
#>
param(
  [string]$RepoDir = '',
  [switch]$AutoClone,
  [string]$Editor = 'code',
  [switch]$InstallAgy,
  [switch]$NoInstallAgy,
  [switch]$UsePrebuilt,
  [switch]$SkipAuthCheck,
  [switch]$SkipVsCode,
  [switch]$SkipWebBridge,
  [switch]$SkipMcp,
  [switch]$InstallSkill,
  [switch]$OpenChromeExt
)

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/orinplin99-maker/ZeroG-Code-release.git'

function Ok($m)   { Write-Host "[OK]   $m" -ForegroundColor Green }
function Info($m) { Write-Host "[..]   $m" }
function Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Fail($m, $code) { Write-Host "[FAIL] $m" -ForegroundColor Red; exit $code }

function Find-GitExe {
  $c = Get-Command git -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
    'C:\Program Files\Git\cmd\git.exe',
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe",
    'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe',
    'C:\Program Files (x86)\Git\cmd\git.exe'
  )) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Test-ZeroGRepo($dir) {
  if (-not $dir -or -not (Test-Path $dir)) { return $false }
  if (-not (Test-Path (Join-Path $dir 'web-bridge\server.mjs'))) { return $false }
  if (Test-Path (Join-Path $dir 'package.json')) { return $true }
  if (Test-Path (Join-Path $dir 'release.json')) { return $true }
  $distDir = Join-Path $dir 'dist'
  if (Test-Path $distDir) {
    $vsix = Get-ChildItem -Path $distDir -Filter 'zerog-code-*.vsix' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($vsix) { return $true }
  }
  return $false
}

# ── 0. Locate ZeroG-Code repository root ─────────────────────
$candidates = @()
if ($RepoDir) { $candidates += $RepoDir }
$skillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$parentGuess = Split-Path -Parent (Split-Path -Parent $skillRoot)
if ($parentGuess) { $candidates += $parentGuess }
$candidates += @(
  (Get-Location).Path,
  (Join-Path $env:USERPROFILE '.gemini\zerog-code-release'),
  (Join-Path $env:USERPROFILE '.gemini\zerog-code'),
  (Join-Path $env:USERPROFILE '.gemini\config\skills\agy-tabs-setup\package')
)

$resolvedRepo = ''
foreach ($c in $candidates) {
  if (Test-ZeroGRepo $c) {
    $resolvedRepo = (Resolve-Path $c).Path
    break
  }
}

if (-not $resolvedRepo) {
  if ($AutoClone) {
    $gitExe = Find-GitExe
    if (-not $gitExe) { Fail "git.exe not found; clone $RepoUrl manually and pass -RepoDir <path>." 7 }
    $cloneTarget = if ($RepoDir) { $RepoDir } else { Join-Path $env:USERPROFILE '.gemini\zerog-code' }
    Info "Cloning $RepoUrl into $cloneTarget ..."
    & $gitExe clone $RepoUrl $cloneTarget
    if (-not (Test-ZeroGRepo $cloneTarget)) { Fail "Cloned repo missing expected files at $cloneTarget" 7 }
    $resolvedRepo = (Resolve-Path $cloneTarget).Path
  } else {
    Fail "ZeroG-Code repository not found. Pass -RepoDir <path> or re-run with -AutoClone to clone $RepoUrl." 7
  }
}
Ok "repo: $resolvedRepo"

# ── 1. Check Node.js (>= 18) ─────────────────────────────────
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Fail "Node.js (>= 18) is required for Web Bridge and MCP helper. Install via: winget install OpenJS.NodeJS.LTS" 1
}
$nodeVerRaw = (& $nodeCmd.Source -v 2>$null).Trim()
$nodeMajor = 0
if ($nodeVerRaw -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 18) {
  Fail "Node.js $nodeVerRaw is too old (need >= 18). Upgrade via: winget install OpenJS.NodeJS.LTS" 1
}
Ok "node: $nodeVerRaw ($($nodeCmd.Source))"

# ── 2. Check & Auto-Install Antigravity CLI (agy) ────────────
function Find-Agy {
  $c = Get-Command agy -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
    "$env:LOCALAPPDATA\agy\bin\agy.exe",
    "$env:LOCALAPPDATA\Programs\agy\agy.exe",
    "$env:LOCALAPPDATA\Programs\antigravity-cli\agy.exe",
    "$env:USERPROFILE\.local\bin\agy.exe",
    "$env:USERPROFILE\.antigravity\bin\agy.exe"
  )) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

$agyFreshlyInstalled = $false
$agy = Find-Agy
if (-not $agy) {
  if ($NoInstallAgy) {
    Fail "agy CLI not found (-NoInstallAgy specified). Install manually: irm https://antigravity.google/cli/install.ps1 | iex" 2
  }
  Info 'Antigravity CLI (agy) not found — auto-installing via official installer...'
  try {
    Invoke-RestMethod https://antigravity.google/cli/install.ps1 | Invoke-Expression
  } catch {
    Fail "Auto-installing agy CLI failed: $_. Check network/proxy or install manually: irm https://antigravity.google/cli/install.ps1 | iex" 2
  }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $agy = Find-Agy
  if (-not $agy) {
    Fail 'agy CLI still not found after official install (open a new terminal and retry, or check PATH).' 2
  }
  $agyFreshlyInstalled = $true
  Ok "agy CLI auto-installed: $agy"
} else {
  Ok "agy: $agy"
}

# ── 3. Build / Use & Install ZeroG Code VS Code / Cursor Extension ─
if (-not $SkipVsCode) {
  $pkgPath = Join-Path $resolvedRepo 'package.json'
  $relPath = Join-Path $resolvedRepo 'release.json'
  $distOut = Join-Path $resolvedRepo 'dist'
  $buildScript = Join-Path $resolvedRepo 'scripts\build_vsix.ps1'

  $extName = 'zerog-code'
  $extPublisher = 'orinplin99-maker'
  $extVersion = ''
  $prebuiltVsix = ''

  if (Test-Path $pkgPath) {
    $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $extName = [string]$pkg.name
    $extPublisher = [string]$pkg.publisher
    $extVersion = [string]$pkg.version
    $prebuiltVsix = Join-Path $distOut "$extName-$extVersion.vsix"
  } elseif (Test-Path $relPath) {
    $relMeta = Get-Content $relPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($relMeta.name) { $extName = [string]$relMeta.name }
    if ($relMeta.publisher) { $extPublisher = [string]$relMeta.publisher }
    if ($relMeta.version) { $extVersion = [string]$relMeta.version }
    $prebuiltVsix = if ($relMeta.vsix) { Join-Path $resolvedRepo ([string]$relMeta.vsix) } else { Join-Path $distOut "$extName-$extVersion.vsix" }
  } else {
    $foundVsix = Get-ChildItem -Path $distOut -Filter 'zerog-code-*.vsix' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($foundVsix) {
      $prebuiltVsix = $foundVsix.FullName
      if ($foundVsix.Name -match '^(.+)-(\d+\.\d+\.\d+)\.vsix$') {
        $extName = $Matches[1]
        $extVersion = $Matches[2]
      }
    }
  }
  $extId = "$extPublisher.$extName"

  $vsixPath = ''
  if ($UsePrebuilt -and $prebuiltVsix -and (Test-Path $prebuiltVsix)) {
    $vsixPath = $prebuiltVsix
    Info "Using prebuilt VSIX: $vsixPath"
  } elseif (Test-Path $buildScript) {
    try {
      $vsixPath = (& $buildScript -OutDir $distOut | Select-Object -Last 1)
    } catch {
      Fail "VSIX build failed: $_" 4
    }
  } elseif ($prebuiltVsix -and (Test-Path $prebuiltVsix)) {
    $vsixPath = $prebuiltVsix
    Info "Using prebuilt VSIX: $vsixPath"
  } else {
    Fail "Neither build script ($buildScript) nor prebuilt VSIX ($prebuiltVsix) was found." 4
  }
  if (-not $vsixPath -or -not (Test-Path $vsixPath)) { Fail "VSIX output not found: $vsixPath" 4 }
  Ok "vsix: $vsixPath"

  $failed = $false
  $installedAny = $false

  foreach ($ed in ($Editor -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    $cli = Get-Command "$ed.cmd" -ErrorAction SilentlyContinue
    if (-not $cli) { $cli = Get-Command $ed -ErrorAction SilentlyContinue }
    if (-not $cli) { Warn "Editor CLI '$ed' not found on PATH — skipping"; continue }

    $installedAny = $true
    Info "Installing $extId@$extVersion into $ed ..."
    foreach ($old in @('local.antigravity-tabs', 'orinpl.ccweb-for-antigravity')) {
      if ($old -ne $extId -and (& $cli.Source --list-extensions 2>$null | Where-Object { $_ -eq $old })) {
        Info "Removing legacy extension $old"
        & $cli.Source --uninstall-extension $old 2>&1 | ForEach-Object { "       $_" }
      }
    }
    & $cli.Source --install-extension $vsixPath --force 2>&1 | ForEach-Object { "       $_" }
    $installed = & $cli.Source --list-extensions --show-versions 2>$null | Where-Object { $_ -like "$extId@*" }
    if ($extVersion -and ($installed -contains "$extId@$extVersion")) {
      Ok "${ed}: $installed"
    } elseif (-not $extVersion -and $installed) {
      Ok "${ed}: $installed"
    } else {
      Write-Host "[FAIL] ${ed}: expected $extId@$extVersion, got '$installed'" -ForegroundColor Red
      $failed = $true
    }
  }
  if (-not $installedAny) { Fail "No requested editor CLI ($Editor) found on PATH. Install manually: code --install-extension `"$vsixPath`" --force" 5 }
  if ($failed) { exit 5 }
}

# ── 4. Deploy & Start Local Web Bridge + Chrome Extension ────
$bridgeDst = Join-Path $env:USERPROFILE '.gemini\web-bridge'
$chromeExtDst = Join-Path $bridgeDst 'chrome-extension'
$bridgeStatus = $null

if (-not $SkipWebBridge) {
  $bridgeSrc = Join-Path $resolvedRepo 'web-bridge'
  if (-not (Test-Path (Join-Path $bridgeSrc 'server.mjs'))) {
    Fail "Missing web-bridge/server.mjs in $resolvedRepo" 6
  }

  New-Item -ItemType Directory -Force $chromeExtDst | Out-Null

  # Stop running bridge before overwriting server.mjs so updates take effect cleanly
  $existingStop = Join-Path $bridgeDst 'stop-bridge.ps1'
  if (Test-Path $existingStop) {
    Info 'Stopping existing Web Bridge before updating files...'
    & $existingStop | ForEach-Object { "       $_" }
  }

  Info "Deploying Web Bridge & Chrome Extension to $bridgeDst (preserving user state/config)..."
  foreach ($f in @('server.mjs', 'mcp-server.mjs', 'start-bridge.ps1', 'stop-bridge.ps1', 'README.md')) {
    $srcFile = Join-Path $bridgeSrc $f
    if (Test-Path $srcFile) {
      Copy-Item -Path $srcFile -Destination (Join-Path $bridgeDst $f) -Force
    }
  }
  # Bundle shared MCP helpers alongside server.mjs so Web Bridge never needs to scan editor extension folders
  foreach ($helper in @('configPaths.js', 'mcpManager.js', 'mcpHttpBridge.js')) {
    $hSrc = Join-Path $bridgeSrc $helper
    if (-not (Test-Path $hSrc)) {
      $hSrc = Join-Path $resolvedRepo "src\$helper"
    }
    if (Test-Path $hSrc) {
      Copy-Item -Path $hSrc -Destination (Join-Path $bridgeDst $helper) -Force
    }
  }

  $extSrc = Join-Path $bridgeSrc 'chrome-extension'
  if (Test-Path (Join-Path $extSrc 'manifest.json')) {
    Get-ChildItem -Path $extSrc -File | ForEach-Object {
      Copy-Item -Path $_.FullName -Destination (Join-Path $chromeExtDst $_.Name) -Force
    }
  } else {
    $chromeZip = Get-ChildItem -Path (Join-Path $resolvedRepo 'dist') -Filter 'zerog-code-chrome-extension-*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($chromeZip) {
      Info "Extracting prebuilt Chrome extension archive: $($chromeZip.FullName)"
      Expand-Archive -Path $chromeZip.FullName -DestinationPath $chromeExtDst -Force
    } else {
      Fail "Missing Chrome extension files under $extSrc or dist/zerog-code-chrome-extension-*.zip" 6
    }
  }
  Ok "web-bridge & chrome-extension files deployed to $bridgeDst"

  # Start detached Web Bridge daemon
  Info 'Starting local Web Bridge daemon (127.0.0.1:18765)...'
  & (Join-Path $bridgeDst 'start-bridge.ps1') -Cwd (Get-Location).Path | ForEach-Object { "       $_" }

  for ($i = 0; $i -lt 6; $i++) {
    try {
      $bridgeStatus = Invoke-RestMethod -Uri 'http://127.0.0.1:18765/status' -Method Get -TimeoutSec 2
      if ($bridgeStatus -and $bridgeStatus.ok) { break }
    } catch {}
    Start-Sleep -Milliseconds 600
  }
  if (-not $bridgeStatus -or -not $bridgeStatus.ok) {
    Fail "Web Bridge did not respond on http://127.0.0.1:18765/status. Check $bridgeDst\bridge.log" 6
  }
  Ok "web-bridge online: http://127.0.0.1:18765 (cwd=$($bridgeStatus.cwd))"
}

# ── 5. Register gemini-web-agent MCP Server ──────────────────
if (-not $SkipMcp -and -not $SkipWebBridge) {
  $mcpCfgPath = Join-Path $env:USERPROFILE '.gemini\config\mcp_config.json'
  New-Item -ItemType Directory -Force (Split-Path -Parent $mcpCfgPath) | Out-Null

  $mcpJson = $null
  if (Test-Path $mcpCfgPath) {
    try { $mcpJson = Get-Content $mcpCfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $mcpJson = $null }
  }
  if (-not $mcpJson) {
    $mcpJson = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{} }
  }
  if (-not ($mcpJson.PSObject.Properties.Name -contains 'mcpServers') -or -not $mcpJson.mcpServers) {
    $mcpJson | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([PSCustomObject]@{}) -Force
  }

  $mcpEntry = [PSCustomObject]@{
    command = 'node'
    args    = @((Join-Path $bridgeDst 'mcp-server.mjs'))
    env     = [PSCustomObject]@{ WEB_BRIDGE_PORT = '18765' }
  }
  $mcpJson.mcpServers | Add-Member -NotePropertyName 'gemini-web-agent' -NotePropertyValue $mcpEntry -Force

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($mcpCfgPath, ($mcpJson | ConvertTo-Json -Depth 12), $utf8NoBom)
  Ok "MCP server registered: gemini-web-agent -> $mcpCfgPath"
}

# ── 6. Optional: Install zerog-code-deploy Skill ─────────────
if ($InstallSkill) {
  $srcSkill = Join-Path $resolvedRepo 'skills\zerog-code-deploy'
  if (Test-Path $srcSkill) {
    $targets = @(
      (Join-Path $env:USERPROFILE '.gemini\config\skills\zerog-code-deploy')
    )
    if (Test-Path (Join-Path $env:USERPROFILE '.claude')) {
      $targets += (Join-Path $env:USERPROFILE '.claude\skills\zerog-code-deploy')
    }
    foreach ($dst in $targets) {
      if ([string]::Equals($srcSkill.TrimEnd('\'), $dst.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
        Ok "skill already in place: $dst"
        continue
      }
      New-Item -ItemType Directory -Force $dst | Out-Null
      Copy-Item -Path (Join-Path $srcSkill '*') -Destination $dst -Recurse -Force
      Ok "skill installed: $dst"
    }
  }
}

# ── 7. Chrome Extension Check & agy Sign-in Verification ─────
Write-Host ''
if (-not $SkipWebBridge) {
  if ($bridgeStatus -and $bridgeStatus.browserOnline) {
    Ok 'Chrome extension is already connected to Web Bridge!'
  } else {
    Write-Host '[ACTION REQUIRED] Load the Chrome Extension to enable Gemini Web (/web, /sync, /pull):' -ForegroundColor Yellow
    Write-Host '  1. Open Chrome -> chrome://extensions/'
    Write-Host '  2. Enable "Developer mode" (top right)'
    Write-Host "  3. Click `"Load unpacked`" and select:"
    Write-Host "     $chromeExtDst" -ForegroundColor Cyan
    Write-Host '  4. Sign in to https://gemini.google.com in Chrome'
    Write-Host '  5. Verify: Invoke-RestMethod http://127.0.0.1:18765/status | Select-Object ok, browserOnline'
  }

  if ($OpenChromeExt) {
    Start-Process explorer.exe $chromeExtDst
    $chromeExe = @(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chromeExe) {
      Start-Process -FilePath $chromeExe -ArgumentList 'chrome://extensions/'
    }
  }
}

if (-not $SkipAuthCheck) {
  Info 'Checking agy sign-in (agy -p /usage)...'
  $tmpOut = [IO.Path]::GetTempFileName()
  $p = Start-Process -FilePath $agy -ArgumentList '-p', '/usage', '--output-format', 'json' -NoNewWindow -PassThru `
    -WorkingDirectory $env:TEMP -RedirectStandardOutput $tmpOut -RedirectStandardError "$tmpOut.err"
  if (-not $p.WaitForExit(45000)) {
    $p.Kill()
    Warn 'All components were deployed, but agy -p /usage timed out (check network / proxy).'
    exit 3
  }
  $raw = Get-Content $tmpOut -Raw -ErrorAction SilentlyContinue
  Remove-Item $tmpOut, "$tmpOut.err" -ErrorAction SilentlyContinue
  $j = $null
  try {
    if ($raw -and $raw.IndexOf('{') -ge 0) {
      $j = $raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json
    }
  } catch { $j = $null }
  if (-not $j -or $j.status -ne 'SUCCESS' -or -not $j.command.data.groups) {
    Write-Host ''
    Write-Host '[ACTION REQUIRED] All components are deployed, but Antigravity CLI (agy) is not signed in yet:' -ForegroundColor Yellow
    Write-Host '  Run "agy" in a terminal (or VS Code Command Palette -> "ZeroG: Sign In to Antigravity CLI (agy)") to complete browser login.' -ForegroundColor Cyan
    if ($raw -and $raw.Trim()) { Write-Host "  Output: $($raw.Trim())" }
    exit 3
  }
  Ok 'agy signed in'
}

Write-Host ''
Write-Host 'Next: in VS Code / Cursor run "Developer: Reload Window", then press Ctrl+Shift+Alt+N (or click the ZeroG status bar button).' -ForegroundColor Green
exit 0
