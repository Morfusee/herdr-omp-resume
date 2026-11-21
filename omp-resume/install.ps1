#!/usr/bin/env pwsh
<#
.SYNOPSIS
Installs the Herdr omp-resume mod and its self-contained OMP hook.

.DESCRIPTION
Copies the five owned files from mods/omp-resume beside this script into
<AppHome>/mods/omp-resume and copies the hook to
<OmpAgentHome>/extensions/herdr-omp-resume.ts as a regular file. Runtime state,
layouts, other mods and other extensions are never touched. Existing generated
files next to the mod (for example gpui-kit.d.ts and jsconfig.json) are left
alone because only the explicit allowlist below is installed.

.PARAMETER AppHome
Herdr application home. Defaults to $env:HERDR_APP_HOME, then
$HOME/.config/herdr-app.

.PARAMETER OmpAgentHome
OMP agent home. Defaults to $HOME/.omp/agent. It must be passed explicitly when
OMP_PROFILE or PI_CODING_AGENT_DIR is set, so the hook is not installed into an
unexpected profile.

.EXAMPLE
pwsh -NoProfile -File ./omp-resume/install.ps1

Run from the collection checkout root.

.EXAMPLE
pwsh -NoProfile -File ./install.ps1 -AppHome "$HOME/.config/herdr-app" -OmpAgentHome "$HOME/.omp/agent" -WhatIf

Run from the omp-resume package folder.
#>
#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$AppHome,
  [string]$OmpAgentHome
)

$ErrorActionPreference = 'Stop'

$script:PathComparison = if ($IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
$script:OwnedFiles = @('main.js', 'registry.js', 'mod.json', 'LICENSE', 'omp/revive.ts')

function Resolve-InstallPath {
  param([string]$Path, [string]$Name)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "$Name must not be empty."
  }
  try {
    $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  } catch {
    throw "$Name '$Path' is not a valid filesystem path: $($_.Exception.Message)"
  }
  [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($resolved))
}

function Test-PathEqual {
  param([string]$Left, [string]$Right)
  [string]::Equals($Left, $Right, $script:PathComparison)
}

function Test-PathWithin {
  param([string]$Path, [string]$Parent)
  $prefix = if ([IO.Path]::EndsInDirectorySeparator($Parent)) {
    $Parent
  } else {
    $Parent + [IO.Path]::DirectorySeparatorChar
  }
  $Path.StartsWith($prefix, $script:PathComparison)
}

function Test-ReparsePoint {
  param($Item)
  (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or ([bool]$Item.LinkType)
}

function Assert-NoReparse {
  param([string]$Path, [string]$Label)
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrEmpty($root)) {
    throw "Cannot determine the filesystem root of '$Path'."
  }
  $current = $root
  foreach ($part in @($full.Substring($root.Length) -split '[\\/]')) {
    if ([string]::IsNullOrEmpty($part)) { continue }
    $current = [IO.Path]::Combine($current, $part)
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if (Test-ReparsePoint $item) {
      throw "$Label '$Path' is or contains a link or reparse point at '$current'. Refusing to follow it."
    }
  }
}

function Assert-TargetKind {
  param([string]$Path, [string]$Label, [switch]$Directory)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { return }
  if ($Directory) {
    if (-not $item.PSIsContainer) {
      throw "$Label '$Path' exists and is not a directory."
    }
  } elseif ($item.PSIsContainer) {
    throw "$Label '$Path' exists and is a directory; expected a file."
  }
}

