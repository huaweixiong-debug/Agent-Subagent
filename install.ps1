<#
  install.ps1 - opt-in installer for the agent-loop Claude Code skill.

  Copies the skill and a usable per-project config (config.json) into
  <Repo>/.claude/skills/agent-loop and records the package path in
  agent-loop.path. The skill supplies that installed config automatically on
  every runner invocation. Refuses to run when the destination already exists
  or the target checkout is dirty. Performs no global, settings, or credential
  changes; it never overwrites files. It adds one clone-local exclude entry so
  installing the skill does not make the checkout appear dirty to the runner.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Repo
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error -Message $Message -ErrorAction Continue
  exit 2
}

function Invoke-Git([string[]]$GitArgs) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & git @GitArgs 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output | Out-String) }
  }
  finally {
    $ErrorActionPreference = $previous
  }
}

if (-not (Test-Path -LiteralPath $Repo -PathType Container)) {
  Fail "repository path does not exist: $Repo"
}
$repoPath = (Resolve-Path -LiteralPath $Repo).Path

$packageRoot = $PSScriptRoot
$skillSource = Join-Path $packageRoot '.claude\skills\agent-loop\SKILL.md'
$configSource = Join-Path $packageRoot 'config.example.json'
if (-not (Test-Path -LiteralPath $skillSource -PathType Leaf)) {
  Fail "package is missing the skill source: $skillSource"
}
if (-not (Test-Path -LiteralPath $configSource -PathType Leaf)) {
  Fail "package is missing the example config: $configSource"
}

$repoProbe = Invoke-Git @('-C', $repoPath, 'rev-parse', '--is-inside-work-tree')
if ($repoProbe.ExitCode -ne 0) {
  Fail "target is not a git checkout: $repoPath"
}

$destDir = Join-Path $repoPath '.claude\skills\agent-loop'
if (Test-Path -LiteralPath $destDir) {
  Fail "destination already exists; refusing to overwrite: $destDir"
}

$statusProbe = Invoke-Git @('-C', $repoPath, 'status', '--porcelain')
if ($statusProbe.ExitCode -ne 0) {
  Fail "cannot read git status for: $repoPath"
}
if ($statusProbe.Output.Trim() -ne '') {
  Fail "target checkout is dirty; commit or stash changes before installing: $repoPath"
}

$excludeProbe = Invoke-Git @('-C', $repoPath, 'rev-parse', '--git-path', 'info/exclude')
if ($excludeProbe.ExitCode -ne 0) {
  Fail "cannot locate clone-local Git exclude file for: $repoPath"
}
$excludePath = $excludeProbe.Output.Trim()
if (-not [System.IO.Path]::IsPathRooted($excludePath)) {
  $excludePath = Join-Path $repoPath $excludePath
}
$excludePath = [System.IO.Path]::GetFullPath($excludePath)
if (-not (Test-Path -LiteralPath $excludePath -PathType Leaf)) {
  Fail "clone-local Git exclude file does not exist: $excludePath"
}
$excludeEntry = '/.claude/skills/agent-loop/'
$excludeText = [System.IO.File]::ReadAllText($excludePath)
$hasExcludeEntry = @($excludeText -split "`r?`n" | Where-Object { $_.Trim() -eq $excludeEntry }).Count -gt 0

New-Item -ItemType Directory -Path $destDir -Force | Out-Null
Copy-Item -LiteralPath $skillSource -Destination (Join-Path $destDir 'SKILL.md')
Copy-Item -LiteralPath $configSource -Destination (Join-Path $destDir 'config.json')

$utf8 = New-Object System.Text.UTF8Encoding($false)
$pathFile = Join-Path $destDir 'agent-loop.path'
[System.IO.File]::WriteAllText($pathFile, $packageRoot + [Environment]::NewLine, $utf8)

if (-not $hasExcludeEntry) {
  $separator = if ($excludeText.Length -gt 0 -and -not $excludeText.EndsWith("`n")) { "`r`n" } else { '' }
  [System.IO.File]::AppendAllText($excludePath, $separator + $excludeEntry + "`r`n", $utf8)
}

Write-Output "installed agent-loop skill to $destDir"
Write-Output "usable per-project config copied to $(Join-Path $destDir 'config.json') (edit it for this project)"
Write-Output "package path recorded in $pathFile"
Write-Output "clone-local Git exclude updated so the installed skill does not dirty the checkout"
exit 0
