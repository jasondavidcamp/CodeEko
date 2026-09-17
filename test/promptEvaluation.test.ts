import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient, Message } from '../src/api/client';
import { comparePromptWorkflows } from '../src/api/promptEvaluation';

const response = (tool: string, args: object) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ version: 1, tool, args }) }, finish_reason: 'stop' }] }));
function fixtureReply(messages: Message[]): Response {
  const users = messages.filter(m => m.role === 'user').map(m => m.content);
  const results = users.flatMap(content => { try { const value = JSON.parse(content); return value.result === undefined ? [] : [value]; } catch { return []; } });
  const request = users.join('\n');
  if (request.includes('Before we start')) return results.length ? response('complete_task', { summary: 'A brief explanation it is.' }) : response('ask_user', { question: 'Brief or detailed?' });
  if (request.includes('Read main.ps1')) return results.length ? response('complete_task', { summary: 'main.ps1:2 returns 41.' }) : response('read_file', { path: 'main.ps1' });
  if (request.includes('Go ahead.')) {
    if (!results.length) return response('read_file', { path: 'main.ps1' });
    if (!results.some(r => r.tool === 'apply_patch')) return response('apply_patch', { path: 'main.ps1', edits: [{ oldText: 'return 41', newText: 'return 42' }] });
    return response('complete_task', { summary: 'Changed the value and preserved the developer comment.' });
  }
  return response('complete_task', { summary: 'Hello! A return value is the value a function sends back.' });
}

test('workflow comparison measures real agent-loop calls and checks continuity, reads, edits and automatic validation', async () => {
  const bodies: any[] = [];
  const client = new GeminiClient('https://fixture.invalid', 'private-key', 1000, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body); return fixtureReply(body.messages);
  }, 'Standard', false);
  const report = await comparePromptWorkflows(client, 'fixture', 'Full access', new AbortController().signal, () => {});
  assert.equal(report.results.length, 10); assert.equal(report.allChecksPassed, true);
  assert.equal(bodies.length, 18);
  for (const row of report.results) {
    assert.equal(row.timings.length, row.modelCalls);
    assert.equal(row.totalRequestBytes, row.timings.reduce((n, timing) => n + timing.requestBytes!, 0));
    assert.equal(row.totalPromptCharacters, row.timings.reduce((n, timing) => n + timing.promptCharacters!, 0));
    assert.equal(row.repairCalls, 0);
    if (row.scenario === 'follow-up-edit') { assert.equal(row.modelCalls, 3); assert.equal(row.validations, 1); }
    if (row.scenario === 'greeting' || row.scenario === 'conversation-after-edit') assert.equal(row.modelCalls, 1);
  }
  for (const body of bodies) assert.deepEqual({ ...body, messages: undefined }, { model: 'fixture', messages: undefined, temperature: 0, stream: false, max_tokens: 4096, response_format: { type: 'json_object' } });
  assert.doesNotMatch(JSON.stringify(report), /private-key|fixture.invalid|developer comment|function Get-Value|return 42|return value/);
});

test('workflow comparison counts format repairs, retains timing and excludes edit scenarios in Review', async () => {
  let calls = 0;
  const client = new GeminiClient('https://fixture.invalid', 'secret', 1000, async (_url, init) => {
    if (++calls === 1) return new Response('{"choices":[{"message":{"content":""}}]}');
    return fixtureReply(JSON.parse(String(init?.body)).messages);
  }, 'Standard', false);
  const report = await comparePromptWorkflows(client, 'fixture', 'Review', new AbortController().signal, () => {});
  assert.equal(report.allChecksPassed, true); assert.equal(report.results.length, 8);
  assert.equal(report.results[0].modelCalls, 2); assert.equal(report.results[0].repairCalls, 1);
  assert.equal(report.results[0].timings[1].repair, true);
  assert.ok(report.results.every(r => r.scenario !== 'follow-up-edit'));
});

test('early completion, prohibited tools and endless reads fail fixture checks within bounded calls', async () => {
  for (const behavior of ['early', 'prohibited', 'endless']) {
    const client = new GeminiClient('https://fixture.invalid', 'secret', 1000, async (_url, init) => {
      const messages: Message[] = JSON.parse(String(init?.body)).messages;
      if (messages.some(m => m.content === 'Go ahead.')) {
        if (behavior === 'early') return response('complete_task', { summary: 'Changed everything.' });
        if (behavior === 'prohibited') return response('create_file', { path: '../escape.ps1', content: 'private source' });
        return response('read_file', { path: 'main.ps1' });
      }
      return fixtureReply(messages);
    }, 'Standard', false);
    const report = await comparePromptWorkflows(client, 'fixture', 'Full access', new AbortController().signal, () => {});
    assert.equal(report.allChecksPassed, false);
    const edits = report.results.filter(r => r.scenario === 'follow-up-edit');
    assert.ok(edits.every(r => !r.checksPassed && r.edits === 0 && r.modelCalls <= 8));
    if (behavior === 'endless') assert.ok(edits.every(r => r.modelCalls === 8));
    assert.doesNotMatch(JSON.stringify(report), /private source|escape.ps1/);
  }
});

test('workflow cancellation stops scheduling and exports no provider error or response content', async () => {
  const controller = new AbortController(); let calls = 0;
  const client = new GeminiClient('https://fixture.invalid', 'secret', 1000, async () => { calls++; controller.abort(); throw new Error('private provider error'); }, 'Standard');
  const report = await comparePromptWorkflows(client, 'fixture', 'Full access', controller.signal, () => {});
  assert.equal(calls, 1); assert.equal(report.results.length, 1); assert.equal(report.results[0].outcome, 'cancelled');
  assert.equal(report.allChecksPassed, false); assert.doesNotMatch(JSON.stringify(report), /private provider error/);
});
