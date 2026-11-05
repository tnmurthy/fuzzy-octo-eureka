# install-teammate.ps1 - set up a teammate's own Arunachala install on Windows:
# prerequisites, local models, the two .env files, npm packages, the three
# NSSM services (LocalSystem, logs\ with rotation, auto-start), and the n8n
# dispatch workflow. Safe to re-run: existing values are kept.
#
#   powershell -ExecutionPolicy Bypass -File .\install-teammate.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\install-teammate.ps1      (elevated)
#
# -DryRun checks and reports only; it changes nothing and needs no elevation.
# Values the admin gives you (Supabase URL/key, TEAM_ID, Buzz channel ids) can
# be passed as parameters or typed when asked. ASCII only (PS 5.1 reads
# BOM-less .ps1 as Windows-1252).
param(
    [switch]$DryRun,
    [string]$SupabaseUrl,
    [string]$SupabaseKey,
    [string]$TeamId,
    [string]$BuzzChannels
)
$ErrorActionPreference = 'Stop'

$Root    = $PSScriptRoot
$Logs    = Join-Path $Root 'logs'
$Bridge  = Join-Path $Root 'buzz-bridge'
$EnvFile = Join-Path $Root '.env'
$BridgeEnvFile = Join-Path $Bridge '.env'
# The team login password lives in the stack's secrets folder, never in the
# project folder; .env names this file in SECRETS_ENV_FILE (load-env.js).
$SecretsFile = Join-Path (Resolve-Path (Join-Path $Root '..\..\..')).Path '04_internal\secrets\arunachala-team.env'
$Models  = @('gemma3:4b', 'qwen2.5-coder:3b', 'nomic-embed-text')
$MinNode = [version]'20.12.0'   # process.loadEnvFile
$GitBash = 'C:\Program Files\Git\bin\bash.exe'
$script:Problems = @()

function Say($msg) { Write-Host "  $msg" }
function Step($msg) { Write-Host ""; Write-Host "== $msg" }
function Problem($msg) { $script:Problems += $msg; Write-Host "  MISSING: $msg" -ForegroundColor Yellow }

# --- .env helpers ------------------------------------------------------------
function Get-EnvValue($file, $key) {
    if (-not (Test-Path $file)) { return $null }
    foreach ($line in Get-Content $file) {
        if ($line -match "^\s*$key\s*=\s*(.*?)\s*$") { return $Matches[1] }
    }
    return $null
}

# Sets KEY=value: replaces an existing (or commented-out) KEY line, else appends.
function Set-EnvValue($file, $key, $value) {
    $lines = @(Get-Content $file)
    $done = $false
    $out = foreach ($line in $lines) {
        if (-not $done -and $line -match "^\s*#?\s*$key\s*=") { "$key=$value"; $done = $true } else { $line }
    }
    if (-not $done) { $out += "$key=$value" }
    [System.IO.File]::WriteAllLines($file, [string[]]$out, (New-Object System.Text.UTF8Encoding($false)))
}

function Ask($prompt, $current, $pattern) {
    if ($current) { return $current }
    while ($true) {
        $v = (Read-Host $prompt).Trim()
        if (-not $pattern -or $v -match $pattern) { return $v }
        Write-Host "  That does not look right - try again." -ForegroundColor Yellow
    }
}

# --- 1. prerequisites ----------------------------------------------------------
function Test-Prerequisites {
    Step 'Prerequisites'
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Problem 'Node.js 20.12+ (winget install OpenJS.NodeJS.LTS)' }
    else {
        $ver = [version]((& node --version).TrimStart('v'))
        if ($ver -lt $MinNode) { Problem "Node.js $ver is too old - need $MinNode+" } else { Say "node $ver" }
    }
    if (Get-Command git -ErrorAction SilentlyContinue) { Say 'git ok' } else { Problem 'Git for Windows (winget install Git.Git)' }
    if (Test-Path $GitBash) { Say 'git-bash ok' } else { Problem "git-bash at $GitBash (comes with Git for Windows)" }
    if (Get-Command nssm -ErrorAction SilentlyContinue) { Say 'nssm ok' } else { Problem 'NSSM (winget install NSSM.NSSM)' }
    if (Get-Command docker -ErrorAction SilentlyContinue) { Say 'docker ok' } else { Problem 'Docker Desktop, for n8n (winget install Docker.DockerDesktop)' }
    if (Get-Command ollama -ErrorAction SilentlyContinue) { Say 'ollama ok' } else { Problem 'Ollama (winget install Ollama.Ollama)' }
    $ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
    Say "RAM: $ramGb GB"
    if ($ramGb -lt 12) { Say 'Under 12 GB: keep PERSONA_MODEL=gemma3:4b; local models will be slow.' }
}

