import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../src/api/client';
import { PerformanceDiagnostics, performanceDiagnostics } from '../src/state/performanceDiagnostics';

test('performance capture measures requests, failures and repairs without content or credentials', async () => {
  performanceDiagnostics.clear();
  const client = new GeminiClient('https://private.example/v1', 'secret-key', 1000, (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'private response' } }] }))) as typeof fetch);
  await client.complete('test-model', [{ role: 'user', content: 'private prompt' }], undefined, true);
  let record = performanceDiagnostics.snapshot().requests[0];
  assert.equal(record.outcome, 'success'); assert.equal(record.repair, true); assert.equal(record.status, 200);
  assert.ok(record.elapsedMs! >= record.headersMs!);
  const report = JSON.stringify(performanceDiagnostics.snapshot());
  for (const value of ['private', 'secret-key']) assert.ok(!report.includes(value));
  const failing = new GeminiClient('https://private.example/v1', 'secret-key', 5, ((_url, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('secret-key'))))) as typeof fetch);
  await assert.rejects(failing.complete('model', []), /timed out/);
  record = performanceDiagnostics.snapshot().requests[1]; assert.equal(record.outcome, 'timeout');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(client.complete('model', [], cancelled.signal), /Cancelled/);
  assert.equal(performanceDiagnostics.snapshot().requests[2].outcome, 'cancelled');
  const empty = new GeminiClient('https://private.example/v1', 'secret-key', 1000, (async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }))) as typeof fetch);
  await empty.complete('model', []); assert.equal(performanceDiagnostics.snapshot().requests[3].outcome, 'empty');
});
test('performance history is bounded, snapshots isolated and clear ignores in-flight completion', () => {
  const log = new PerformanceDiagnostics();
  for (let i = 0; i < 101; i++) log.begin('completion', 'Standard', 300000);
  assert.equal(log.snapshot().requests.length, 100);
  const snapshot = log.snapshot(); snapshot.requests[0].outcome = 'failed';
  assert.equal(log.snapshot().requests[0].outcome, 'pending');
  log.clear(); log.finish(101, { outcome: 'success', elapsedMs: 1 });
  assert.equal(log.snapshot().requests.length, 0);
});

test('task correlation isolates concurrent runs and joins requests, tool phases and validation status', async () => {
  const log = new PerformanceDiagnostics();
  await Promise.all([1, 2].map(async turn => log.task(async () => {
    log.setTurn(turn);
    await log.measure('index', async () => {});
    const id = log.begin('completion', 'User message', 300000, false, { model: 'model-fixture', promptCharacters: 42 });
    await new Promise(resolve => setTimeout(resolve, turn));
    log.finish(id, { outcome: 'success', elapsedMs: 2 });
    await log.measure('tool', async () => {}, 'read_file');
    await log.measure('validation', async () => ({ status: 'failed' }));
  }, () => 'complete')));
  const report = log.snapshot();
  assert.equal(report.tasks.length, 2); assert.notEqual(report.tasks[0].taskId, report.tasks[1].taskId);
  for (const request of report.requests) {
    assert.ok(report.tasks.some(task => task.taskId === request.taskId));
    const phases = report.phases.filter(phase => phase.taskId === request.taskId);
    assert.equal(phases.length, 3); assert.ok(phases.every(phase => phase.turn === request.turn));
    assert.equal(phases.at(-1)!.validationStatus, 'failed');
  }
});

