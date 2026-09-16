import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

test('PowerShell streaming probe detects mislabeled incremental SSE and separates parse errors and timeouts', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  let scenario = 'sse';
  const action = JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Hello world' } });
  const server = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    const request = JSON.parse(input);
    assert.equal(request.messages.length, 1); assert.equal(request.messages[0].role, 'user');
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
  const script = path.resolve(__dirname, '../../scripts/Test-EkodStreaming.ps1');
  async function run() {
    // Only the in-memory test copy accepts HTTP, to use a loopback fixture without certificates.
    const command = "$s=[IO.File]::ReadAllText($env:PROBE_SCRIPT); $s=$s.Replace(\"$address.Scheme -ne 'https'\",\"$address.Scheme -ne 'http'\"); & ([scriptblock]::Create($s)) -Endpoint $env:PROBE_ENDPOINT -Model 'fixture' -ApiKey (ConvertTo-SecureString 'fixture-secret' -AsPlainText -Force) -TimeoutSeconds 2";
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
  assert.equal(stream.contentChunks, 2); assert.equal(stream.doneMarker, true);
  assert.ok(stream.lastTextSeconds - stream.firstTextSeconds > 0.2);
  scenario = 'malformed'; assert.equal((await run())[1].outcome, 'body-not-json-or-sse');
  scenario = 'timeout'; assert.equal((await run())[1].outcome, 'timeout');
  scenario = 'http'; assert.equal((await run())[1].httpStatus, 429);
});
