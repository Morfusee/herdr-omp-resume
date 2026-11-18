#!/usr/bin/env pwsh
#Requires -Version 7.0
$ErrorActionPreference = 'Stop'

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installer = Join-Path $repo 'install.ps1'
$sourceRoot = Join-Path $repo 'mods/omp-resume'
$pwsh = if ($IsWindows) { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'pwsh' }
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('herdr-omp-resume-install-' + [guid]::NewGuid().ToString('N'))
$fakeHome = Join-Path $sandbox 'fake-home'
$junction = $null

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Equal {
  param($Expected, $Actual, [string]$Message)
  if ($Expected -ne $Actual) {
    throw "Assertion failed: $Message`n  expected: $Expected`n  actual:   $Actual"
  }
}

function Assert-FileEqual {
  param([string]$ExpectedPath, [string]$ActualPath, [string]$Message)
  Assert-True (Test-Path -LiteralPath $ActualPath -PathType Leaf) "$Message (missing '$ActualPath')"
  $expected = (Get-FileHash -LiteralPath $ExpectedPath -Algorithm SHA256).Hash
  $actual = (Get-FileHash -LiteralPath $ActualPath -Algorithm SHA256).Hash
  Assert-Equal $expected $actual $Message
}

function Assert-FileText {
  param([string]$Path, [string]$Expected, [string]$Message)
  Assert-True (Test-Path -LiteralPath $Path -PathType Leaf) "$Message (missing '$Path')"
  $actual = Get-Content -LiteralPath $Path -Raw
  if ($actual -ne $Expected) { throw "Assertion failed: $Message`n  path: $Path" }
}

function Write-Fixture {
  param([string]$Path, [string]$Content)
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
  Set-Content -LiteralPath $Path -Value $Content -NoNewline
}