# --- 2. local models -------------------------------------------------------------
function Install-Models {
    Step 'Local models'
    if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Say 'skipped - Ollama not installed'; return }
    $have = (& ollama list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] })
    foreach ($m in $Models) {
        $present = $have | Where-Object { $_ -eq $m -or $_ -eq "${m}:latest" }
        if ($present) { Say "$m present" }
        elseif ($DryRun) { Say "would pull $m" }
        else { Say "pulling $m ..."; & ollama pull $m }
    }
}

# --- 3. config -------------------------------------------------------------------
function Set-DashboardEnv {
    Step 'Dashboard settings (.env)'
    if ($DryRun) {
        if (Test-Path $EnvFile) {
            foreach ($k in 'OPERATOR_NAME', 'OPERATOR_HOME', 'SUPABASE_URL', 'TEAM_ID') {
                if (Get-EnvValue $EnvFile $k) { Say "$k set" } else { Say "$k not set - would ask" }
            }
            if (Get-EnvValue $SecretsFile 'SUPABASE_PASSWORD') { Say "SUPABASE_PASSWORD set in $SecretsFile" } else { Say "SUPABASE_PASSWORD not set - would ask and save it to $SecretsFile (team sync stays off without it)" }
        } else { Say 'would create .env from .env.example' }
        return
    }
    if (-not (Test-Path $EnvFile)) { Copy-Item (Join-Path $Root '.env.example') $EnvFile; Say 'created .env from .env.example' }
    Set-EnvValue $EnvFile 'OPERATOR_NAME' (Ask 'Your first name (shown in the dashboard)' (Get-EnvValue $EnvFile 'OPERATOR_NAME') '^.{1,40}$')
    # Services run as LocalSystem; agent runs need YOUR profile for CLI logins.
    if (-not (Get-EnvValue $EnvFile 'OPERATOR_HOME')) { Set-EnvValue $EnvFile 'OPERATOR_HOME' $env:USERPROFILE }

    Say 'Shared team context (from your admin). Leave blank to stay solo for now.'
    $url = Ask 'Supabase URL (https://<ref>.supabase.co)' ($SupabaseUrl, (Get-EnvValue $EnvFile 'SUPABASE_URL') | Where-Object { $_ } | Select-Object -First 1) '^$|^https://[a-z0-9]+\.supabase\.co/?$'
    if (-not $url) { Say 'team sync left off'; return }
    Set-EnvValue $EnvFile 'SUPABASE_URL' $url
    Set-EnvValue $EnvFile 'SUPABASE_PUBLISHABLE_KEY' (Ask 'Supabase publishable key (sb_publishable_...)' ($SupabaseKey, (Get-EnvValue $EnvFile 'SUPABASE_PUBLISHABLE_KEY') | Where-Object { $_ } | Select-Object -First 1) '^sb_publishable_\S+$')
    Set-EnvValue $EnvFile 'TEAM_ID' (Ask 'Team id (from your admin)' ($TeamId, (Get-EnvValue $EnvFile 'TEAM_ID') | Where-Object { $_ } | Select-Object -First 1) '^[0-9a-fA-F-]{36}$')
    Set-EnvValue $EnvFile 'SUPABASE_EMAIL' (Ask 'Your Supabase login email' (Get-EnvValue $EnvFile 'SUPABASE_EMAIL') '^\S+@\S+\.\S+$')
    Set-EnvValue $EnvFile 'SECRETS_ENV_FILE' $SecretsFile
    if (-not (Get-EnvValue $SecretsFile 'SUPABASE_PASSWORD')) {
        $secure = Read-Host 'Your Supabase password (not shown; saved only in the secrets folder)' -AsSecureString
        $plain = [System.Net.NetworkCredential]::new('', $secure).Password
        if ($plain) {
            New-Item -ItemType Directory -Force (Split-Path $SecretsFile) | Out-Null
            if (-not (Test-Path $SecretsFile)) { New-Item -ItemType File $SecretsFile | Out-Null }
            Set-EnvValue $SecretsFile 'SUPABASE_PASSWORD' $plain
            Say "password saved to $SecretsFile"
        }
    }
}

