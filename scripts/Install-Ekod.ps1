#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$BuildOnly,
    [switch]$RunTests,
    [string]$CodeCommand = 'code.cmd'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE. Installation stopped."
    }
}

Push-Location -LiteralPath $repoRoot
try {
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $npm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    Get-Command git.exe -CommandType Application -ErrorAction Stop | Out-Null
    $nodeVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw 'Node.js 22 or newer, including npm, is required. Use an approved installation and reopen your terminal.'
    }
    if (-not $BuildOnly) {
        $code = Get-Command $CodeCommand -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $code -and $CodeCommand -eq 'code.cmd' -and $env:LOCALAPPDATA) {
            $candidate = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
            $code = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        }
        if (-not $code) { throw 'VS Code CLI not found. Add its bin directory to PATH or pass -CodeCommand with the full path to code.cmd.' }
    }

    Write-Host 'Installing locked build dependencies into this clone...'
    Invoke-Checked $npm @('ci', '--include=dev', '--no-audit', '--no-fund')
    if ($RunTests) { Invoke-Checked $npm @('test') }
    Write-Host 'Building and packaging EKOD locally...'
    Invoke-Checked $npm @('run', 'package')
    $vsix = Join-Path $repoRoot 'ekod.vsix'
    if (-not (Test-Path -LiteralPath $vsix -PathType Leaf)) { throw 'Packaging did not produce ekod.vsix.' }
    Write-Host "Built $vsix"
    Write-Host ('SHA256: ' + (Get-FileHash -LiteralPath $vsix -Algorithm SHA256).Hash)
    if (-not $BuildOnly) {
        Write-Host 'Installing EKOD into the current VS Code user profile...'
        Invoke-Checked $code.Source @('--install-extension', $vsix, '--force')
        $installed = & $code.Source --list-extensions --show-versions
        if ($LASTEXITCODE -ne 0) { throw 'Could not verify the installed extension.' }
        $manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
        $expected = "$($manifest.publisher).$($manifest.name)@$($manifest.version)"
        if ($installed -notcontains $expected) { throw "VS Code did not report $expected as installed." }
        Write-Host "Installed $expected. Reload VS Code, then open EKOD Settings to configure your endpoint and model."
    }
} finally {
    Pop-Location
}
