# restart-arunachala.ps1 - restart the stack the supported way.
# Daemon and dashboard are NSSM services; never kill their PIDs - NSSM respawns them.
# Run ELEVATED. ASCII only (PS 5.1 reads BOM-less .ps1 as Windows-1252).
$ErrorActionPreference = 'Continue'

Restart-Service ArunachalaTelemetry -Force
Restart-Service ArunachalaDashboard -Force
Restart-Service Cloudflared -Force
Get-Service ArunachalaTelemetry, ArunachalaDashboard, Cloudflared | Format-Table Name, Status -AutoSize
Start-Sleep -Seconds 15

try { $api = (Invoke-WebRequest -Uri 'http://localhost:8787/api/telemetry' -UseBasicParsing -TimeoutSec 10).Content }
catch { Write-Host "dashboard API failed: $($_.Exception.Message)" -ForegroundColor Red; $api = '' }

if ($api -match '"buzz"') {
    $b = (ConvertFrom-Json $api).services.buzz
    Write-Host "OK  buzz online=$($b.online) members=$($b.realMembers) containers=$($b.containers) metrics=$($b.metrics) latency=$($b.latencyMs)ms" -ForegroundColor Green
} elseif ($api -ne '') {
    Write-Host "BROKEN - /api/telemetry returned: $($api.Substring(0,[Math]::Min(120,$api.Length)))" -ForegroundColor Red
}

foreach ($u in 'https://buzz.mytestbed.tech/', 'https://team.mytestbed.tech/') {
    try {
        $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
        $code = $r.StatusCode
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'ERR' }
    }
    Write-Host "  $u -> $code"
}
Write-Host '  expect: buzz 200 (relay NIP-11 JSON), team 404 (deliberately un-tunnelled)'