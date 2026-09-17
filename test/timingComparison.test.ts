import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../src/api/client';
import { compareRequestTiming, comparisonInstruction } from '../src/api/timingComparison';
import { taskProtocol } from '../src/protocol/actions';
import { fullProtocolBaseline } from '../src/api/fullProtocolBaseline';

const expected = JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Hello' } });

test('comparison alternates identical transport settings and exports only metadata', async () => {
  const requests: any[] = [];
  const transport: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: expected }, finish_reason: 'stop' }] }));
  };
  const client = new GeminiClient('https://fixture.invalid', 'private-key', 1000, transport, 'User message', false);
  const report = await compareRequestTiming(client, 'fixture-model', 'Full access', new AbortController().signal, () => {});
  assert.equal(report.results.length, 15);
  assert.equal(requests.length, 15 + report.workflows.results.reduce((sum, r) => sum + r.modelCalls, 0));
  assert.equal(report.comparisonVersion, 3); assert.equal(report.allRepliesValid, true);
  assert.deepEqual(report.summary.map(s => s.validReplies), [3, 3, 3, 3, 3]);
  const normalMessages = [{ role: 'system' as const, content: taskProtocol('Full access') }, { role: 'user' as const, content: comparisonInstruction }];
  for (let i = 0; i < 15; i++) {
    const { messages, ...options } = requests[i];
    const omitted = report.results[i].variant === 'full-provider-limit';
    assert.deepEqual(options, { model: 'fixture-model', temperature: 0, stream: false, ...(omitted ? {} : { max_tokens: 4096 }) });
    assert.equal(report.results[i].timing?.maxOutputTokens, omitted ? undefined : 4096);
    if (report.results[i].variant === 'compact') assert.deepEqual(messages, [{ role: 'user', content: comparisonInstruction }]);
    else if (report.results[i].variant === 'compact-wrapped') assert.deepEqual(messages, client.formatMessages([{ role: 'user', content: comparisonInstruction }]));
    else if (report.results[i].variant === 'progressive') assert.deepEqual(messages, client.formatMessages(normalMessages));
    else assert.deepEqual(messages, client.formatMessages([{ role: 'system', content: fullProtocolBaseline('Full access') }, { role: 'user', content: comparisonInstruction }]));
    assert.equal(report.results[i].timing?.outcome, 'success');
    assert.ok(report.results[i].timing?.firstBodyByteMs !== undefined);
  }
  // The candidate arm is exactly production. The old full prompt stays frozen.
  await client.complete('fixture-model', normalMessages);
  assert.deepEqual(requests.at(-1), requests[3]);
  assert.equal(report.results[2].messageDigest, report.results[4].messageDigest);
  assert.ok(report.summary.find(s => s.variant === 'progressive')!.medianPromptCharacters! < report.summary.find(s => s.variant === 'full')!.medianPromptCharacters! / 2);
  assert.equal(report.workflows.allChecksPassed, false, 'Hello alone cannot pass repository/continuity checks');
  assert.doesNotMatch(JSON.stringify(report), /private-key|private-response-secret|fixture.invalid|Available tools/);
});

test('empty and incorrect replies never qualify for timing medians; alternate SSE shapes are visible', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    if (calls % 4 === 1) return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":0}}\n\ndata: [DONE]\n\n');
    if (calls % 4 === 2) return new Response('data: {"choices":[{"message":{"content":"private-unsupported-text"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'private-unexpected-answer' }, finish_reason: 'stop' }] }));
  };
  const report = await compareRequestTiming(new GeminiClient('https://fixture.invalid', 'private-key', 1000, transport), 'fixture', 'Review', new AbortController().signal, () => {});
  assert.equal(report.allRepliesValid, false);
  assert.ok(report.summary.every(s => s.validReplies === 0 && s.medianElapsedMs === null && s.medianFirstContentMs === null));
  assert.equal(report.results[0].reply, 'empty');
  assert.equal(report.results[0].timing?.responseShape?.deltaTextCharacters, 0);
  assert.equal(report.results[1].timing?.responseShape?.messageTextCharacters, 'private-unsupported-text'.length);
  assert.equal(report.results[2].reply, 'unexpected');
  assert.doesNotMatch(JSON.stringify(report), /private-|unsupported-text|unexpected-answer/);
});

test('comparison retains failures and stops scheduling on cancellation', async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    if (calls === 2) controller.abort();
    throw new TypeError('private failure details', { cause: Object.assign(new Error('private network details'), { code: 'ECONNRESET' }) });
  };
  const client = new GeminiClient('https://fixture.invalid', 'key', 1000, transport);
  const report = await compareRequestTiming(client, 'fixture-model', 'Review', controller.signal, () => {});
  assert.equal(calls, 2);
  assert.equal(report.cancelled, true);
  assert.deepEqual(report.results.map(r => r.timing?.outcome), ['failed', 'cancelled']);
  assert.deepEqual(report.results[0].timing?.failureCodes, ['ECONNRESET']);
  assert.equal(report.results[0].timing?.failureStage, 'request');
  assert.doesNotMatch(JSON.stringify(report), /private failure/);
});