function Remove-JunctionFixture {
  param([string]$Path)
  if ([string]::IsNullOrEmpty($Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { return }
  try {
    [IO.Directory]::Delete($Path)
  } catch {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Installer {
  param(
    [string]$Script = $script:installer,
    [string[]]$Arguments = @(),
    [hashtable]$Environment = @{}
  )
  $effective = @{
    HOME = $fakeHome
    USERPROFILE = $fakeHome
    HERDR_APP_HOME = $null
    OMP_PROFILE = $null
    PI_CODING_AGENT_DIR = $null
  }
  foreach ($key in $Environment.Keys) { $effective[$key] = $Environment[$key] }

  $saved = @{}
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    foreach ($key in $effective.Keys) {
      $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
      [Environment]::SetEnvironmentVariable($key, $effective[$key], 'Process')
    }
    $ErrorActionPreference = 'Continue'
    $output = & $pwsh -NoProfile -File $Script @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    [pscustomobject]@{
      ExitCode = $exitCode
      Output = (($output | ForEach-Object { "$_" }) -join [Environment]::NewLine)
    }
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
    foreach ($key in $saved.Keys) {
      [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
    }
  }
}

try {
  [IO.Directory]::CreateDirectory($fakeHome) | Out-Null

  $oldHook = "// previous local hook version`n"
  $sessions = '{"version":1,"sessions":[]}'
  $shared = '{"theme":"dark"}'
  $layout = '{"layout":"default"}'

  $appHome = Join-Path $sandbox 'app'
  $ompHome = Join-Path $sandbox 'omp'
  Write-Fixture (Join-Path $appHome 'mods/omp-resume/main.js') "// stale owned mod copy`n"
  Write-Fixture (Join-Path $appHome 'mods/omp-resume/gpui-kit.d.ts') "// generated declarations`n"
  Write-Fixture (Join-Path $appHome 'mods/omp-resume/jsconfig.json') '{"compilerOptions":{}}'
  Write-Fixture (Join-Path $appHome 'mods/other-mod/main.js') "// other mod`n"
  Write-Fixture (Join-Path $appHome 'omp-sessions.json') $sessions
  Write-Fixture (Join-Path $appHome 'shared.json') $shared
  Write-Fixture (Join-Path $appHome 'layouts/main.json') $layout
  Write-Fixture (Join-Path $ompHome 'extensions/other-extension.ts') "// other extension`n"
  Write-Fixture (Join-Path $ompHome 'extensions/herdr-omp-resume.ts') $oldHook

  $result = Invoke-Installer -Arguments @('-AppHome', $appHome, '-OmpAgentHome', $ompHome)
  Assert-Equal 0 $result.ExitCode "install should succeed. Output:`n$($result.Output)"

  $modHome = Join-Path $appHome 'mods/omp-resume'
  foreach ($relative in @('main.js', 'registry.js', 'mod.json', 'LICENSE', 'omp/revive.ts')) {
    Assert-FileEqual (Join-Path $sourceRoot $relative) (Join-Path $modHome $relative) "installed $relative"
  }
  $hookTarget = Join-Path $ompHome 'extensions/herdr-omp-resume.ts'
  Assert-FileEqual (Join-Path $sourceRoot 'omp/revive.ts') $hookTarget 'installed hook'

  $hookItem = Get-Item -LiteralPath $hookTarget -Force
  $hookIsRegular = (-not $hookItem.LinkType) -and (($hookItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
  Assert-True $hookIsRegular 'hook must be installed as a regular file, not a link'

  $modItem = Get-Item -LiteralPath $modHome -Force
  $modIsReal = $modItem.PSIsContainer -and (-not $modItem.LinkType) -and (($modItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
  Assert-True $modIsReal 'mod target must be a real directory'

  $extensionsDir = Join-Path $ompHome 'extensions'
  $backups = @(Get-ChildItem -LiteralPath $extensionsDir -Filter 'herdr-omp-resume.ts.bak*' -Force)
  Assert-Equal 1 $backups.Count 'exactly one backup for the differing preexisting hook'
  Assert-FileText $backups[0].FullName $oldHook 'backup must preserve the preexisting hook content'

  Assert-FileText (Join-Path $modHome 'gpui-kit.d.ts') "// generated declarations`n" 'generated declarations must be preserved'
  Assert-FileText (Join-Path $modHome 'jsconfig.json') '{"compilerOptions":{}}' 'generated jsconfig must be preserved'
  Assert-FileText (Join-Path $appHome 'mods/other-mod/main.js') "// other mod`n" 'other mods must be preserved'
  Assert-FileText (Join-Path $appHome 'omp-sessions.json') $sessions 'runtime session state must be preserved'
  Assert-FileText (Join-Path $appHome 'shared.json') $shared 'shared state must be preserved'
  Assert-FileText (Join-Path $appHome 'layouts/main.json') $layout 'layouts must be preserved'
  Assert-FileText (Join-Path $extensionsDir 'other-extension.ts') "// other extension`n" 'other extensions must be preserved'

  $mainTarget = Join-Path $modHome 'main.js'
  $sentinel = [datetime]::new(2000, 1, 2, 3, 4, 5, [System.DateTimeKind]::Utc)
  [IO.File]::SetLastWriteTimeUtc($hookTarget, $sentinel)
  [IO.File]::SetLastWriteTimeUtc($mainTarget, $sentinel)
  $hookMtime = (Get-Item -LiteralPath $hookTarget -Force).LastWriteTimeUtc
  $mainMtime = (Get-Item -LiteralPath $mainTarget -Force).LastWriteTimeUtc
  $result = Invoke-Installer -Arguments @('-AppHome', $appHome, '-OmpAgentHome', $ompHome)
  Assert-Equal 0 $result.ExitCode "reinstall should succeed. Output:`n$($result.Output)"
  $backupsAfter = @(Get-ChildItem -LiteralPath $extensionsDir -Filter 'herdr-omp-resume.ts.bak*' -Force)
  Assert-Equal 1 $backupsAfter.Count 'idempotent reinstall must not create another backup'
  Assert-Equal $hookMtime (Get-Item -LiteralPath $hookTarget -Force).LastWriteTimeUtc 'reinstall must not rewrite an unchanged hook'
  Assert-Equal $mainMtime (Get-Item -LiteralPath $mainTarget -Force).LastWriteTimeUtc 'reinstall must not rewrite an unchanged mod file'

  $whatIfApp = Join-Path $sandbox 'whatif-app'
  $whatIfOmp = Join-Path $sandbox 'whatif-omp'
  $whatIfMain = Join-Path $whatIfApp 'mods/omp-resume/main.js'
  $whatIfRegistry = Join-Path $whatIfApp 'mods/omp-resume/registry.js'
  $whatIfHook = Join-Path $whatIfOmp 'extensions/herdr-omp-resume.ts'
  Write-Fixture $whatIfMain "// stale main`n"
  Write-Fixture $whatIfHook "// stale hook`n"
  $whatIfMainHash = (Get-FileHash -LiteralPath $whatIfMain -Algorithm SHA256).Hash
  $whatIfHookHash = (Get-FileHash -LiteralPath $whatIfHook -Algorithm SHA256).Hash
  $result = Invoke-Installer -Arguments @('-AppHome', $whatIfApp, '-OmpAgentHome', $whatIfOmp, '-WhatIf')
  Assert-Equal 0 $result.ExitCode "WhatIf should succeed. Output:`n$($result.Output)"
  Assert-True ($result.Output -match 'WhatIf') 'WhatIf must describe the planned actions'
  Assert-Equal $whatIfMainHash (Get-FileHash -LiteralPath $whatIfMain -Algorithm SHA256).Hash 'WhatIf must not modify an existing mod file'
  Assert-Equal $whatIfHookHash (Get-FileHash -LiteralPath $whatIfHook -Algorithm SHA256).Hash 'WhatIf must not modify an existing hook'
  Assert-True (-not (Test-Path -LiteralPath $whatIfRegistry)) 'WhatIf must not create a missing target file'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $whatIfApp 'mods/omp-resume/omp'))) 'WhatIf must not create directories'
  $whatIfBackups = @(Get-ChildItem -LiteralPath (Join-Path $whatIfOmp 'extensions') -Filter '*.bak*' -Force)
  Assert-Equal 0 $whatIfBackups.Count 'WhatIf must not create backups'

  $freshApp = Join-Path $sandbox 'whatif-fresh-app'
  $freshOmp = Join-Path $sandbox 'whatif-fresh-omp'
  $result = Invoke-Installer -Arguments @('-AppHome', $freshApp, '-OmpAgentHome', $freshOmp, '-WhatIf')
  Assert-Equal 0 $result.ExitCode "WhatIf on a fresh target should succeed. Output:`n$($result.Output)"
  Assert-True (-not (Test-Path -LiteralPath $freshApp)) 'WhatIf must not create AppHome'
  Assert-True (-not (Test-Path -LiteralPath $freshOmp)) 'WhatIf must not create OmpAgentHome'

  $linkApp = Join-Path $sandbox 'link-app'
  $realMods = Join-Path $sandbox 'link-real-mods'
  [IO.Directory]::CreateDirectory($linkApp) | Out-Null
  [IO.Directory]::CreateDirectory($realMods) | Out-Null
  $junction = Join-Path $linkApp 'mods'
  New-Item -ItemType Junction -Path $junction -Target $realMods | Out-Null
  $linkOmp = Join-Path $sandbox 'link-omp'
  $result = Invoke-Installer -Arguments @('-AppHome', $linkApp, '-OmpAgentHome', $linkOmp)
  Assert-True ($result.ExitCode -ne 0) "linked target directory must be refused. Output:`n$($result.Output)"
  Assert-True ($result.Output -match 'link|reparse') 'link refusal must explain the link or reparse point'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $realMods 'omp-resume'))) 'must not write through a linked directory'
  Assert-True (-not (Test-Path -LiteralPath $linkOmp)) 'link refusal must happen before creating other targets'
  Remove-JunctionFixture $junction
  $junction = $null

  foreach ($name in @('OMP_PROFILE', 'PI_CODING_AGENT_DIR')) {
    $suffix = $name.ToLowerInvariant()
    $refuseApp = Join-Path $sandbox "refuse-$suffix-app"
    $refuseHome = Join-Path $fakeHome "refuse-$suffix"
    [IO.Directory]::CreateDirectory($refuseHome) | Out-Null
    $environment = @{
      HOME = $refuseHome
      USERPROFILE = $refuseHome
      HERDR_APP_HOME = $refuseApp
      OMP_PROFILE = $null
      PI_CODING_AGENT_DIR = $null
    }
    $environment[$name] = 'test-profile'
    $result = Invoke-Installer -Environment $environment
    Assert-True ($result.ExitCode -ne 0) "$name must refuse an implicit OMP agent home. Output:`n$($result.Output)"
    Assert-True ($result.Output -match 'OmpAgentHome') "$name refusal must mention -OmpAgentHome"
    Assert-True (-not (Test-Path -LiteralPath $refuseApp)) "$name refusal must not create AppHome"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $refuseHome '.omp'))) "$name refusal must not create an OMP home"
  }

  $explicitApp = Join-Path $sandbox 'explicit-app'
  $explicitOmp = Join-Path $sandbox 'explicit-omp'
  $result = Invoke-Installer -Arguments @('-AppHome', $explicitApp, '-OmpAgentHome', $explicitOmp) -Environment @{ OMP_PROFILE = 'test-profile' }
  Assert-Equal 0 $result.ExitCode "explicit -OmpAgentHome must be allowed with OMP_PROFILE set. Output:`n$($result.Output)"
  Assert-FileEqual (Join-Path $sourceRoot 'omp/revive.ts') (Join-Path $explicitOmp 'extensions/herdr-omp-resume.ts') 'explicit OMP home must install the hook'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $explicitApp 'mods/omp-resume/jsconfig.json'))) 'allowlist must not install generated files'

  $envApp = Join-Path $sandbox 'env-app'
  $envOmp = Join-Path $sandbox 'env-omp'
  $result = Invoke-Installer -Arguments @('-OmpAgentHome', $envOmp) -Environment @{ HERDR_APP_HOME = $envApp }
  Assert-Equal 0 $result.ExitCode "HERDR_APP_HOME should supply AppHome. Output:`n$($result.Output)"
  Assert-FileEqual (Join-Path $sourceRoot 'main.js') (Join-Path $envApp 'mods/omp-resume/main.js') 'HERDR_APP_HOME must supply the default AppHome'

  $sourceMain = Join-Path $sourceRoot 'main.js'
  $sourceHash = (Get-FileHash -LiteralPath $sourceMain -Algorithm SHA256).Hash
  $boundaryOmp = Join-Path $sandbox 'boundary-omp'
  $result = Invoke-Installer -Arguments @('-AppHome', $repo, '-OmpAgentHome', $boundaryOmp)
  Assert-True ($result.ExitCode -ne 0) "installing into the repository must be refused. Output:`n$($result.Output)"
  Assert-True ($result.Output -match 'repository') 'boundary refusal must mention the repository'
  Assert-Equal $sourceHash (Get-FileHash -LiteralPath $sourceMain -Algorithm SHA256).Hash 'boundary refusal must not modify source files'
  Assert-True (-not (Test-Path -LiteralPath $boundaryOmp)) 'boundary refusal must not create targets'

  $incompleteCheckout = Join-Path $sandbox 'incomplete-checkout'
  [IO.Directory]::CreateDirectory($incompleteCheckout) | Out-Null
  $incompleteInstaller = Join-Path $incompleteCheckout 'install.ps1'
  [IO.File]::Copy($installer, $incompleteInstaller, $false)
  $missingApp = Join-Path $sandbox 'missing-app'
  $missingOmp = Join-Path $sandbox 'missing-omp'
  $result = Invoke-Installer -Script $incompleteInstaller -Arguments @('-AppHome', $missingApp, '-OmpAgentHome', $missingOmp)
  Assert-True ($result.ExitCode -ne 0) "an incomplete checkout must be refused. Output:`n$($result.Output)"
  Assert-True ($result.Output -match 'Missing required source file') 'source validation must name the missing source'
  Assert-True (-not (Test-Path -LiteralPath $missingApp)) 'source validation must not create AppHome'
  Assert-True (-not (Test-Path -LiteralPath $missingOmp)) 'source validation must not create OmpAgentHome'

  Write-Host 'All installer tests passed.'
} catch {
  Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if ($junction) {
    Remove-JunctionFixture $junction
  }
  if (Test-Path -LiteralPath $sandbox) {
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
  }
}
