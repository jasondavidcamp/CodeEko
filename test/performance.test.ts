import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../src/api/client';
import { PerformanceDiagnostics, performanceDiagnostics } from '../src/state/performanceDiagnostics';

test('performance capture measures requests, failures and repairs without content or credentials', async () => {
  performanceDiagnostics.clear();
  const client = new GeminiClient('https://private.example/v1', 'secret-key', 1000, (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'private response' } }] }))) as typeof fetch);
  await client.complete('private-model', [{ role: 'user', content: 'private prompt' }], undefined, true);
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
  const snapshot = log.snapshot(); snapshot.requests[0].outcome = 'changed';
  assert.equal(log.snapshot().requests[0].outcome, 'pending');
  log.clear(); log.finish(101, { outcome: 'success', elapsedMs: 1 });
  assert.equal(log.snapshot().requests.length, 0);
});
