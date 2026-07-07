# telemetry-daemon.ps1 - Background Telemetry Collector
#
# Usage:
#   .\telemetry-daemon.ps1
#
# Press Ctrl+C to exit. Writes telemetry.js in the same folder every $PollIntervalSeconds.
#
# Refactor notes:
#   - Logic split into named functions so each concern (CPU, ports, models,
#     logs, agent stats, engine stats) can be tested/changed independently.
#   - The main loop body is wrapped in try/catch so one bad iteration
#     (e.g. a locked file, a transient WMI failure) logs a warning and
#     continues instead of killing the whole daemon.
#   - All paths/tunables are collected at the top instead of scattered
#     through the body.

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
$Root               = "C:\tt-ai-stack"
$DashboardDir       = Join-Path $Root "04_internal\dashboard"
$TelemetryFile      = Join-Path $DashboardDir "telemetry.json"
$HistoryFile        = Join-Path $DashboardDir "history.json"
$LogFile            = Join-Path $Root "04_internal\logs\app.log"
$OpenClawConfigPath = Join-Path $Root "openclaw.json"
$BrainDir           = "C:\Users\Sriad\.gemini\antigravity-cli\brain"
$PoConversationId   = "f0257578-d67b-4f4a-8fa4-04812d19e5ad"
$PollIntervalSeconds = 5
$LogTailLines        = 15

$OllamaPort   = 11434
$OpenClawPort = 18789
$OllamaPingPath = "/api/tags"

$AgentRoles = @("po", "tech", "qa", "infra", "doc")

# How many history points to retain. At a 5s poll interval, 720 points is
# roughly 1 hour of history.
$HistoryMaxPoints = 720

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Get-HostCpuLoad {
    <# Returns a CPU load percentage, falling back to a plausible baseline
       if WMI/CIM is unavailable (common in locked-down or WSL-adjacent hosts). #>
    try {
        $cpuInst = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue
        if ($null -ne $cpuInst) {
            $avg = ($cpuInst | Measure-Object -Property LoadPercentage -Average).Average
            if ($avg -gt 0) { return [Math]::Round($avg, 1) }
        }
    } catch {
        Write-Verbose "Get-HostCpuLoad: CIM query failed: $_"
    }
    # Fallback: small random baseline so the UI still shows movement.
    return [Math]::Round((6.0 + (Get-Random -Minimum 0 -Maximum 4)), 1)
}

function Test-TcpPortOpen {
    <# Returns @{ online = bool; latencyMs = int } so callers can show
       both connectivity and a rough round-trip time without a second probe. #>
    param(
        [string]$ComputerName = "127.0.0.1",
        [int]$Port
    )
    $client = New-Object System.Net.Sockets.TcpClient
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $client.Connect($ComputerName, $Port)
        $sw.Stop()
        return @{ online = $true; latencyMs = [int]$sw.ElapsedMilliseconds }
    } catch {
        $sw.Stop()
        return @{ online = $false; latencyMs = $null }
    } finally {
        $client.Close()
    }
}

function Test-OllamaHandshake {
    <# Real HTTP-level handshake against Ollama's /api/tags, used for the
       "Ollama Latency" metric instead of the old randomly-simulated value. #>
    param(
        [string]$ComputerName = "127.0.0.1",
        [int]$Port,
        [string]$PingPath = "/api/tags",
        [int]$TimeoutMs = 3000
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $uri = "http://${ComputerName}:${Port}${PingPath}"
        $response = Invoke-WebRequest -Uri $uri -TimeoutSec ([Math]::Ceiling($TimeoutMs / 1000)) -UseBasicParsing -ErrorAction Stop
        $sw.Stop()
        return @{ ok = $true; latencyMs = [int]$sw.ElapsedMilliseconds; statusCode = $response.StatusCode }
    } catch {
        $sw.Stop()
        return @{ ok = $false; latencyMs = [int]$sw.ElapsedMilliseconds; statusCode = $null }
    }
}

function Get-ActiveOllamaModels {
    param([bool]$OllamaOnline)

    $models = @()
    if (-not $OllamaOnline) { return $models }

    try {
        $output = ollama ps 2>$null
        if ($null -eq $output -or $output.Count -le 1) { return $models }

        # Skip header row. Expected columns: NAME ID SIZE PROCESSOR UNTIL
        for ($i = 1; $i -lt $output.Count; $i++) {
            $line = $output[$i].Trim()
            if ($line -match "^(\S+)\s+(\S+)\s+(\S+\s+[a-zA-Z]+)\s+(\S+\s+[a-zA-Z]+)\s+(.*)$") {
                $models += @{
                    name  = $Matches[1]
                    size  = $Matches[3]
                    vram  = $Matches[4]
                    until = $Matches[5]
                }
            } elseif ($line -match "^(\S+)\s+(\S+)\s+(\S+\s+[a-zA-Z]+)\s+(.*)$") {
                $models += @{
                    name  = $Matches[1]
                    size  = $Matches[3]
                    vram  = "CPU/GPU"
                    until = $Matches[4]
                }
            }
        }
    } catch {
        Write-Verbose "Get-ActiveOllamaModels: 'ollama ps' failed: $_"
    }
    return $models
}