function Set-BridgeEnv {
    Step 'Buzz bridge settings (buzz-bridge\.env)'
    if ($DryRun) {
        if (Test-Path $BridgeEnvFile) {
            foreach ($k in 'BUZZ_OPERATORS', 'BUZZ_BOT_NAME', 'BUZZ_BOT_CHANNELS') {
                if (Get-EnvValue $BridgeEnvFile $k) { Say "$k set" } else { Say "$k not set - would ask" }
            }
        } else { Say 'would create buzz-bridge\.env from its .env.example' }
        return
    }
    if (-not (Test-Path $BridgeEnvFile)) { Copy-Item (Join-Path $Bridge '.env.example') $BridgeEnvFile; Say 'created buzz-bridge\.env' }
    Set-EnvValue $BridgeEnvFile 'BUZZ_OPERATORS' (Ask 'Your Buzz public key (64 hex characters)' (Get-EnvValue $BridgeEnvFile 'BUZZ_OPERATORS') '^[0-9a-f]{64}(,[0-9a-f]{64})*$')
    Set-EnvValue $BridgeEnvFile 'BUZZ_BOT_NAME' (Ask "Your bot's name, unique on the team (e.g. Ravi's Team)" (Get-EnvValue $BridgeEnvFile 'BUZZ_BOT_NAME') '^.{3,40}$')
    Set-EnvValue $BridgeEnvFile 'BUZZ_BOT_CHANNELS' (Ask 'Buzz channel id(s) the bot listens to (from your admin)' ($BuzzChannels, (Get-EnvValue $BridgeEnvFile 'BUZZ_BOT_CHANNELS') | Where-Object { $_ } | Select-Object -First 1) '^[0-9a-f]{64}(,[0-9a-f]{64})*$')
}

# --- 4. packages -----------------------------------------------------------------
function Install-Packages {
    Step 'npm packages (buzz-bridge)'
    if (Test-Path (Join-Path $Bridge 'node_modules\nostr-tools')) { Say 'installed'; return }
    if ($DryRun) { Say 'would run npm ci in buzz-bridge'; return }
    Push-Location $Bridge
    try { & npm ci } finally { Pop-Location }
}

# --- 5. services ---------------------------------------------------------------
function Install-NssmService($name, $exe, $params, $logName, $display, $dependsOn) {
    if ($DryRun) {
        $state = if (Get-Service $name -ErrorAction SilentlyContinue) { 'exists - would update' } else { 'would install' }
        Say "$name : $state"
        return
    }
    if (-not (Get-Service $name -ErrorAction SilentlyContinue)) { & nssm install $name $exe | Out-Null }
    & nssm set $name Application $exe | Out-Null
    & nssm set $name AppParameters $params | Out-Null
    & nssm set $name AppDirectory $(if ($name -eq 'ArunachalaBuzzBridge') { $Bridge } else { $Root }) | Out-Null
    & nssm set $name AppStdout (Join-Path $Logs "$logName.out.log") | Out-Null
    & nssm set $name AppStderr (Join-Path $Logs "$logName.err.log") | Out-Null
    & nssm set $name AppRotateFiles 1 | Out-Null
    & nssm set $name AppRotateBytes 5242880 | Out-Null
    & nssm set $name DisplayName $display | Out-Null
    & nssm set $name ObjectName LocalSystem | Out-Null
    & nssm set $name Start SERVICE_AUTO_START | Out-Null
    & nssm set $name AppExit Default Restart | Out-Null
    & nssm set $name AppRestartDelay 10000 | Out-Null
    if ($dependsOn) { & nssm set $name DependOnService $dependsOn | Out-Null }
    Say "$name configured"
}

