import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';

test('PowerShell failure diagnostics redact nested exception messages and retain socket codes', { skip: process.platform !== 'win32' }, () => {
  const command = `
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($env:PROBE_SCRIPT,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'Parser failure' }
    $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ProbeFailure'},$true)
    . ([scriptblock]::Create($function.Extent.Text))
    $socket=[Net.Sockets.SocketException]::new(10061)
    $outer=[IO.IOException]::new('private-secret https://private-host/path', $socket)
    $outer.Data['private-key']='private-value'
    Get-ProbeFailure $outer 'request' | ConvertTo-Json -Depth 8
  `;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, PROBE_SCRIPT: path.resolve(__dirname, '../../scripts/Test-CodeEkoStreaming.ps1') }
  });
  assert.doesNotMatch(output, /private-|https:|Message|StackTrace/);
  const failure = JSON.parse(output);
  assert.equal(failure.exceptions[0].type, 'System.IO.IOException');
  assert.equal(failure.exceptions[1].socketError, 'ConnectionRefused');
  assert.equal(failure.exceptions[1].nativeErrorCode, 10061);
});

test('PowerShell streaming probe detects mislabeled incremental SSE and separates parse errors and timeouts', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  let scenario = 'sse';
  const action = JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Hello world' } });
  const server = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    const request = JSON.parse(input);
    assert.equal(request.messages.length, 1); assert.equal(request.messages[0].role, 'user');
    if (scenario === 'disconnect') { req.socket.destroy(); return; }
    if (scenario === 'http') { res.writeHead(429); res.end('private-server-error'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!request.stream) { res.end(JSON.stringify({ choices: [{ message: { content: action }, finish_reason: 'stop' }] })); return; }
    if (scenario === 'malformed') { res.end('not-json-private-response'); return; }
    if (scenario === 'timeout') { res.flushHeaders(); return; }
    const event = (content: string) => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\r\n\r\n';
    const first = event(action.slice(0, 30));
    res.write(first.slice(0, 9));
    setTimeout(() => res.write(first.slice(9)), 100);
    setTimeout(() => res.write(event(action.slice(30))), 600);
    setTimeout(() => res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), 900);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const script = path.resolve(__dirname, '../../scripts/Test-CodeEkoStreaming.ps1');
  async function run() {
    // Only the in-memory test copy accepts HTTP, to use a loopback fixture without certificates.
    const command = "$s=[IO.File]::ReadAllText($env:PROBE_SCRIPT); $s=$s.Replace(\"$address.Scheme -ne 'https'\",\"$address.Scheme -ne 'http'\"); & ([scriptblock]::Create($s)) -Endpoint $env:PROBE_ENDPOINT -Model 'fixture' -ApiKey (ConvertTo-SecureString 'fixture-secret' -AsPlainText -Force) -TimeoutSeconds 2 -Pairs 1";
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules'), PROBE_SCRIPT: script, PROBE_ENDPOINT: `http://127.0.0.1:${port}/v1` } });
      let stdout = '', stderr = ''; child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
    assert.doesNotMatch(output, /fixture-secret|private-response|private-server-error|127\.0\.0\.1|Hello world/);
    return JSON.parse(output).results;
  }
  const [normal, stream] = await run();
  assert.equal(normal.expectedAction, true); assert.equal(stream.expectedAction, true);
  assert.equal(stream.bodyFormat, 'sse'); assert.equal(stream.headerBodyMismatch, true);
  assert.ok(stream.bodyBytes > 0); assert.ok(stream.bodyChunks >= 2); assert.ok(stream.firstBodySeconds <= stream.firstTextSeconds); assert.equal(stream.contentChunks, 2); assert.equal(stream.doneMarker, true);
  assert.ok(stream.lastTextSeconds - stream.firstTextSeconds > 0.2);
  scenario = 'malformed'; assert.equal((await run())[1].outcome, 'body-not-json-or-sse');
  scenario = 'timeout';
  const timeout = (await run())[1];
  assert.equal(timeout.outcome, 'timeout');
  assert.equal(timeout.failure.stage, 'body-read');
  assert.ok(timeout.failure.exceptions.some((e: { type: string }) => e.type === 'System.TimeoutException'));
  scenario = 'http'; assert.equal((await run())[1].httpStatus, 429);
  scenario = 'disconnect';
  const disconnected = (await run())[0];
  assert.equal(disconnected.outcome, 'request-error');
  assert.equal(disconnected.failure.stage, 'request');
  assert.ok(disconnected.failure.exceptions.some((e: { type: string }) => e.type === 'System.Net.Http.HttpRequestException'));
  assert.ok(disconnected.failure.exceptions.some((e: { webExceptionStatusCode?: number }) => typeof e.webExceptionStatusCode === 'number'));
});
