import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../src/api/client';
import { CompletionDecoder } from '../src/api/streaming';
import { performanceDiagnostics } from '../src/state/performanceDiagnostics';
import { runAgent } from '../src/agent/loop';

const action = JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Hello café 🌧' } });
const event = (content: string) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content } }] }) + '\r\n\r\n';
const ending = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
function response(text: string, split = false): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(c) {
    if (split) for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); else c.enqueue(bytes);
    c.close();
  } }), { headers: { 'Content-Type': 'application/json' } });
}

test('streaming defaults on, handles mislabeled SSE and split UTF-8, records metadata and exposes only progress', async () => {
  performanceDiagnostics.clear(); let received = 0;
  const client = new GeminiClient('https://example.test', 'private-key', 1000, (async (_url, init) => {
    const request = JSON.parse(init!.body as string); assert.equal(request.stream, true); assert.equal(request.response_format, undefined);
    return response(': heartbeat\r\n\r\n' + event(action.slice(0, 20)) + event(action.slice(20)) + ending, true);
  }) as typeof fetch);
  assert.equal(await client.complete('model', [], undefined, false, () => received++), action);
  assert.equal(received, 1);
  const timing = performanceDiagnostics.snapshot().requests.at(-1)!;
  assert.equal(timing.streamed, true); assert.equal(timing.streamingRequested, true); assert.equal(timing.contentChunks, 2);
  assert.ok(timing.firstContentMs! <= timing.elapsedMs!);
  assert.doesNotMatch(JSON.stringify(timing), /private-key|café|example.test/);
});

test('streaming can be disabled and ordinary JSON is accepted when a provider ignores streaming', async () => {
  for (const streaming of [true, false]) {
    const client = new GeminiClient('https://example.test', 'key', 1000, (async (_url, init) => {
      assert.equal(JSON.parse(init!.body as string).stream, streaming);
      return response(JSON.stringify({ choices: [{ message: { content: action } }] }), true);
    }) as typeof fetch, 'Standard', streaming);
    assert.equal(await client.complete('model', []), action);
  }
});

test('SSE supports multiline data, comments, usage events and CR line endings', () => {
  let count = 0; const decoder = new CompletionDecoder(() => count++);
  decoder.push('event: message\rdata: {"choices":\rdata: [{"delta":{"content":"hello"}}]}\r\r');
  decoder.push('data: {"choices":[],"usage":{"total_tokens":10}}\r\rdata: [DONE]\r\r');
  assert.equal(decoder.result().choices[0].message.content, 'hello'); assert.equal(count, 1);
});

test('incomplete, malformed, truncated and server-error streams never execute a partial action', async () => {
  for (const text of [event(action), 'data: broken\n\n', 'event: error\ndata: {"message":"private-key"}\n\n',
    'data: {"error":{"message":"private-key"}}\n\n', event(action) + 'data: {"choices":[{"finish_reason":"length"}]}\n\n']) {
    let tools = 0;
    const client = new GeminiClient('https://example.test', 'private-key', 1000, (async () => response(text)) as typeof fetch);
    await assert.rejects(runAgent(client, 'model', [{ role: 'user', content: 'hello' }], { execute: async () => { tools++; } }, () => 'Full access', new AbortController().signal, () => {}), error => {
      assert.doesNotMatch(String(error), /private-key/); return true;
    });
    assert.equal(tools, 0);
  }
});

test('agent waits for completed SSE before tool execution and reports receiving in chat', async () => {
  let release!: () => void; let ready!: () => void;
  const began = new Promise<void>(resolve => ready = resolve);
  let executed = 0, calls = 0; const progress: string[] = [];
  const client = new GeminiClient('https://example.test', 'key', 2000, (async () => {
    if (++calls > 1) return response(event(action) + ending);
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(event(JSON.stringify({ version: 1, tool: 'list_files', args: {} }))));
      release = () => { c.enqueue(new TextEncoder().encode(ending)); c.close(); }; ready();
    } }));
  }) as typeof fetch);
  const run = runAgent(client, 'model', [{ role: 'user', content: 'list files' }], { execute: async () => { executed++; return []; } }, () => 'Full access', new AbortController().signal, text => progress.push(text));
  await began; await new Promise(resolve => setImmediate(resolve));
  assert.equal(executed, 0); assert.ok(progress.includes('Receiving response…'));
  release(); await run; assert.equal(executed, 1);
});

test('cancellation and overall timeout stop a stalled stream and retain first-content diagnostics', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController(); let cancelled = false;
    const client = new GeminiClient('https://example.test', 'key', 30, (async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(event('partial'))); }, cancel() { cancelled = true; }
    }))) as typeof fetch);
    const result = client.complete('model', [], controller.signal, false, () => { if (cancel) controller.abort(); });
    await assert.rejects(result, cancel ? /Cancelled/ : /timed out/);
    assert.equal(cancelled, true);
    const timing = performanceDiagnostics.snapshot().requests.at(-1)!;
    assert.equal(timing.outcome, cancel ? 'cancelled' : 'timeout'); assert.equal(timing.contentChunks, 1);
  }
});
