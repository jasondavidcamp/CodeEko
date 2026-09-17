import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { GeminiClient } from '../src/api/client';
import { performanceDiagnostics, PerformanceDiagnostics } from '../src/state/performanceDiagnostics';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { emptyResponseShape, inspectResponseShape } from '../src/api/responseShape';
import { failureMetadata } from '../src/api/failure';

test('response shape and nested failure diagnostics retain only numeric counts and known codes', () => {
  const shape = emptyResponseShape();
  inspectResponseShape(shape, { choices: [{ index: 0, delta: { content: ['private-array'], reasoning_content: 'secret',
    refusal: 'private', tool_calls: [{ arguments: 'private-source' }] }, message: { content: 'text' }, text: 'other' }, { index: 1, delta: { content: 'private-other-choice' } }] });
  assert.equal(shape.nonStringContentValues, 1); assert.equal(shape.toolCallEntries, 1);
  assert.equal(shape.reasoningCharacters, 6); assert.equal(shape.refusalCharacters, 7);
  assert.equal(shape.messageTextCharacters, 4); assert.equal(shape.alternateTextCharacters, 5); assert.equal(shape.otherChoices, 1);
  assert.doesNotMatch(JSON.stringify(shape), /private|secret/);
  const error: any = { code: 'private-code', message: 'private-message', errors: [{ code: 'UND_ERR_SOCKET' }, { code: 'ECONNRESET' }] };
  error.cause = error;
  assert.deepEqual(failureMetadata(error), ['UND_ERR_SOCKET', 'ECONNRESET']);
});

test('timing separates heartbeat bytes, role events and content; samples are bounded and contain no payload', async () => {
  performanceDiagnostics.clear();
  const parts = [': heartbeat-private\n\n', 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"private-answer"}}]}\n\n',
    ...Array(40).fill(': ping\n\n'), 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'];
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    await delay(5);
    const part = parts.shift(); if (part === undefined) controller.close(); else controller.enqueue(new TextEncoder().encode(part));
  } });
  await new GeminiClient('https://private.example', 'private-key', 3000, async () => new Response(body)).complete('fixture', []);
  const r = performanceDiagnostics.snapshot().requests.at(-1)!;
  assert.ok(r.headersMs! <= r.firstBodyByteMs!);
  assert.ok(r.firstBodyByteMs! < r.firstSseEventMs!);
  assert.ok(r.firstSseEventMs! < r.firstContentMs!);
  assert.equal(r.sseEvents, 4); assert.equal(r.bodyChunks, 44);
  assert.equal(r.bodyChunkSamples!.length, 32);
  assert.ok(r.bodyBytes! > r.bodyChunkSamples!.reduce((n, s) => n + s.bytes, 0));
  assert.ok(r.maxBodyGapMs! > 0); assert.ok(r.eventLoopSamples! > 0);
  assert.ok(r.elapsedMs! >= r.lastBodyByteMs!);
  assert.doesNotMatch(JSON.stringify(r), /private|heartbeat|ping/);
});

test('JSON responses have body timing but no SSE timing; failed streams retain received byte evidence', async () => {
  performanceDiagnostics.clear();
  await new GeminiClient('https://example.test', 'key', 1000, async () => new Response('{"choices":[{"message":{"content":"ok"}}]}'), 'Standard', false).complete('fixture', []);
  let r = performanceDiagnostics.snapshot().requests.at(-1)!;
  assert.equal(r.bodyChunks, 1); assert.equal(r.firstSseEventMs, undefined); assert.equal(r.sseEvents, 0);
  assert.ok(r.firstContentMs! >= r.firstBodyByteMs!);
  await assert.rejects(new GeminiClient('https://example.test', 'key', 1000, async () => new Response('data: private-invalid\n\n')).complete('fixture', []));
  r = performanceDiagnostics.snapshot().requests.at(-1)!;
  assert.equal(r.outcome, 'failed'); assert.equal(r.sseEvents, 1); assert.ok(r.bodyBytes! > 0);
  assert.equal(r.firstContentMs, undefined); assert.doesNotMatch(JSON.stringify(r), /private-invalid/);
});

test('event-loop timing detects a local stall during a request', async () => {
  performanceDiagnostics.clear();
  await new GeminiClient('https://example.test', 'key', 2000, async () => {
    await delay(50);
    const until = performance.now() + 90;
    while (performance.now() < until) { /* Simulate a blocked extension host. */ }
    await delay(50);
    return new Response('{"choices":[{"message":{"content":"ok"}}]}');
  }).complete('fixture', []);
  const r = performanceDiagnostics.snapshot().requests.at(-1)!;
  assert.ok(r.eventLoopDelayMaxMs! >= 70);
  assert.ok(r.eventLoopDelayMeanMs! <= r.eventLoopDelayMaxMs!);
});

test('persisted timing survives restart and strips arbitrary nested sample fields', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeeko-timing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new PerformanceDiagnostics(); await first.configure(root, 'test');
  const id = first.begin('completion', 'Standard', 1000);
  first.finish(id, { firstBodyByteMs: 10, firstSseEventMs: 20, bodyChunkSamples: [{ atMs: 10, bytes: 30 }], eventLoopDelayMaxMs: 21,
    responseShape: { ...emptyResponseShape(), messageTextCharacters: 20 }, failureStage: 'request', failureCodes: ['ECONNRESET'] });
  await first.flush();
  const filename = path.join(root, 'performance', first.sessionId + '.json');
  const data = JSON.parse(await fs.readFile(filename, 'utf8'));
  data.requests[0].bodyChunkSamples[0].content = 'private-source';
  data.requests[0].responseShape.secret = 'private-content';
  data.storageErrors = [{ operation: 'read', code: 'private-path' }];
  await fs.writeFile(filename, JSON.stringify(data));
  const second = new PerformanceDiagnostics(); await second.configure(root, 'test');
  assert.equal(second.snapshot().requests[0].firstSseEventMs, 20);
  assert.equal(second.snapshot().requests[0].responseShape?.messageTextCharacters, 20);
  assert.deepEqual(second.snapshot().requests[0].failureCodes, ['ECONNRESET']);
  assert.equal(second.snapshot().requests[0].eventLoopDelayMaxMs, 21);
  assert.doesNotMatch(JSON.stringify(second.snapshot()), /private/);
});

test('storage diagnostics identify mkdir and rename failures, aggregate repeats and never export paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeeko-diagnostics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const blocked = path.join(root, 'private-path'); await fs.writeFile(blocked, 'private-secret');
  const bad = new PerformanceDiagnostics(); await bad.configure(blocked, 'test');
  assert.equal(bad.snapshot().storageErrors[0].operation, 'mkdir');
  const log = new PerformanceDiagnostics(); await log.configure(root, 'test');
  await fs.mkdir(path.join(root, 'performance', log.sessionId + '.json'));
  for (let i = 0; i < 3; i++) { log.begin('completion', 'Standard', 1000); await log.flush(); }
  const report = log.snapshot();
  assert.equal(report.writeFailed, true); assert.equal(report.storageErrors.length, 1);
  assert.equal(report.storageErrors[0].operation, 'rename'); assert.equal(report.storageErrors[0].occurrences, 3);
  assert.ok(['EISDIR', 'EPERM', 'EACCES'].includes(report.storageErrors[0].code));
  assert.doesNotMatch(JSON.stringify([report, bad.snapshot()]), /private|codeeko-diagnostics|stack|errno/);
});
