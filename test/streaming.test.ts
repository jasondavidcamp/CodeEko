import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../src/api/client';
import { CompletionDecoder } from '../src/api/streaming';
import { performanceDiagnostics } from '../src/state/performanceDiagnostics';
import { runAgent } from '../src/agent/loop';

const action = JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Hello café 🌧' } });
const event = (content: string) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content } }] }) + '\r\n\r\n';
const ending = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const rejectedReason = 'function_call_filter: MALFORMED_FUNCTION_CALL';
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

test('provider native-call rejection retries original task as text and never executes rejected content', async () => {
  for (const stream of [true, false]) {
    let calls = 0; const executed: string[] = [];
    const client = new GeminiClient('https://example.test', 'private-key', 1000, (async (_url, init) => {
      const request = JSON.parse(init!.body as string); calls++;
      if (calls === 2) {
        assert.match(request.messages[0].content, /seven character names/);
        assert.match(request.messages[0].content, /No native function calling tools are available/);
      }
      const content = calls === 1 ? JSON.stringify({ version: 1, tool: 'delete_file', args: { path: 'keep.ps1', expectedHash: 'a'.repeat(64) } })
        : calls === 2 ? JSON.stringify({ version: 1, tool: 'list_files', args: {} }) : action;
      const reason = calls === 1 ? rejectedReason : 'stop';
      return response(stream ? event(content) + 'data: ' + JSON.stringify({ choices: [{ finish_reason: reason }] }) + '\n\ndata: [DONE]\n\n'
        : JSON.stringify({ choices: [{ message: { content }, finish_reason: reason }] }));
    }) as typeof fetch, 'User message', stream);
    const result = await runAgent(client, 'model', [{ role: 'user', content: 'add a function for seven character names' }],
      { execute: async value => { executed.push(value.tool); return []; } }, () => 'Full access', new AbortController().signal, () => {});
    assert.match(result, /Hello/); assert.equal(calls, 3); assert.deepEqual(executed, ['list_files']);
    const records = performanceDiagnostics.snapshot().requests.slice(-3);
    assert.equal(records[0].finishReason, rejectedReason); assert.equal(records[0].outcome, 'failed'); assert.equal(records[1].repair, true);
  }
});

test('repeated native-call rejection is bounded and unknown or incomplete finishes remain rejected', async () => {
  let calls = 0, executed = 0;
  const client = new GeminiClient('https://example.test', 'private-key', 1000, (async () => {
    calls++; return response(event(action) + 'data: ' + JSON.stringify({ choices: [{ finish_reason: rejectedReason }] }) + '\n\n');
  }) as typeof fetch);
  await assert.rejects(runAgent(client, 'model', [{ role: 'user', content: 'seven character names' }],
    { execute: async () => { executed++; } }, () => 'Full access', new AbortController().signal, () => {}), /repeatedly rejected.*malformed native function call/);
  assert.equal(calls, 3); assert.equal(executed, 0);
  for (const reason of ['length', 'content_filter', 'private-key', 'MALFORMED_FUNCTION_CALL']) {
    for (const stream of [true, false]) {
      const failing = new GeminiClient('https://example.test', 'private-key', 1000, (async () => response(stream
        ? event(action) + 'data: ' + JSON.stringify({ choices: [{ finish_reason: reason }] }) + '\n\n'
        : JSON.stringify({ choices: [{ message: { content: action }, finish_reason: reason }] }))) as typeof fetch);
      await assert.rejects(failing.complete('model', []), error => { assert.doesNotMatch(String(error), /private-key/); return true; });
      assert.equal(performanceDiagnostics.snapshot().requests.at(-1)!.finishReason, reason === 'private-key' ? 'other' : reason);
    }
  }
});

test('recovered provider rejections do not exhaust the later empty-response retry budget', async () => {
  const read = JSON.stringify({ version: 1, tool: 'read_file', args: { path: 'names.ps1' } });
  const create = JSON.stringify({ version: 1, tool: 'create_file', args: { path: 'Seven.ps1', content: '# seven character names' } });
  const sequence = [null, read, null, read, '', create, action];
  const executed: string[] = [], attempts: number[] = []; let calls = 0;
  const client = new GeminiClient('https://example.test', 'private-key', 1000, (async (_url, init) => {
    const content = sequence[calls++]; assert.ok(calls <= sequence.length);
    const prompt = JSON.parse(init!.body as string).messages[0].content;
    assert.match(prompt, /seven character names/);
    if (calls === 6) { assert.match(prompt, /endpoint returned no content/); assert.match(prompt, /source evidence/); }
    return response(event(content ?? read) + 'data: ' + JSON.stringify({ choices: [{ finish_reason: content === null ? rejectedReason : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  }) as typeof fetch);
  await runAgent(client, 'model', [{ role: 'user', content: 'add a function for seven character names' }],
    { execute: async value => { executed.push(value.tool); return 'source evidence'; } }, () => 'Full access', new AbortController().signal, () => {}, async record => { attempts.push(record.attempt); });
  assert.equal(calls, 7); assert.deepEqual(executed, ['read_file', 'read_file', 'create_file']); assert.deepEqual(attempts, [1]);
});

test('empty responses do not reset an unresolved provider-rejection sequence', async () => {
  let calls = 0;
  const client = new GeminiClient('https://example.test', 'key', 1000, (async () => {
    const reason = ++calls % 2 ? rejectedReason : 'stop';
    return response('data: ' + JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: reason }] }) + '\n\ndata: [DONE]\n\n');
  }) as typeof fetch);
  await assert.rejects(runAgent(client, 'model', [], { execute: async () => { assert.fail('Rejected or empty response must not execute'); } },
    () => 'Full access', new AbortController().signal, () => {}), /repeatedly rejected/);
  assert.equal(calls, 5);
});