function Install-Services {
    Step 'Services (NSSM, LocalSystem)'
    if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) { Say 'skipped - NSSM not installed'; return }
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not $DryRun) { New-Item -ItemType Directory -Force $Logs | Out-Null }
    Install-NssmService 'ArunachalaTelemetry' $ps "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'telemetry-daemon.ps1')`"" 'telemetry' 'Arunachala Telemetry' $null
    Install-NssmService 'ArunachalaDashboard' $node 'server.js' 'server' 'Arunachala Dashboard' $null
    Install-NssmService 'ArunachalaBuzzBridge' $node 'bridge.js' 'buzz-bridge' 'Arunachala Buzz Bridge' 'ArunachalaDashboard'
    if ($DryRun) { return }
    foreach ($s in 'ArunachalaTelemetry', 'ArunachalaDashboard', 'ArunachalaBuzzBridge') { Restart-Service $s -Force }
}

# --- 6. n8n dispatch workflow -----------------------------------------------------
function Install-N8n {
    Step 'n8n dispatch workflow'
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Say 'skipped - Docker not installed'; return }
    $running = (& docker ps --filter 'name=^n8n$' --format '{{.Names}}' 2>$null)
    $workflow = Join-Path $Root 'n8n\buzz-dispatch-workflow.json'
    if ($DryRun) {
        if ($running) { Say 'n8n container running - would import the buzz-dispatch workflow' }
        else { Say 'would start n8n (127.0.0.1:5678) and import the buzz-dispatch workflow' }
        return
    }
    if (-not $running) {
        $exists = (& docker ps -a --filter 'name=^n8n$' --format '{{.Names}}' 2>$null)
        if ($exists) { & docker start n8n | Out-Null }
        else { & docker run -d --name n8n --restart unless-stopped -p 127.0.0.1:5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n:latest | Out-Null }
        Start-Sleep -Seconds 15
    }
    & docker cp $workflow n8n:/tmp/buzz-dispatch-workflow.json
    & docker exec n8n n8n import:workflow --input=/tmp/buzz-dispatch-workflow.json
    Say 'Imported. Open http://127.0.0.1:5678, set up the owner account, and switch the buzz-dispatch workflow to Active.'
}

# --- 7. check ----------------------------------------------------------------------
function Test-Install {
    Step 'Check'
    if ($DryRun) { Say 'would check http://127.0.0.1:8787/api/config and /api/telemetry'; return }
    Start-Sleep -Seconds 8
    try {
        $cfg = Invoke-RestMethod http://127.0.0.1:8787/api/config -TimeoutSec 10
        Say "dashboard up - operator $($cfg.operatorName), persona model $($cfg.personaModel)"
    } catch { Problem "dashboard not answering on 8787 - see $Logs\server.err.log" }
    Get-Service Arunachala* | ForEach-Object { Say "$($_.Name): $($_.Status)" }
    Say "Bridge log: $(Get-Content (Join-Path $Logs 'buzz-bridge.out.log') -Tail 1 -ErrorAction SilentlyContinue)"
}

# --- main -------------------------------------------------------------------------
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $DryRun -and -not $elevated) { throw 'Run this from an elevated PowerShell (services need admin), or use -DryRun to check first.' }
if ($DryRun) { Write-Host 'DRY RUN - nothing will be changed.' }

Test-Prerequisites
if ($script:Problems.Count -and -not $DryRun) { throw "Install the missing prerequisites above, then re-run." }
Install-Models
Set-DashboardEnv
Set-BridgeEnv
Install-Packages
Install-Services
Install-N8n
Test-Install

Write-Host ""
if ($script:Problems.Count) { Write-Host "Done with $($script:Problems.Count) item(s) to fix - see MISSING above." -ForegroundColor Yellow }
else { Write-Host 'Done. Next: ask in your Buzz channel - @<your bot name> is everything up?' }