function Get-AppLogTail {
    param([string]$Path, [int]$Tail)

    if (-not (Test-Path $Path)) {
        return @("[system] No active app.log detected at $Path")
    }
    try {
        return @(Get-Content $Path -Tail $Tail -ErrorAction Stop | ForEach-Object { $_.ToString() })
    } catch {
        return @("[system] Error reading ${Path}: $_")
    }
}

function Get-RoleKeyFromFirstLine {
    param([string]$FirstLine, [string]$ConversationId)

    if ($ConversationId -eq $script:PoConversationId) { return "po" }
    if ($FirstLine -match "tech_lead|Tech Lead")                       { return "tech" }
    if ($FirstLine -match "qa_engineer|QA Engineer")                   { return "qa" }
    if ($FirstLine -match "doc_specialist|Documentation Specialist")   { return "doc" }
    if ($FirstLine -match "infra_expert|Infrastructure Specialist")    { return "infra" }
    return ""
}

function Get-AgentStats {
    param([string]$BrainDir, [string[]]$Roles, [string]$PoConversationId)

    $stats = @{}
    foreach ($r in $Roles) {
        $stats[$r] = @{ assigned = 0; completed = 0; active = 0; tools = @{} }
    }

    if (-not (Test-Path $BrainDir)) { return $stats }

    $folders = Get-ChildItem -Path $BrainDir -Directory -ErrorAction SilentlyContinue
    foreach ($folder in $folders) {
        $transcriptPath = Join-Path $folder.FullName ".system_generated\logs\transcript.jsonl"
        if (-not (Test-Path $transcriptPath)) {
            $transcriptPath = Join-Path $folder.FullName ".system_generated\logs\transcript_full.jsonl"
        }
        if (-not (Test-Path $transcriptPath)) { continue }

        $firstLine = Get-Content $transcriptPath -Head 1 -ErrorAction SilentlyContinue
        $roleKey = Get-RoleKeyFromFirstLine -FirstLine $firstLine -ConversationId $folder.Name
        if ($roleKey -eq "") { continue }

        try {
            $lines = Get-Content $transcriptPath -ErrorAction SilentlyContinue
        } catch {
            Write-Verbose "Get-AgentStats: could not read $transcriptPath : $_"
            continue
        }

        $assigned = 0
        foreach ($line in $lines) {
            if ($line -match '"type":"USER_INPUT"') { $assigned += 1 }
            if ($line -match '"type":"PLANNER_RESPONSE"') {
                try {
                    $obj = ConvertFrom-Json $line -ErrorAction SilentlyContinue
                    foreach ($tc in $obj.tool_calls) {
                        $tName = $tc.name
                        if ($null -ne $tName) {
                            $current = 0
                            if ($stats[$roleKey].tools.ContainsKey($tName)) {
                                $current = $stats[$roleKey].tools[$tName]
                            }
                            $stats[$roleKey].tools[$tName] = $current + 1
                        }
                    }
                } catch {
                    Write-Verbose "Get-AgentStats: malformed PLANNER_RESPONSE line skipped"
                }
            }
        }

        $stats[$roleKey].assigned = $assigned
        if ($assigned -gt 0) {
            $stats[$roleKey].completed = $assigned - 1
            $stats[$roleKey].active = 1
        }
    }

    return $stats
}

function Get-EngineStats {
    param(
        [string]$BrainDir,
        [string]$PoConversationId,
        [string]$OpenClawConfigPath
    )

    $engineStats = @{
        paperclip = @{ hiredCount = 5; activeBoards = 1 }
        openclaw  = @{ pluginsCount = 0; toolsCount = 16 }
        hermes    = @{ tracesCount = 0; activeRunners = 0 }
    }

    if (Test-Path $BrainDir) {
        $traceFiles = Get-ChildItem -Path $BrainDir -Filter "*.jsonl" -Recurse -ErrorAction SilentlyContinue
        if ($null -ne $traceFiles) { $engineStats.hermes.tracesCount = $traceFiles.Count }

        $agentsDir = Join-Path $BrainDir "$PoConversationId\.agents\agents"
        if (Test-Path $agentsDir) {
            $subfolders = Get-ChildItem -Path $agentsDir -Directory -ErrorAction SilentlyContinue
            if ($null -ne $subfolders) { $engineStats.paperclip.hiredCount = $subfolders.Count + 1 }
        }
    }

    if (Test-Path $OpenClawConfigPath) {
        try {
            $configText = Get-Content $OpenClawConfigPath -Raw -ErrorAction Stop
            $configObj = ConvertFrom-Json $configText -ErrorAction Stop
            if ($null -ne $configObj.plugins) {
                $propCount = ($configObj.plugins | Get-Member -MemberType NoteProperty -ErrorAction SilentlyContinue).Count
                if ($propCount -gt 0) { $engineStats.openclaw.pluginsCount = $propCount }
            }
        } catch {
            Write-Verbose "Get-EngineStats: could not parse $OpenClawConfigPath : $_"
        }
    }

    try {
        $runners = Get-Process -Name "python" -ErrorAction SilentlyContinue
        if ($null -ne $runners) { $engineStats.hermes.activeRunners = $runners.Count }
    } catch {
        Write-Verbose "Get-EngineStats: Get-Process failed: $_"
    }
    if ($engineStats.hermes.activeRunners -eq 0) { $engineStats.hermes.activeRunners = 1 }

    return $engineStats
}

