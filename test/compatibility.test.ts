import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient, Message } from '../src/api/client';
import { runAgent } from '../src/agent/loop';
import * as fs from 'node:fs';
import * as path from 'node:path';

const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
const done = (summary: string) => JSON.stringify({ version: 1, tool: 'complete_task', args: { summary } });

test('user-message compatibility answers through an endpoint that drops system instructions', async () => {
  const history: Message[] = [{ role: 'user', content: 'hello' }];
  let calls = 0;
  const client = new GeminiClient('https://api.example.test', 'test-key', 1000, async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls++;
    assert.equal(request.messages.length, 1); assert.equal(request.messages[0].role, 'user');
    assert.equal(request.response_format, undefined);
    assert.match(request.messages[0].content, /"tool":"complete_task"/);
    assert.match(request.messages[0].content, /hello/);
    return reply(done('Hello!'));
  });
  const result = await runAgent(client, 'test-model', history, { execute: async () => { throw new Error('Greeting must not execute tools'); } }, () => 'Full access', new AbortController().signal, () => {});
  assert.equal(result, 'Hello!'); assert.equal(calls, 1);
  assert.deepEqual(history, [{ role: 'user', content: 'hello' }]);
});

test('empty output and a null tool recover with original request and no invented completion', async () => {
  let calls = 0, executions = 0;
  const client = new GeminiClient('https://api.example.test', 'test-key', 1000, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const prompt = body.messages[0].content;
    assert.match(prompt, /hello/); assert.equal(body.response_format, undefined);
    calls++;
    if (calls === 1) return reply('');
    if (calls === 2) { assert.match(prompt, /endpoint returned no content/); assert.doesNotMatch(prompt, /Correct this rejected response/); return reply('{"version":1,"tool":null,"args":{}}'); }
    assert.match(prompt, /format-only/); assert.match(prompt, /original user request/);
    return reply(done('Hello!'));
  }, 'User message');
  const answer = await runAgent(client, 'test-model', [{ role: 'user', content: 'hello' }], { execute: async () => { executions++; return {}; } }, () => 'Full access', new AbortController().signal, () => {});
  assert.equal(answer, 'Hello!'); assert.equal(calls, 3); assert.equal(executions, 0);
});

test('compatible read-only tasks preserve tool evidence and cannot execute edits', async () => {
  let calls = 0; const executed: string[] = [];
  const client = new GeminiClient('https://api.example.test', 'test-key', 1000, async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls++;
    assert.equal(request.messages[0].role, 'user');
    if (calls === 1) return reply('{"version":1,"tool":"read_file","args":{"path":"main.ps1"}}');
    assert.match(request.messages[0].content, /return 42/); assert.match(request.messages[0].content, /Explain main.ps1/);
    return reply(done('main.ps1 returns 42.'));
  }, 'User message');
  assert.equal(await runAgent(client, 'test-model', [{ role: 'user', content: 'Explain main.ps1' }], { execute: async action => { executed.push(action.tool); return { text: 'return 42' }; } }, () => 'Review', new AbortController().signal, () => {}), 'main.ps1 returns 42.');
  assert.deepEqual(executed, ['read_file']);
  const editingClient = new GeminiClient('https://api.example.test', 'test-key', 1000, async () => reply('{"version":1,"tool":"create_file","args":{"path":"no.txt","content":"no"}}'), 'User message');
  await assert.rejects(runAgent(editingClient, 'test-model', [], { execute: async () => { throw new Error('Must not execute'); } }, () => 'Review', new AbortController().signal, () => {}), /denied/);
});

test('empty responses stop after three calls without executing tools', async () => {
  let calls = 0;
  await assert.rejects(runAgent({ complete: async (_model, messages) => { calls++; assert.ok(messages.some(m => m.content === 'hello')); return ''; } }, 'mock', [{ role: 'user', content: 'hello' }], { execute: async () => { throw new Error('Must not execute'); } }, () => 'Review', new AbortController().signal, () => {}), /unusable response/);
  assert.equal(calls, 3);
});

test('endpoint compatibility defaults to User message and is application scoped', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  const field = manifest.contributes.configuration.properties['codeeko.compatibilityMode'];
  assert.equal(field.default, 'User message'); assert.equal(field.scope, 'application');
  assert.deepEqual(field.enum, ['User message', 'Standard']);
});