test('persistent diagnostics recover interrupted records, discard arbitrary fields and clear saved history', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekod-performance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new PerformanceDiagnostics(); await first.configure(root, '0.4.51');
  await first.task(async () => { first.setTurn(1); first.begin('completion', 'Standard', 1000, false, { model: 'fixture' }); }, () => 'complete');
  await first.flush();
  const file = path.join(root, 'performance', first.sessionId + '.json');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  data.requests[0].prompt = 'private-source'; data.requests[0].headers = { Authorization: 'secret-key' };
  data.requests[0].rateLimit = { retryAfterSeconds: 42, private: 'private-source' };
  data.requests[0].usage = { promptTokens: 0, completionTokens: 4, arbitrary: 'private-source' };
  await fs.writeFile(file, JSON.stringify(data));
  await fs.writeFile(path.join(root, 'performance', '00000000-0000-4000-8000-000000000001.json'), 'corrupt');
  const second = new PerformanceDiagnostics(); await second.configure(root, '0.4.52');
  const restored = second.snapshot(); assert.equal(restored.version, 2);
  assert.equal(restored.requests[0].outcome, 'interrupted'); assert.equal(restored.requests[0].runtimeVersion, '0.4.51');
  assert.equal(restored.requests[0].rateLimit!.retryAfterSeconds, 42); assert.equal(restored.requests[0].usage!.promptTokens, 0);
  assert.doesNotMatch(JSON.stringify(restored), /private-source|secret-key|Authorization/);
  second.clear(); await second.flush();
  const third = new PerformanceDiagnostics(); await third.configure(root, '0.4.53');
  assert.equal(third.snapshot().requests.length, 0); assert.equal(third.snapshot().tasks.length, 0);
});

test('persistent diagnostics enforce retention and storage errors do not stop work', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekod-perf-retention-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 7; i++) {
    const log = new PerformanceDiagnostics(); await log.configure(root, '0.4.51');
    const id = log.begin('completion', 'Standard', 1000); log.finish(id, { outcome: 'success' }); await log.flush();
  }
  assert.ok((await fs.readdir(path.join(root, 'performance'))).length <= 5);
  const file = path.join(root, 'blocked'); await fs.writeFile(file, 'not-a-directory');
  const broken = new PerformanceDiagnostics(); await broken.configure(file, '0.4.51');
  let ran = false; await broken.task(async () => { ran = true; }, () => 'complete'); await broken.flush();
  assert.equal(ran, true); assert.equal(broken.snapshot().writeFailed, true);
});

test('API metadata captures token counts, sanitized finish reasons and numeric rate signals without arbitrary headers', async () => {
  performanceDiagnostics.clear();
  const normal = new GeminiClient('https://example.test', 'secret-key', 1000, (async () => new Response(JSON.stringify({
    usage: { prompt_tokens: 0, completion_tokens: 7, total_tokens: 7, debug: 'secret-key' },
    choices: [{ message: { content: 'private-response' }, finish_reason: 'stop' }]
  }), { headers: { 'retry-after': '42', 'X-RateLimit-Remaining-Tokens-Minute': '0', 'X-Private-Header': 'secret-key' } })) as typeof fetch);
  await normal.complete('models/fixture', [{ role: 'user', content: 'private-prompt' }]);
  let record = performanceDiagnostics.snapshot().requests.at(-1)!;
  assert.equal(record.model, 'models/fixture'); assert.equal(record.finishReason, 'stop');
  assert.deepEqual(record.usage, { promptTokens: 0, completionTokens: 7, totalTokens: 7 });
  assert.equal(record.rateLimit!.retryAfterSeconds, 42); assert.equal(record.rateLimit!.tokensMinuteRemaining, 0);
  assert.ok(record.promptCharacters! > 14); assert.equal(record.messageCount, 1);
  const streaming = new GeminiClient('https://example.test', 'secret-key', 1000, (async () => new Response(
    'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\ndata: [DONE]\n\n'
  )) as typeof fetch);
  await streaming.complete('secret-key', []);
  record = performanceDiagnostics.snapshot().requests.at(-1)!; assert.equal(record.model, undefined);
  assert.equal(record.usage!.totalTokens, 6); assert.equal(record.finishReason, 'stop');
  const limited = new GeminiClient('https://example.test', 'secret-key', 1000, (async () => new Response('private-error', { status: 429, headers: { 'Retry-After': '8', 'X-RateLimit-Limit-Tokens-Minute': '500000' } })) as typeof fetch);
  await assert.rejects(limited.complete('fixture', []), /429/);
  record = performanceDiagnostics.snapshot().requests.at(-1)!;
  assert.equal(record.rateLimit!.retryAfterSeconds, 8); assert.equal(record.status, 429);
  assert.doesNotMatch(JSON.stringify(performanceDiagnostics.snapshot()), /private-response|private-prompt|private-error|secret-key|X-Private/);
});