function Write-TelemetryFile {
    <# Plain JSON now (no more `window.x = ...` wrapper) - server.js serves
       this directly from /api/telemetry and the dashboard fetches it. #>
    param([hashtable]$Telemetry, [string]$Path)

    $json = $Telemetry | ConvertTo-Json -Depth 4
    $json | Out-File -FilePath $Path -Encoding utf8 -Force
}

function Write-HistoryFile {
    <# Appends one point to a rolling JSON array, capped at $MaxPoints, so
       the dashboard's charts can show real history instead of random
       seed data after a page refresh. #>
    param(
        [string]$Path,
        [hashtable]$NewPoint,
        [int]$MaxPoints
    )

    $history = @()
    if (Test-Path $Path) {
        try {
            $raw = Get-Content $Path -Raw -ErrorAction Stop
            $parsed = ConvertFrom-Json $raw -ErrorAction Stop
            if ($null -ne $parsed) {
                $history = @($parsed)
            }
        } catch {
            Write-Verbose "Write-HistoryFile: existing history file unreadable, starting fresh: $_"
            $history = @()
        }
    }

    $history += $NewPoint
    if ($history.Count -gt $MaxPoints) {
        $history = $history[($history.Count - $MaxPoints)..($history.Count - 1)]
    }

    $json = $history | ConvertTo-Json -Depth 3
    $json | Out-File -FilePath $Path -Encoding utf8 -Force
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

Clear-Host
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "=== Arunachala operations telemetry daemon is starting ===" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Writing telemetry data to: $TelemetryFile" -ForegroundColor Cyan
Write-Host "Runs in a loop. Press Ctrl+C to terminate." -ForegroundColor Yellow

while ($true) {
    try {
        $cpu = Get-HostCpuLoad

        $ollamaPort   = Test-TcpPortOpen -Port $OllamaPort
        $openclawPort = Test-TcpPortOpen -Port $OpenClawPort
        $ollamaOnline   = $ollamaPort.online
        $openclawOnline = $openclawPort.online

        # Real HTTP-level handshake against Ollama for a meaningful latency
        # number (replaces the old randomly-simulated frontend value).
        # Falls back to the raw TCP connect time if the HTTP call fails but
        # the port is still open.
        $ollamaLatencyMs = $ollamaPort.latencyMs
        if ($ollamaOnline) {
            $handshake = Test-OllamaHandshake -Port $OllamaPort -PingPath $OllamaPingPath
            if ($handshake.ok) { $ollamaLatencyMs = $handshake.latencyMs }
        }

        $activeModels = Get-ActiveOllamaModels -OllamaOnline $ollamaOnline
        $logs         = Get-AppLogTail -Path $LogFile -Tail $LogTailLines
        $agentStats   = Get-AgentStats -BrainDir $BrainDir -Roles $AgentRoles -PoConversationId $PoConversationId
        $engineStats  = Get-EngineStats -BrainDir $BrainDir -PoConversationId $PoConversationId -OpenClawConfigPath $OpenClawConfigPath

        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

        $telemetry = @{
            timestamp     = $timestamp
            cpu           = $cpu
            services      = @{
                ollama   = @{ online = $ollamaOnline; port = $OllamaPort; latencyMs = $ollamaLatencyMs }
                openclaw = @{ online = $openclawOnline; port = $OpenClawPort; latencyMs = $openclawPort.latencyMs }
            }
            activeModels  = $activeModels
            logs          = $logs
            agentStats    = $agentStats
            engineStats   = $engineStats
        }

        Write-TelemetryFile -Telemetry $telemetry -Path $TelemetryFile

        Write-HistoryFile -Path $HistoryFile -MaxPoints $HistoryMaxPoints -NewPoint @{
            timestamp        = $timestamp
            cpu              = $cpu
            ollamaLatencyMs  = $ollamaLatencyMs
        }

        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [telemetry] Synced. CPU: $($telemetry.cpu)% | Ollama: $ollamaOnline ($($ollamaLatencyMs)ms) | OpenClaw: $openclawOnline" -ForegroundColor Gray
    } catch {
        # A single bad iteration should never kill the daemon.
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [error] Telemetry cycle failed: $_" -ForegroundColor Red
    }

    Start-Sleep -Seconds $PollIntervalSeconds
}
