import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../src/api/client';
import { compareRequestTiming } from '../src/api/timingComparison';

test('comparison alternates identical transport settings and exports only metadata', async () => {
  const requests: any[] = [];
  const transport: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'private-response-secret' }, finish_reason: 'stop' }] }));
  };
  const client = new GeminiClient('https://fixture.invalid', 'private-key', 1000, transport, 'User message', false);
  const report = await compareRequestTiming(client, 'fixture-model', 'Full access', new AbortController().signal, () => {});
  assert.equal(requests.length, 6);
  assert.deepEqual(report.results.map(r => r.variant), ['minimal', 'full', 'full', 'minimal', 'minimal', 'full']);
  for (let i = 0; i < requests.length; i++) {
    const { messages, ...options } = requests[i];
    assert.deepEqual(options, { model: 'fixture-model', temperature: 0, stream: false, max_tokens: 4096 });
    if (report.results[i].variant === 'minimal') assert.deepEqual(messages, [{ role: 'user', content: 'hello' }]);
    else { assert.match(messages[0].content, /complete_task/); assert.match(messages[0].content, /hello/); }
    assert.equal(report.results[i].timing?.outcome, 'success');
    assert.ok(report.results[i].timing?.firstBodyByteMs !== undefined);
  }
  assert.doesNotMatch(JSON.stringify(report), /private-key|private-response-secret|fixture.invalid|Available tools/);
});

test('comparison retains failures and stops scheduling on cancellation', async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    if (calls === 2) controller.abort();
    throw new Error('private failure details');
  };
  const client = new GeminiClient('https://fixture.invalid', 'key', 1000, transport);
  const report = await compareRequestTiming(client, 'fixture-model', 'Review', controller.signal, () => {});
  assert.equal(calls, 2);
  assert.equal(report.cancelled, true);
  assert.deepEqual(report.results.map(r => r.timing?.outcome), ['failed', 'cancelled']);
  assert.doesNotMatch(JSON.stringify(report), /private failure/);
});
