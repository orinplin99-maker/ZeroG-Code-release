$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $Dir "bridge.pid"

$pidsToStop = New-Object System.Collections.Generic.HashSet[int]

if (Test-Path $PidFile) {
    $idRaw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($idRaw -and ($idRaw -as [int])) {
        [void]$pidsToStop.Add([int]$idRaw)
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'web-bridge[\\/]server\.mjs' } |
    ForEach-Object { [void]$pidsToStop.Add([int]$_.ProcessId) }

Get-NetTCPConnection -LocalPort 18765 -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 0 } |
    ForEach-Object { [void]$pidsToStop.Add([int]$_.OwningProcess) }

if ($pidsToStop.Count -gt 0) {
    foreach ($targetPid in $pidsToStop) {
        Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] 已停止 Gemini Web Bridge 进程 (PID=$targetPid)" -ForegroundColor Yellow
    }
} else {
    Write-Host "未找到运行中的 Gemini Web Bridge 进程"
}
