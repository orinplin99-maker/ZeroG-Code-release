param(
    [string]$Cwd = "",
    [int]$Port = 18765,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $Dir "bridge.pid"
$ServerScript = Join-Path $Dir "server.mjs"

if (-not $Cwd) {
    $Cwd = if ($env:WEB_BRIDGE_CWD) { $env:WEB_BRIDGE_CWD } else { (Get-Location).Path }
}

if ($Force) {
    $StopScript = Join-Path $Dir "stop-bridge.ps1"
    if (Test-Path $StopScript) { & $StopScript | Out-Null }
    Start-Sleep -Milliseconds 350
} elseif (Test-Path $PidFile) {
    $oldPid = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($oldPid -and ($oldPid -as [int])) {
        $proc = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match "node") {
            Write-Host "[OK] ZeroG Code Web Bridge is already running (PID=$oldPid, http://127.0.0.1:$Port)" -ForegroundColor Green
            exit 0
        }
    }
}

$nodeExe = (Get-Command node -ErrorAction Stop).Source
$env:WEB_BRIDGE_CWD = $Cwd
$env:WEB_BRIDGE_PORT = "$Port"

$cmdLine = "`"$nodeExe`" `"$ServerScript`""
$startup = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly

# Spawn detached from the parent Job Object so Reload Window / terminal exit does not kill the bridge
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmdLine
    CurrentDirectory = $Dir
    ProcessStartupInformation = $startup
}

if ($res.ReturnValue -ne 0 -or -not $res.ProcessId) {
    throw "Win32_Process.Create failed (ReturnValue=$($res.ReturnValue))"
}

$newPid = $res.ProcessId
$newPid | Out-File -FilePath $PidFile -Encoding ascii
Start-Sleep -Milliseconds 1200

try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -Method Get -TimeoutSec 3
    Write-Host "[OK] ZeroG Code Web Bridge started (PID=$newPid, http://127.0.0.1:$Port, cwd=$($status.cwd))" -ForegroundColor Green
} catch {
    Write-Host "[WARN] Bridge process started (PID=$newPid), still initializing. Check $Dir\bridge.log" -ForegroundColor Yellow
}
