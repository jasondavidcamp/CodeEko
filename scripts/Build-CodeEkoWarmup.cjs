// Development-only generator. The generated PS1 runs without Node or a checkout.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const { GeminiClient } = require('../dist/src/api/client');
const { taskProtocol } = require('../dist/src/protocol/actions');
const version = require('../package.json').version;
const profiles = {};
for (const permission of ['Full access', 'Workspace', 'Review']) {
  for (const compatibility of ['User message', 'Standard']) {
    const client = new GeminiClient('https://fixture.invalid', 'fixture', 1000, undefined, compatibility);
    const messages = client.formatMessages([{ role: 'system', content: taskProtocol(permission) }, { role: 'user', content: 'hello' }]);
    const serialized = JSON.stringify(messages);
    profiles[`${permission}|${compatibility}`] = { messages,
      messageDigest: crypto.createHash('sha256').update(serialized).digest('hex') };
  }
}
// Reuse the established byte-reading, SSE and redacted-error probe implementation.
const original = fs.readFileSync(path.join(__dirname, 'Test-CodeEkoStreaming.ps1'), 'utf8').replace(/\r\n/g, '\n');
let functions = original.slice(original.indexOf('function Wait-ProbeTask'), original.indexOf('$pointer ='));
function replaceOnce(before, after) {
  if (functions.split(before).length !== 2) throw new Error('Probe source changed; review warm-up generator replacement: ' + before.slice(0, 50));
  functions = functions.replace(before, after);
}
replaceOnce('function Invoke-StreamingProbe', 'function Invoke-WarmupRequest');
replaceOnce('param([bool]$Streaming, [string]$Key)', 'param([bool]$Streaming, [string]$Key, $SharedClient)');
replaceOnce(`    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMilliseconds(-1)`, '    $client = $SharedClient');
const payloadStart = functions.indexOf('        $prompt = ');
const payloadEnd = functions.indexOf('        $request.Content = ', payloadStart);
if (payloadStart < 0 || payloadEnd < 0) throw new Error('Probe payload block is missing.');
functions = functions.slice(0, payloadStart) + '        $payload = $RequestBody\n' + functions.slice(payloadEnd);
replaceOnce('        $client.Dispose()\n', '');
replaceOnce('} catch {}', '} catch { $report.validJson = $false; $report.expectedAction = $false }');
replaceOnce("        test = $(if ($Streaming) { 'streaming' } else { 'normal' })", "        test = $(if ($Streaming) { 'streaming' } else { 'normal' })\n        atUtc = [DateTime]::UtcNow.ToString('o')\n        usage = @{}\n        finishReason = $null");
replaceOnce('    $Report.events++', '    $Report.events++\n    Read-WarmupMetadata $item $Report');
replaceOnce('    foreach ($choice in $item.choices) {', '    foreach ($choice in $item.choices) {\n        if ($null -ne $choice.index -and $choice.index -ne 0) { continue }');
replaceOnce("                        $report.bodyFormat = 'json'", "                        Read-WarmupMetadata $data $report\n                        $report.bodyFormat = 'json'");
replaceOnce("$action.args.summary -is [string]", "$action.args.summary -is [string] -and $action.args.summary.Trim().Length -gt 0 -and @($action.PSObject.Properties).Count -eq 3 -and @($action.args.PSObject.Properties).Count -eq 1");
let script = fs.readFileSync(path.join(__dirname, 'probes/ApiWarmup.template.ps1'), 'utf8');
script = script.replace('# GENERATED_REQUEST_PROFILES', `$templateVersion = '${version}'\n$profilesJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(profiles)).toString('base64')}'))`);
script = script.replace('# GENERATED_PROBE_FUNCTIONS', functions.trimEnd());
fs.writeFileSync(path.join(__dirname, 'Test-CodeEkoWarmup.ps1'), script.replace(/\r?\n/g, '\r\n'), 'utf8');
console.log('Generated scripts/Test-CodeEkoWarmup.ps1 with exact fresh-chat request profiles for ' + version);
