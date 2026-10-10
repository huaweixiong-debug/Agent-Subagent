<#
  invoke-cli.ps1 - hardened Windows process adapter for agent-loop.

  Reads a JSON payload describing one process invocation, starts that process
  without a shell (no cmd.exe, no Invoke-Expression), captures stdout/stderr as
  UTF-8, enforces a timeout, and writes a result JSON.

  The payload contains the pre-quoted argument string (without argv[0]) built by
  lib/invoke.js using Windows quoting rules. ProcessStartInfo prepends the
  resolved executable (FileName) itself, so the executable path must not be
  duplicated in the arguments. This script never concatenates or evaluates
  user-controlled strings. Environment variables for the child are inherited
  from this PowerShell process (the Node parent sets them on spawn); secret
  values are therefore never serialized into the payload.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PayloadFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$payload = Get-Content -LiteralPath $PayloadFile -Raw -Encoding UTF8 | ConvertFrom-Json

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = [string]$payload.command
$psi.Arguments = [string]$payload.arguments
$psi.WorkingDirectory = [string]$payload.cwd
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

$utf8 = New-Object System.Text.UTF8Encoding($false)
$psi.StandardOutputEncoding = $utf8
$psi.StandardErrorEncoding = $utf8

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi

$timeoutMs = [int]$payload.timeoutMs
if ($timeoutMs -lt 1) { $timeoutMs = 1 }

$watch = [System.Diagnostics.Stopwatch]::StartNew()
[void]$proc.Start()

$stdoutTask = $proc.StandardOutput.ReadToEndAsync()
$stderrTask = $proc.StandardError.ReadToEndAsync()

$stdinText = ''
$stdinFile = [string]$payload.stdinFile
if ($stdinFile -and (Test-Path -LiteralPath $stdinFile)) {
  $raw = Get-Content -LiteralPath $stdinFile -Raw -Encoding UTF8
  if ($null -ne $raw) { $stdinText = [string]$raw }
}

$timedOut = $false

$baseStream = $proc.StandardInput.BaseStream
if ($stdinText.Length -gt 0) {
  $stdinBytes = $utf8.GetBytes($stdinText)
  $writeTask = $baseStream.WriteAsync($stdinBytes, 0, $stdinBytes.Length)
  while (-not $writeTask.IsCompleted) {
    if ($proc.HasExited) { break }
    if ($watch.ElapsedMilliseconds -gt $timeoutMs) { break }
    Start-Sleep -Milliseconds 20
  }
  if (-not $writeTask.IsCompleted -and -not $proc.HasExited) {
    $timedOut = $true
    try { $proc.Kill() } catch { }
    [void]$proc.WaitForExit(10000)
  }
}
try { $baseStream.Close() } catch { }

if (-not $timedOut -and -not $proc.HasExited) {
  $remaining = $timeoutMs - [int]$watch.ElapsedMilliseconds
  if ($remaining -lt 1) { $remaining = 1 }
  $exited = $proc.WaitForExit($remaining)
  if (-not $exited) {
    $timedOut = $true
    try { $proc.Kill() } catch { }
    [void]$proc.WaitForExit(10000)
  }
}

$watch.Stop()

[void]$stdoutTask.Wait(10000)
[void]$stderrTask.Wait(10000)

$stdout = ''
$stderr = ''
try { $stdout = $stdoutTask.Result } catch { }
try { $stderr = $stderrTask.Result } catch { }

$exitCode = -1
try { $exitCode = $proc.ExitCode } catch { }

[System.IO.File]::WriteAllText([string]$payload.stdoutFile, $stdout, $utf8)
[System.IO.File]::WriteAllText([string]$payload.stderrFile, $stderr, $utf8)

$result = [ordered]@{
  schemaVersion = 1
  exitCode = $exitCode
  timedOut = $timedOut
  durationMs = [int64]$watch.ElapsedMilliseconds
}
[System.IO.File]::WriteAllText([string]$payload.resultFile, ($result | ConvertTo-Json -Compress), $utf8)
