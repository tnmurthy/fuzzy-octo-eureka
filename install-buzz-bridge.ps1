# install-buzz-bridge.ps1 - install buzz-bridge\bridge.js as the NSSM service
# "ArunachalaBuzzBridge", configured like ArunachalaDashboard (LocalSystem,
# logs\ with rotation, auto-start). Safe to re-run: it updates the settings.
# Run ELEVATED. ASCII only (PS 5.1 reads BOM-less .ps1 as Windows-1252).
$ErrorActionPreference = 'Stop'

$Name    = 'ArunachalaBuzzBridge'
$Root    = $PSScriptRoot
$Bridge  = Join-Path $Root 'buzz-bridge'
$Logs    = Join-Path $Root 'logs'
$Node    = 'C:\Program Files\nodejs\node.exe'
# Same NSSM binary the other Arunachala services use.
$Nssm = (Get-CimInstance Win32_Service -Filter "Name='ArunachalaDashboard'").PathName.Trim('"')
if (-not (Test-Path $Nssm)) { throw "NSSM not found (looked at ArunachalaDashboard's binary: $Nssm)" }
if (-not (Test-Path (Join-Path $Bridge '.env'))) { throw 'buzz-bridge\.env is missing - it holds the TypeSafe key and the bot identity' }
if (-not (Test-Path (Join-Path $Bridge 'node_modules\nostr-tools'))) { throw 'Run "npm ci" in buzz-bridge first' }

if (-not (Get-Service $Name -ErrorAction SilentlyContinue)) {
    & $Nssm install $Name $Node 'bridge.js' | Out-Null
}
& $Nssm set $Name Application $Node | Out-Null
& $Nssm set $Name AppParameters 'bridge.js' | Out-Null
& $Nssm set $Name AppDirectory $Bridge | Out-Null
& $Nssm set $Name AppStdout (Join-Path $Logs 'buzz-bridge.out.log') | Out-Null
& $Nssm set $Name AppStderr (Join-Path $Logs 'buzz-bridge.err.log') | Out-Null
& $Nssm set $Name AppRotateFiles 1 | Out-Null
& $Nssm set $Name AppRotateBytes 5242880 | Out-Null
& $Nssm set $Name DisplayName 'Arunachala Buzz Bridge' | Out-Null
& $Nssm set $Name Description 'Lets the operator talk to the Arunachala AI team from Buzz; TypeSafe routes each message.' | Out-Null
& $Nssm set $Name Start SERVICE_AUTO_START | Out-Null
& $Nssm set $Name DependOnService ArunachalaDashboard | Out-Null
& $Nssm set $Name AppExit Default Restart | Out-Null
& $Nssm set $Name AppRestartDelay 10000 | Out-Null

Restart-Service $Name -Force
Start-Sleep -Seconds 8
Get-Service $Name | Format-Table Name, Status, StartType -AutoSize
Get-Content (Join-Path $Logs 'buzz-bridge.out.log') -Tail 3
