# Windows Firewall rules that complete the guarantee.
# KnockDesk's outbound network becomes entirely owner-controlled at the OS
# level, which covers the Electron guard cannot: the Python and Node sidecars.
#
# Two blocks, in increasing severity:
#   1. Block outbound for every KnockDesk binary, then allow the AI providers.
#   2. KNOCKDESK_FIREWALL_AIRGAP=1 blocks outbound with no exceptions.
#
# Run in an elevated PowerShell. -WhatIf is on by default so nothing changes
# until you remove it.

param()

$ErrorActionPreference = 'Stop'

$rules = 'KnockDesk Outbound'
$binDir = Join-Path $env:LOCALAPPDATA 'KnockDesk'
$airgap = ($env:KNOCKDESK_FIREWALL_AIRGAP -eq '1')

# every executable the app can spawn, including the bundled runtimes
$targets = @()
foreach ($rel in @(
    'KnockDesk.exe',
    'resources\hermes-runtime\venv\Scripts\hermes.exe',
    'resources\hermes-runtime\python\python.exe',
    'resources\bin\agent-browser.exe',
    'resources\agent-town-dist\server.js'
  )) {
  $p = Join-Path $binDir $rel
  if (Test-Path $p) { $targets += $p }
}

if (-not $targets) { Write-Output 'no KnockDesk binaries found under ' $binDir; exit 1 }

$providers = @(
  'generativelanguage.googleapis.com',
  'googleapis.com',
  'openrouter.ai',
  'api.openai.com',
  'api.groq.com',
  'api.moonshot.cn'
)

Write-Output 'Targets:'
$targets | ForEach-Object { '   ' + $_ }
Write-Output ('Mode: ' + $(if ($airgap) { 'AIRGAP (no exceptions)' } else { 'strict (providers allowed)' }))

# clean slate so this script is idempotent
Get-NetFirewallRule -DisplayName $rules -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# the blanket outbound block
foreach ($t in $targets) {
  New-NetFirewallRule -DisplayName $rules -Direction Outbound -Program $t -Action Block -Enabled True -Profile Any -WhatIf |
    Out-Null
}

if (-not $airgap) {
  # provider allow-rules must be evaluated before the block, hence lower priority.
  # Windows Firewall takes addresses, not names, so resolve the providers here and
  # note that CDN-backed providers can change address: refresh this rule set when
  # a provider starts failing.
  $i = 0
  foreach ($t in $targets) {
    $ips = @()
    foreach ($prov in $providers) {
      try {
        $resolved = Resolve-DnsName -Name $prov -Type A -ErrorAction Stop | Where-Object { $_.IPAddress }
        $ips += ($resolved | ForEach-Object { $_.IPAddress } | Sort-Object -Unique)
      } catch {
        Write-Output ("   could not resolve {0}: {1}" -f $prov, $_.Exception.Message)
      }
    }
    $ips = $ips | Sort-Object -Unique
    if ($ips) {
      New-NetFirewallRule -DisplayName "$rules Allow AI providers" -Direction Outbound -Program $t `
        -Action Allow -Enabled True -Profile Any -RemoteAddress $ips -WhatIf | Out-Null
      Write-Output ('   allow-rule for {0}: {1} addresses' -f (Split-Path $t -Leaf), $ips.Count)
    }
    $i++
  }
  Write-Output "Provider allow-rules that would be created: $i"
}

Write-Output 'Re-run without -WhatIf (elevated) to apply.'
