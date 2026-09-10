# ============================================================
#  start-direct.ps1  --  launch the wb-direct model proxy
#
#  Cross-platform-ish launcher for Windows:
#    - auto-detects node.exe (PATH first, then common install dirs)
#    - always runs from its own folder ($PSScriptRoot)
#    - idempotent: does nothing if the port is already listening
#    - windowless (Start-Process -WindowStyle Hidden)
#    - never blocks the caller (safe to call from other launchers)
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File start-direct.ps1
#    powershell -ExecutionPolicy Bypass -File start-direct.ps1 -Port 3090
#
#  Exit codes: 0 = running/skipped, 1 = failed
#  Log: logs\start.log
# ============================================================
param([int]$Port = 3090)

$ErrorActionPreference = 'Continue'

$dir     = $PSScriptRoot
$script  = Join-Path $dir 'direct.js'
$logDir  = Join-Path $dir 'logs'
$logFile = Join-Path $logDir 'start.log'

if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-StartLog([string]$m) {
    Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString('o') + ' ' + $m) -Encoding UTF8
}

function Test-PortOpen([int]$p) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $p)
        $c.Close()
        return $true
    } catch {
        return $false
    }
}

function Resolve-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    $cands = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:APPDATA 'npm\node.exe')
    )
    foreach ($c in $cands) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

Write-StartLog 'start-direct: begin'

if (-not (Test-Path -LiteralPath $script)) {
    Write-StartLog "FAILED: direct.js not found next to this script ($script)"
    exit 1
}

$nodeExe = Resolve-Node
if (-not $nodeExe) {
    Write-StartLog 'FAILED: node.exe not found. Install Node.js 18+ and retry.'
    exit 1
}

if (Test-PortOpen $Port) {
    Write-StartLog "port $Port already running, skip"
    exit 0
}

$env:WB_DIRECT_PORT = "$Port"

try {
    Start-Process -FilePath $nodeExe -WorkingDirectory $dir -WindowStyle Hidden `
        -ArgumentList @("`"$script`"") `
        -RedirectStandardOutput (Join-Path $logDir 'direct.out.log') `
        -RedirectStandardError  (Join-Path $logDir 'direct.err.log')
    Write-StartLog "launched: $nodeExe  port=$Port"

    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortOpen $Port) { Write-StartLog 'ready'; break }
        Start-Sleep -Milliseconds 500
    }

    if (-not (Test-PortOpen $Port)) {
        Write-StartLog 'FAILED: port not listening. See logs\direct.err.log'
        exit 1
    }
} catch {
    Write-StartLog "FAILED: $($_.Exception.Message)"
    exit 1
}

Write-StartLog 'start-direct: done'