function Test-FileEqual {
  param([string]$Source, [string]$Target)
  $item = Get-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
  if ($null -eq $item -or $item.PSIsContainer) { return $false }
  $sourceItem = Get-Item -LiteralPath $Source -Force
  if ($item.Length -ne $sourceItem.Length) { return $false }
  (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash
}

function Get-BackupPath {
  param([string]$Path)
  $candidate = "$Path.bak"
  $index = 2
  while ($null -ne (Get-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue)) {
    $candidate = "$Path.bak.$index"
    $index++
  }
  $candidate
}

try {
  $explicitAppHome = $PSBoundParameters.ContainsKey('AppHome') -and -not [string]::IsNullOrWhiteSpace($AppHome)
  $explicitOmpHome = $PSBoundParameters.ContainsKey('OmpAgentHome') -and -not [string]::IsNullOrWhiteSpace($OmpAgentHome)

  if (-not $explicitOmpHome) {
    $overrides = @()
    foreach ($name in @('OMP_PROFILE', 'PI_CODING_AGENT_DIR')) {
      if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        $overrides += $name
      }
    }
    if ($overrides.Count -gt 0) {
      throw "Refusing to guess the OMP agent home: $($overrides -join ' and ') is set. Pass -OmpAgentHome <path> explicitly."
    }
  }

  $envAppHome = [Environment]::GetEnvironmentVariable('HERDR_APP_HOME')
  $needsHome = (-not $explicitAppHome -and [string]::IsNullOrWhiteSpace($envAppHome)) -or (-not $explicitOmpHome)
  if ($needsHome -and [string]::IsNullOrWhiteSpace($HOME)) {
    throw 'Cannot determine the user home directory. Pass -AppHome and -OmpAgentHome explicitly.'
  }

  if (-not $explicitAppHome) {
    $AppHome = if ([string]::IsNullOrWhiteSpace($envAppHome)) { Join-Path $HOME '.config/herdr-app' } else { $envAppHome }
  }
  if (-not $explicitOmpHome) {
    $OmpAgentHome = Join-Path $HOME '.omp/agent'
  }

  $AppHome = Resolve-InstallPath -Path $AppHome -Name 'AppHome'
  $OmpAgentHome = Resolve-InstallPath -Path $OmpAgentHome -Name 'OmpAgentHome'

  $sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'mods/omp-resume'))
  $sources = @{}
  foreach ($relative in $script:OwnedFiles) {
    $source = [IO.Path]::GetFullPath((Join-Path $sourceRoot $relative))
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Missing required source file: '$source'. Keep install.ps1 and mods/omp-resume together in the omp-resume package."
    }
    $sources[$relative] = $source
  }

  $modTarget = [IO.Path]::GetFullPath((Join-Path $AppHome 'mods/omp-resume'))
  $hookTarget = [IO.Path]::GetFullPath((Join-Path $OmpAgentHome 'extensions/herdr-omp-resume.ts'))
  $extensionTarget = [IO.Path]::GetDirectoryName($hookTarget)

  $checkoutRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  foreach ($target in @($modTarget, $hookTarget)) {
    if ((Test-PathEqual $target $checkoutRoot) -or (Test-PathWithin $target $checkoutRoot)) {
      throw "Refusing to write '$target' inside the collection checkout. Choose an AppHome and OmpAgentHome outside '$checkoutRoot'."
    }
  }

  Assert-NoReparse -Path $AppHome -Label 'Target directory'
  Assert-TargetKind -Path $AppHome -Label 'Target directory' -Directory
  Assert-NoReparse -Path $modTarget -Label 'Target directory'
  Assert-TargetKind -Path $modTarget -Label 'Target directory' -Directory
  Assert-NoReparse -Path $OmpAgentHome -Label 'Target directory'
  Assert-TargetKind -Path $OmpAgentHome -Label 'Target directory' -Directory
  Assert-NoReparse -Path $extensionTarget -Label 'Target directory'
  Assert-TargetKind -Path $extensionTarget -Label 'Target directory' -Directory
  Assert-NoReparse -Path $hookTarget -Label 'Target file'
  Assert-TargetKind -Path $hookTarget -Label 'Target file'

  $pending = [System.Collections.Generic.List[object]]::new()
  foreach ($relative in $script:OwnedFiles) {
    $source = $sources[$relative]
    $target = [IO.Path]::GetFullPath((Join-Path $modTarget $relative))
    Assert-NoReparse -Path $target -Label 'Target file'
    Assert-TargetKind -Path $target -Label 'Target file'
    if (-not (Test-FileEqual -Source $source -Target $target)) {
      $pending.Add([pscustomobject]@{ Source = $source; Target = $target; Backup = $false })
    }
  }
  if (-not (Test-FileEqual -Source $sources['omp/revive.ts'] -Target $hookTarget)) {
    $pending.Add([pscustomobject]@{ Source = $sources['omp/revive.ts']; Target = $hookTarget; Backup = $true })
  }

  if ($WhatIfPreference) {
    Write-Host "WhatIf: would install the omp-resume mod into '$modTarget' and the hook into '$hookTarget'."
    if ($pending.Count -eq 0) {
      Write-Host 'WhatIf: all owned files are already up to date; nothing to do.'
    } else {
      foreach ($entry in $pending) {
        $verb = if (Test-Path -LiteralPath $entry.Target -PathType Leaf) { 'update' } else { 'create' }
        $backupNote = if ($entry.Backup -and (Test-Path -LiteralPath $entry.Target -PathType Leaf)) {
          ' (existing file would be backed up first)'
        } else {
          ''
        }
        Write-Host "WhatIf: would $verb '$($entry.Target)'$backupNote"
      }
    }
    return
  }

  if (-not $PSCmdlet.ShouldProcess($modTarget, 'Install omp-resume files')) {
    return
  }

  $directories = @($pending | ForEach-Object { [IO.Path]::GetDirectoryName($_.Target) } | Sort-Object -Unique)
  foreach ($directory in $directories) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
      [IO.Directory]::CreateDirectory($directory) | Out-Null
      Write-Host "Created directory '$directory'."
    }
  }

  foreach ($entry in $pending) {
    if ($entry.Backup -and (Test-Path -LiteralPath $entry.Target -PathType Leaf)) {
      $backup = Get-BackupPath -Path $entry.Target
      [IO.File]::Copy($entry.Target, $backup, $false)
      Write-Host "Backed up '$($entry.Target)' to '$backup'."
    }
    [IO.File]::Copy($entry.Source, $entry.Target, $true)
    Write-Host "Installed '$($entry.Target)'."
  }

  if ($pending.Count -eq 0) {
    Write-Host 'omp-resume is already up to date.'
  }
  Write-Host "Mod home: '$modTarget'"
  Write-Host "Hook: '$hookTarget'"
  Write-Host "Verify the mod with: herdr-app check '$modTarget'"
} catch {
  [Console]::Error.WriteLine("install.ps1: error: $($_.Exception.Message)")
  exit 1
}
