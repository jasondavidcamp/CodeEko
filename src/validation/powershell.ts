import { spawn, execFile } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { check } from '../policy/boundary';
import { lifetimeBootstrap } from './lifetime';

// Only fixed extension-owned scripts are executable. Repository data arrives over stdin.
const preamble = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Windows PowerShell 5.1 required' }
`;
const scripts = {
  inspect: String.raw`
$modules = @{}
foreach ($name in @('Pester','PSScriptAnalyzer')) {
  $found = Get-Module -ListAvailable -Name $name | Where-Object { $_.Name -eq $name -and ($name -ne 'Pester' -or ($_.Version.Major -in @(4,5) -and (!$request.pesterMajor -or $_.Version.Major -eq [int]$request.pesterMajor))) } | Sort-Object Version -Descending | Select-Object -First 1
  $modules[$name] = if ($found) { $found.Version.ToString() } else { $null }
}
@{ version = $PSVersionTable.PSVersion.ToString(); modules = $modules } | ConvertTo-Json -Compress -Depth 5
`,
  parse: String.raw`
$diagnostics = @()
foreach ($file in $request.files) {
  $tokens = $null; $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseInput([string]$file.text, [ref]$tokens, [ref]$errors)
  foreach ($item in $errors) { $diagnostics += @{ path = $file.path; line = $item.Extent.StartLineNumber; message = $item.Message; rule = $item.ErrorId; severity = 'Error' } }
}
@{ diagnostics = @($diagnostics | Select-Object -First 50); count = $diagnostics.Count } | ConvertTo-Json -Compress -Depth 5
`,
  analyze: String.raw`
Import-Module PSScriptAnalyzer -RequiredVersion $request.version -ErrorAction Stop
$diagnostics = @()
foreach ($file in $request.files) {
  # Explicit built-in settings prevent discovery of repository settings/custom rules.
  $items = @(Invoke-ScriptAnalyzer -ScriptDefinition ([string]$file.text) -Settings @{ IncludeDefaultRules = $true; Severity = @('Error','Warning') } -ErrorAction Stop)
  foreach ($item in $items) { $diagnostics += @{ path = $file.path; line = $item.Line; message = $item.Message; rule = $item.RuleName; severity = [string]$item.Severity } }
}
@{ diagnostics = @($diagnostics | Select-Object -First 50); count = $diagnostics.Count } | ConvertTo-Json -Compress -Depth 5
`,
  pester: String.raw`
