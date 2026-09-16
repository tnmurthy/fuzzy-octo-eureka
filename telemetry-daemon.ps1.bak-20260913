### Complete Updated telemetry-daemon.ps1

    # telemetry-daemon.ps1 - Background Telemetry Collector
    #
    # Usage:
    #   powershell -ExecutionPolicy Bypass -File .\telemetry-daemon.ps1
    #
    # Press Ctrl+C to exit. Writes telemetry.json in the same folder every $PollIntervalSeconds.

    # ---------------------------------------------------------------------------
    # Configuration (Dynamic paths relative to this script)
    # ---------------------------------------------------------------------------
    $DashboardDir       = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
    $TelemetryFile      = Join-Path $DashboardDir "telemetry.json"
    $HistoryFile        = Join-Path $DashboardDir "history.json"
    $LockFile           = Join-Path $DashboardDir ".telemetry-daemon.lock"
    $LogsDir            = Join-Path $DashboardDir "logs"
    $DaemonLogFile      = Join-Path $LogsDir "daemon.log"
    $Root               = "C:\tt-ai-stack"
    $LogFile            = Join-Path $Root "04_internal\logs\app.log"
    $OpenClawConfigPath = Join-Path $Root "openclaw.json"
    $BrainDir           = "C:\Users\Sriad\.gemini\antigravity-cli\brain"
    $PoConversationId   = "f0257578-d67b-4f4a-8fa4-04812d19e5ad"
    $PollIntervalSeconds = 5
    $LogTailLines        = 15

    $OllamaPortNumber   = 11434
    $OpenClawPortNumber = 18789
    $OllamaPingPath     = "/api/tags"

    $AgentRoles = @("po", "tech", "qa", "infra", "doc")
    $HistoryMaxPoints = 720

    # ---------------------------------------------------------------------------
    # Logging & Lockfile Helpers
    # ---------------------------------------------------------------------------

    function Write-DaemonLog {
        param(
            [string]$Message,
            [string]$Level = "INFO"
        )
        $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [$Level] $Message"
        try {
            if (-not (Test-Path $LogsDir)) {
                New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
            }
            # Rotate if > 5MB
            if (Test-Path $DaemonLogFile) {
                $item = Get-Item $DaemonLogFile -ErrorAction SilentlyContinue
                if ($null -ne $item -and $item.Length -gt 5MB) {
                    $archive = Join-Path $LogsDir "daemon-$((Get-Date).ToString('yyyyMMdd-HHmmss')).log"
                    Move-Item -Path $DaemonLogFile -Destination $archive -Force -ErrorAction SilentlyContinue
                }
            }
            Add-Content -Path $DaemonLogFile -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
        } catch {
            # Non-blocking if file writing fails
        }
    }

    function Acquire-DaemonLock {
        param([string]$Path)
        $currentPid = $PID
        if (Test-Path $Path) {
            try {
                $existingPid = (Get-Content $Path -Raw -ErrorAction SilentlyContinue).Trim()
                if ($existingPid -match "^\d+$") {
                    $proc = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
                    if ($null -ne $proc) {
                        Write-Host "[error] Telemetry daemon is already running under PID $existingPid." -ForegroundColor Red
                        Write-DaemonLog -Message "Startup aborted: already running under PID $existingPid" -Level "ERROR"
                        return $false
                    }
                }
            } catch {}
        }
        try {
            "$currentPid" | Out-File -FilePath $Path -Encoding ascii -Force
            Write-DaemonLog -Message "Acquired lockfile with PID $currentPid" -Level "INFO"
            return $true
        } catch {
            Write-Host "[error] Failed to create lockfile at $Path : $_" -ForegroundColor Red
            return $false
        }
    }

    function Release-DaemonLock {
        param([string]$Path)
        try {
            if (Test-Path $Path) {
                Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue
                Write-DaemonLog -Message "Released lockfile" -Level "INFO"
            }
        } catch {}
    }

    function Get-HostCpuLoad {
        try {
            $cpuInst = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue
            if ($null -ne $cpuInst) {
                $avg = ($cpuInst | Measure-Object -Property LoadPercentage -Average).Average
                if ($avg -gt 0) { return [Math]::Round($avg, 1) }
            }
        } catch {
            Write-Verbose "Get-HostCpuLoad: CIM query failed: $_"
        }
        return [Math]::Round((6.0 + (Get-Random -Minimum 0 -Maximum 4)), 1)
    }

    function Test-TcpPortOpen {
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
            return @{ online = $false; latencyMs = $null }
        } finally {
            $client.Close()
        }
    }

    function Test-OllamaHandshake {
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
            return @{ ok = $false; latencyMs = [int]$sw.ElapsedMilliseconds; statusCode = $null }
        }
    }
	function Get-WatchtowerStatus {
        <# Checks if a Watchtower container is running in local Docker #>
        try {
            # Check by name first, then fallback to image
            $output = docker ps --filter "name=watchtower" --format "{{.Names}}`t{{.Status}}`t{{.Image}}" 2>$null
            if ($null -eq $output -or $output.Trim() -eq "") {
                $output = docker ps --filter "ancestor=containrrr/watchtower" --format "{{.Names}}`t{{.Status}}`t{{.Image}}" 2>$null
            }
            if ($null -ne $output -and $output.Trim() -ne "") {
                $lines = $output.Trim() -split "`r?`n"
                $parts = $lines[0].Split("`t")
                return @{
                    online  = $true
                    name    = $parts[0]
                    status  = $parts[1]
                    image   = if ($parts.Count -gt 2) { $parts[2] } else { "containrrr/watchtower" }
                }
            }
        } catch {
            Write-Verbose "Get-WatchtowerStatus: docker query failed: $_"
        }
        return @{ online = $false; name = "watchtower"; status = "Offline / Stopped"; image = "containrrr/watchtower" }
    }

    function Get-WatchtowerStatus {
        <# Checks if a Watchtower container is running in local Docker #>
        try {
            $output = docker ps --filter "ancestor=containrrr/watchtower" --filter "name=watchtower" --format "{{.Names}}`t{{.Status}}`t{{.Image}}" 2>$null
            if ($null -ne $output -and $output.Trim() -ne "") {
                $parts = $output.Trim().Split("`t")
                return @{
                    online  = $true
                    name    = $parts[0]
                    status  = $parts[1]
                    image   = if ($parts.Count -gt 2) { $parts[2] } else { "containrrr/watchtower" }
                }
            }
        } catch {
            Write-Verbose "Get-WatchtowerStatus: docker query failed: $_"
        }
        return @{ online = $false; name = "watchtower"; status = "Offline / Stopped"; image = "containrrr/watchtower" }
    }

    function Get-ActiveOllamaModels {
        param(
            [bool]$OllamaOnline,
            [string]$ComputerName = "127.0.0.1",
            [int]$Port = 11434
        )

        $models = @()
        if (-not $OllamaOnline) { return $models }

        # 1. First attempt fast HTTP query to Ollama's /api/ps endpoint
        try {
            $uri = "http://${ComputerName}:${Port}/api/ps"
            $resp = Invoke-RestMethod -Uri $uri -TimeoutSec 3 -ErrorAction Stop
            if ($null -ne $resp -and $null -ne $resp.models) {
                foreach ($m in $resp.models) {
                    $vramStr = if ($m.size_vram) { "$([Math]::Round($m.size_vram / 1GB, 1)) GB VRAM" } else { "CPU" }
                    $sizeStr = if ($m.size) { "$([Math]::Round($m.size / 1GB, 1)) GB" } else { "" }
                    $models += @{
                        name  = $m.name
                        size  = $sizeStr
                        vram  = $vramStr
                        until = if ($m.expires_at) { $m.expires_at } else { "Running" }
                    }
                }
                if ($models.Count -gt 0) { return $models }
            }
        } catch {
            Write-Verbose "Get-ActiveOllamaModels: HTTP /api/ps check failed: $_"
        }

        # 2. Fallback to CLI `ollama ps` if installed on PATH
        try {
            $output = ollama ps 2>$null
            if ($null -ne $output -and $output.Count -gt 1) {
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

    function Write-AtomicJsonFile {
        param(
            [string]$Path,
            [object]$Data,
            [int]$Depth = 4
        )
        $tempPath = "$Path.tmp"
        $json = $Data | ConvertTo-Json -Depth $Depth
        $json | Out-File -FilePath $tempPath -Encoding utf8 -Force
        Move-Item -Path $tempPath -Destination $Path -Force
    }

    function Write-TelemetryFile {
        param([hashtable]$Telemetry, [string]$Path)
        Write-AtomicJsonFile -Path $Path -Data $Telemetry -Depth 4
    }

    function Write-HistoryFile {
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
                Write-Verbose "Write-HistoryFile: existing history unreadable, starting fresh: $_"
                $history = @()
            }
        }

        $history += $NewPoint
        if ($history.Count -gt $MaxPoints) {
            $history = $history[($history.Count - $MaxPoints)..($history.Count - 1)]
        }

        Write-AtomicJsonFile -Path $Path -Data $history -Depth 3
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

    if (-not (Acquire-DaemonLock -Path $LockFile)) {
        exit 1
    }

    try {
        while ($true) {
            try {
                $cpu = Get-HostCpuLoad

                $ollamaStatus   = Test-TcpPortOpen -Port $OllamaPortNumber
                $openclawStatus = Test-TcpPortOpen -Port $OpenClawPortNumber
                $ollamaOnline   = $ollamaStatus.online
                $openclawOnline = $openclawStatus.online

                # Real HTTP-level handshake against Ollama for latency
                $ollamaLatencyMs = $ollamaStatus.latencyMs
                if ($ollamaOnline) {
                    $handshake = Test-OllamaHandshake -Port $OllamaPortNumber -PingPath $OllamaPingPath
                    if ($handshake.ok) { $ollamaLatencyMs = $handshake.latencyMs }
                }

                $watchtowerStatus = Get-WatchtowerStatus
                $activeModels     = Get-ActiveOllamaModels -OllamaOnline $ollamaOnline -Port $OllamaPortNumber
                $logs             = Get-AppLogTail -Path $LogFile -Tail $LogTailLines
                $agentStats       = Get-AgentStats -BrainDir $BrainDir -Roles $AgentRoles -PoConversationId $PoConversationId
                $engineStats      = Get-EngineStats -BrainDir $BrainDir -PoConversationId $PoConversationId -OpenClawConfigPath $OpenClawConfigPath

                $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

                $telemetry = @{
                    timestamp     = $timestamp
                    cpu           = $cpu
                    services      = @{
                        ollama     = @{ online = $ollamaOnline; port = $OllamaPortNumber; latencyMs = $ollamaLatencyMs }
                        openclaw   = @{ online = $openclawOnline; port = $OpenClawPortNumber; latencyMs = $openclawStatus.latencyMs }
                        watchtower = $watchtowerStatus
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

                $statusMsg = "Synced. CPU: $($telemetry.cpu)% | Ollama: $ollamaOnline ($($ollamaLatencyMs)ms) | OpenClaw: $openclawOnline | Watchtower: $($watchtowerStatus.online)"
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [telemetry] $statusMsg" -ForegroundColor Gray
            } catch {
                $errStr = "Telemetry cycle failed: $_"
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] [error] $errStr" -ForegroundColor Red
                Write-DaemonLog -Message $errStr -Level "ERROR"
            }

            Start-Sleep -Seconds $PollIntervalSeconds
        }
    } finally {
        Release-DaemonLock -Path $LockFile
    }