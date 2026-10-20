# ollama-watchdog.ps1 - start Ollama if its API is not answering.
# Run every 5 minutes by the "Arunachala Ollama Watchdog" scheduled task
# (current user, only while logged on - Ollama's models live in this profile).
# Every persona and Hermes run on Ollama, so a quit or crashed Ollama silently
# takes the whole team down; this brings it back within one interval.
# ASCII only (PS 5.1 reads BOM-less .ps1 as Windows-1252).
$ErrorActionPreference = 'Stop'

$OllamaApp = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
$TagsUrl   = 'http://127.0.0.1:11434/api/tags'
$LogFile   = Join-Path $PSScriptRoot 'logs\ollama-watchdog.log'

function Test-Ollama {
    try { Invoke-WebRequest -Uri $TagsUrl -UseBasicParsing -TimeoutSec 5 | Out-Null; return $true }
    catch { return $false }
}

function Write-Log([string]$Message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $LogFile -Value $line -Encoding Ascii
}

if (Test-Ollama) { exit 0 }

if (-not (Test-Path $OllamaApp)) { Write-Log "Ollama down and app not found at $OllamaApp"; exit 1 }
Write-Log 'Ollama API not answering - starting it'
Start-Process -FilePath $OllamaApp -WindowStyle Hidden

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Ollama) { Write-Log 'Ollama back up'; exit 0 }
}
Write-Log 'Ollama still not answering 30 s after start'
exit 1