Import-Module Pester -RequiredVersion $request.version -ErrorAction Stop
$paths = @($request.paths | ForEach-Object { [string]$_ })
if (([version]$request.version).Major -eq 5) {
  $configuration = New-PesterConfiguration
  $configuration.Run.Path = $paths
  $configuration.Run.PassThru = $true
  $configuration.Output.Verbosity = 'None'
  $configuration.CodeCoverage.Enabled = $false
  $configuration.TestResult.Enabled = $false
  $result = Invoke-Pester -Configuration $configuration
  $details = @($result.Failed | ForEach-Object { @{ name = $_.ExpandedName; message = ($_.ErrorRecord | Out-String) } })
  $containers = @($result.Containers | Where-Object { $_.Result -eq 'Failed' } | ForEach-Object { $_.ErrorRecord | Out-String })
} else {
  $result = Invoke-Pester -Script $paths -PassThru -Show None
  $details = @($result.TestResult | Where-Object { $_.Result -eq 'Failed' } | ForEach-Object { @{ name = $_.Name; message = $_.FailureMessage } })
  $containers = @()
}
@{ total = $result.TotalCount; passed = $result.PassedCount; failed = $result.FailedCount; skipped = $result.SkippedCount; result = [string]$result.Result; failures = @($details | Select-Object -First 20); containerErrors = @($containers | Select-Object -First 10) } | ConvertTo-Json -Compress -Depth 6
`,
  install: String.raw`
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$gallery = Get-PSRepository -Name PSGallery -ErrorAction Stop
if ($gallery.SourceLocation.TrimEnd('/') -ne 'https://www.powershellgallery.com/api/v2') { throw 'Unexpected gallery source' }
$null = Invoke-WebRequest -Uri 'https://www.powershellgallery.com/api/v2' -UseBasicParsing -TimeoutSec 20
$results = @()
foreach ($name in @('Pester','PSScriptAnalyzer')) {
  if ($request.names -contains $name) {
    try {
      if ($name -eq 'Pester') {
        $version = if ($request.pesterMajor -eq 4) { '4.10.1' } else { '5.7.1' }
        Install-Module -Name Pester -RequiredVersion $version -Scope CurrentUser -Repository PSGallery -Force -ErrorAction Stop
      }
      else { Install-Module -Name PSScriptAnalyzer -Scope CurrentUser -Repository PSGallery -Force -ErrorAction Stop }
      $results += @{ name = $name; installed = $true }
    } catch {
      $reason = if ($_.Exception.Message -match 'SkipPublisherCheck') { 'Publisher verification refused this version. No publisher check was bypassed.' } else { 'Installation failed. Check source connectivity, package-provider prerequisites, license, or workstation policy.' }
      $results += @{ name = $name; installed = $false; reason = $reason }
    }
  }
}
@{ modules = $results } | ConvertTo-Json -Compress -Depth 4
`
};
export type Operation = keyof typeof scripts;
export type PowerShellRunner = (operation: Operation, payload: unknown, signal: AbortSignal) => Promise<unknown>;

export function validationEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','ProgramFiles','ProgramFiles(x86)','ProgramData','HOMEDRIVE','HOMEPATH']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  env.PATH = [path.join(windows, 'System32'), path.join(windows, 'System32/WindowsPowerShell/v1.0')].join(';');
  // Ignore inherited project/module search overrides and never inherit API keys.
  env.PSModulePath = [path.join(os.homedir(), 'Documents/WindowsPowerShell/Modules'), path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsPowerShell/Modules'), path.join(windows, 'System32/WindowsPowerShell/v1.0/Modules')].join(';');
  return env;
}

export function createPowerShellRunner(executionPolicy: 'Inherit' | 'RemoteSigned' = 'Inherit'): PowerShellRunner { return async (operation, payload, signal) => {
  check(signal);
  if (process.platform !== 'win32') throw new Error('Windows PowerShell 5.1 is unavailable on this platform.');
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const executable = path.join(windows, process.arch === 'ia32' ? 'Sysnative' : 'System32', 'WindowsPowerShell/v1.0/powershell.exe');
  const duration = operation === 'install' ? 120000 : 60000;
  const script = preamble + lifetimeBootstrap + `\n$request = [ValidationLifetime]::Start(${duration}) | ConvertFrom-Json\n` + scripts[operation];
  return new Promise((resolve, reject) => {
    const policy = executionPolicy === 'RemoteSigned' ? ['-ExecutionPolicy', 'RemoteSigned'] : [];
    const child = spawn(executable, ['-NoLogo','-NoProfile','-NonInteractive', ...policy, '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd: os.tmpdir(), env: validationEnvironment(), windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let output = ''; let bytes = 0; let failure: Error | undefined; let stopping = false; const decoder = new StringDecoder('utf8');
    const stop = (reason: string) => {
      if (stopping) return; stopping = true; failure = new Error(reason);
      if (child.pid) execFile(path.join(windows, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => child.kill());
      else child.kill();
    };
    const abort = () => stop('Validation cancelled.');
    const timer = setTimeout(() => stop('Validation timed out; process tree termination requested.'), duration);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    const collect = (chunk: Buffer, stdout: boolean) => { bytes += chunk.length; if (bytes > 256000) stop('Validation exceeded its output limit.'); else if (stdout) output += decoder.write(chunk); };
    child.stdout.on('data', chunk => collect(chunk, true)); child.stderr.on('data', chunk => collect(chunk, false));
    child.stdin.on('error', () => {});
    child.on('error', () => { failure = new Error('Windows PowerShell could not start.'); });
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      output += decoder.end();
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error('PowerShell validation command failed; no successful result was recorded.'));
      try { resolve(JSON.parse(output.trim())); } catch { reject(new Error('Validation returned an invalid result.')); }
    });
    // Keep the writer open: the validator watches EOF to detect host death.
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
}; }
export const runPowerShell = createPowerShellRunner();
