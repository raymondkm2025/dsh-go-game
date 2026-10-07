# dsh-go-game install check (read-only).
#
# Scans, in order:
#   1. the plugin package itself (manifest, files, both halves)
#   2. every profile under the harness home: is the bundle registered?
#   3. is the link: dependency actually present in node_modules?
#   4. is the host half live? (GET /dsh-go-game/status)
#
# "registered but not installed" is the only real failure; "not registered" and
# "not loaded" are informational before the first install.
#
# ASCII only on purpose: write/edit tools emit BOM-less files and PowerShell 5.1
# misreads non-ASCII without a BOM.

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg = Get-Content (Join-Path $here 'package.json') -Raw | ConvertFrom-Json
$port = if ($env:DSH_WEB_PORT) { $env:DSH_WEB_PORT } else { '43129' }

Write-Host "dsh-go-game check" -ForegroundColor Cyan
Write-Host ("package : " + $here)

$issues = @()
$infos = @()

# ---- 1. package integrity ---------------------------------------------------
$required = @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js', 'lib\engine.js', 'lib\ai.js', 'lib\page.html', 'lib\page.js')
foreach ($f in $required) {
  if (Test-Path (Join-Path $here $f)) {
    Write-Host ("  ok   " + $f)
  } else {
    Write-Host ("  MISS " + $f) -ForegroundColor Red
    $issues += "missing file: $f"
  }
}
if ($pkg.dsh.bundle.patch) { Write-Host ("  ok   bundle patch declared: " + $pkg.dsh.bundle.patch) } else { $issues += 'package.json has no dsh.bundle.patch' }
if ($pkg.dsh.client) { Write-Host "  ok   client half declared" } else { $issues += 'package.json has no dsh.client block' }

# ---- 2/3. profiles ----------------------------------------------------------
$home2 = $env:APPDATA
if (-not $home2) { $home2 = Join-Path $env:USERPROFILE 'AppData\Roaming' }
$profilesRoot = Join-Path $home2 'dsh-desktop\harness\profiles'
Write-Host ("profiles: " + $profilesRoot)

$registered = $false
$installed = $false
if (Test-Path $profilesRoot) {
  $dirs = Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -notlike '.*' -and $_.Name -ne 'node_modules' -and
    ((Test-Path (Join-Path $_.FullName 'package.json')) -or (Test-Path (Join-Path $_.FullName 'cordis.yml')))
  }
  foreach ($d in $dirs) {
    $manifest = Join-Path $d.FullName 'package.json'
    $text = Get-Content $manifest -Raw
    $inDeps = $text -match '"dsh-go-game"\s*:'
    $inBundles = $text -match '"dsh-go-game"'
    $mod = Join-Path $d.FullName 'node_modules\dsh-go-game'
    $hasModule = Test-Path $mod
    Write-Host ("  profile " + $d.Name + ": deps=" + $inDeps + " bundles=" + $inBundles + " node_modules=" + $hasModule)
    if ($inDeps -and $inBundles) { $registered = $true }
    if ($hasModule) { $installed = $true }
    if ($inDeps -and -not $hasModule) { $issues += ("profile " + $d.Name + ": registered but the link: dependency is not installed in node_modules") }
  }
} else {
  $infos += "profiles directory not found (harness not initialised here?)"
}

if (-not $registered) { $infos += 'not registered in any profile yet - see README for the three install steps' }

# ---- 4. is it live? ---------------------------------------------------------
try {
  $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 -Uri ("http://127.0.0.1:" + $port + "/dsh-go-game/status")
  $body = [Text.Encoding]::UTF8.GetString($res.Content)
  Write-Host ("  live   " + $body) -ForegroundColor Green
} catch {
  Write-Host ("  not loaded yet (HTTP error) - expected before the first restart") -ForegroundColor Yellow
  $infos += "host half not answering on port $port (restart DSH after installing)"
}

# ---- summary ----------------------------------------------------------------
Write-Host ""
if ($issues.Count -eq 0) {
  Write-Host "no blocking issues found" -ForegroundColor Green
} else {
  Write-Host "issues:" -ForegroundColor Red
  foreach ($i in $issues) { Write-Host ("  ! " + $i) -ForegroundColor Red }
}
if ($infos.Count -gt 0) {
  Write-Host "info:"
  foreach ($i in $infos) { Write-Host ("  - " + $i) }
}
if (-not $registered) {
  Write-Host ""
  Write-Host "install steps (run outside DSH, in a normal terminal):"
  Write-Host "  1. add to the active profile package.json:"
  $linkPath = $here -replace '\\','/'
  Write-Host ('     dependencies: "dsh-go-game": "link:' + $linkPath + '"')
  Write-Host '     dsh.profile.bundles: append "dsh-go-game"'
  Write-Host '  2. create node_modules\dsh-go-game in that profile:'
  Write-Host ('     mklink /J "<profile>\node_modules\dsh-go-game" "' + $here + '"')
  Write-Host '  3. restart DSH, then open the Go panel or /dsh-go-game/'
}

exit $(if ($issues.Count -gt 0) { 1 } else { 0 })
