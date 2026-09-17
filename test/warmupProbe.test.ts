import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { GeminiClient } from '../src/api/client';
import { taskProtocol } from '../src/protocol/actions';

const script = path.resolve(__dirname, '../../scripts/Test-CodeEkoWarmup.ps1');

test('standalone warm-up probe matches generated production message profiles', async () => {
  const before = await fs.readFile(script, 'utf8');
  execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/Build-CodeEkoWarmup.cjs')]);
  assert.equal(await fs.readFile(script, 'utf8'), before, 'Regenerate the warm-up script after changing request construction or version');
});

test('PowerShell warm-up probe sends identical fresh-chat requests, waits, checkpoints, and excludes failures', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeeko-warmup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'results.json');
  const requests: { body: any; at: number; connection?: string }[] = [];
  let checkpoints = 0;
  let forceNormal = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ body, at: Date.now(), connection: req.headers.connection });
    const saved = JSON.parse(await fs.readFile(output, 'utf8'));
    checkpoints = Math.max(checkpoints, saved.results.length);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const content = JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Hello private-response' } });
    if (forceNormal) { res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { completion_tokens: 16 } })); return; }
    // One empty response, one unsupported action; neither may qualify as a valid reply.
    const text = requests.length === 2 ? '' : requests.length === 3 ? '{"version":1,"tool":"create_file","args":{"path":"private-path","content":"private"}}' : content;
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n');
    res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":16}}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  async function run(extra: string) {
    const command = `$s=[IO.File]::ReadAllText($env:PROBE_SCRIPT); $s=$s.Replace("$address.Scheme -ne 'https'","$address.Scheme -ne 'http'"); & ([scriptblock]::Create($s)) -Endpoint $env:PROBE_ENDPOINT -Model fixture-model -ApiKey (ConvertTo-SecureString 'fixture-secret' -AsPlainText -Force) -OutputPath $env:PROBE_OUTPUT -TimeoutSeconds 2 ${extra}`;
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true,
        env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules'),
          PROBE_SCRIPT: script, PROBE_ENDPOINT: `http://127.0.0.1:${port}/v1`, PROBE_OUTPUT: output } });
      let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
  }
  const stdout = await run('-RequestsPerBatch 2 -Batches 2 -IdleSeconds 1');
  assert.equal(requests.length, 4);
  assert.equal(checkpoints, 3);
  assert.ok(requests[2].at - requests[1].at >= 900);
  const expected = new GeminiClient('https://fixture.invalid', 'fixture', 1000).formatMessages([
    { role: 'system', content: taskProtocol('Full access') }, { role: 'user', content: 'hello' }
  ]);
  for (const request of requests) assert.deepEqual(request.body, { model: 'fixture-model', messages: expected, temperature: 0, stream: true, max_tokens: 4096 });
  const json = await fs.readFile(output, 'utf8'), report = JSON.parse(json);
  assert.equal(report.completed, true); assert.equal(report.results.length, 4);
  assert.deepEqual(report.results.map((r: any) => r.validReply), [true, false, false, true]);
  assert.equal(report.summary[0].repeatedValidMedianSeconds, null);
  assert.equal(report.summary[1].firstRequestValid, false);
  assert.equal(report.waits.length, 1); assert.ok(report.waits[0].elapsedSeconds >= 1);
  assert.doesNotMatch(json + stdout, /fixture-secret|private-response|private-path|127\.0\.0\.1/);
  await assert.rejects(run('-RequestsPerBatch 1 -Batches 1'), /already exists/);
  await fs.unlink(output);
  requests.length = 0; forceNormal = true;
  await run('-RequestsPerBatch 1 -Batches 1 -FreshConnections -NoStreaming -CompatibilityMode Standard -PermissionMode Review');
  const normal = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(normal.results[0].validReply, true);
  assert.equal(requests[0].connection?.toLowerCase(), 'close'); assert.equal(requests[0].body.stream, false);
  assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
  assert.deepEqual(requests[0].body.messages, [{ role: 'system', content: taskProtocol('Review') }, { role: 'user', content: 'hello' }]);
});
