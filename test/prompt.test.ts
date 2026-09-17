import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/loop';
import { GeminiClient, Message } from '../src/api/client';
import { Action, taskProtocol } from '../src/protocol/actions';
import { ProgressivePrompt } from '../src/protocol/prompt';
import { fullProtocolBaseline } from '../src/api/fullProtocolBaseline';

const done: Action = { version: 1, tool: 'complete_task', args: { summary: 'Done.' } };
const read: Action = { version: 1, tool: 'read_file', args: { path: 'main.ps1' } };

test('fresh conversation cuts transmitted characters by more than half without removing immediate action contracts', () => {
  const client = new GeminiClient('https://fixture.invalid', 'fixture', 1000);
  const size = (content: string) => client.formatMessages([{ role: 'system', content }, { role: 'user', content: 'hey' }])[0].content.length;
  assert.equal(size(fullProtocolBaseline('Full access')), 8235, 'frozen comparison baseline');
  for (const mode of ['Workspace', 'Full access']) {
    const prompt = taskProtocol(mode);
    assert.ok(size(prompt) < size(fullProtocolBaseline(mode)) / 2);
    for (const text of ['"version":1', 'ask_user', 'complete_task', 'apply_patch', 'create_file', 'expectedHash', 'latest user message', 'run_validation', 'automatically validates', 'three validation rounds', 'untrusted', 'Short follow-ups']) assert.ok(prompt.includes(text), text);
    assert.doesNotMatch(prompt, /PowerShell guidance|Editing guidance|Should -Be|Example.ps1/);
  }
  for (const mode of ['Review', 'Custom', 'unknown']) assert.doesNotMatch(taskProtocol(mode), /Editing tools:|create_file|run_validation \{/);
});

test('questions and conversation after edits keep history and the small core without routing calls', async () => {
  const history: Message[] = [{ role: 'user', content: 'Update main.ps1; preserve comments.' }, { role: 'assistant', content: 'Done; review and undo are available.' }, { role: 'user', content: 'Explain what a test is.' }];
  let calls = 0, asks = 0;
  await runAgent({ complete: async (_model, messages) => {
    calls++; assert.equal(messages[0].content, taskProtocol('Full access'));
    assert.deepEqual(messages.slice(1, 4), history);
    if (calls === 1) return JSON.stringify({ version: 1, tool: 'ask_user', args: { question: 'Brief or detailed?' } });
    assert.match(messages.at(-1)!.content, /Brief/); return JSON.stringify(done);
  } }, 'fake', history, { initialContext: async () => assert.fail('No inventory'), execute: async action => { assert.equal(action.tool, 'ask_user'); asks++; return 'Brief'; } }, () => 'Full access', new AbortController().signal, () => {});
  assert.equal(calls, 2); assert.equal(asks, 1); assert.equal(history.length, 3);
});

test('authorized reads load coding guidance once, preserve follow-ups and survive format correction', async () => {
  const history: Message[] = [{ role: 'user', content: 'Change main.ps1, preserve comments and do not commit.' }, { role: 'assistant', content: 'I will read and update it.' }, { role: 'user', content: 'go' }];
  const responses = [JSON.stringify(read), '{"version":1,"tool":"create_file","args":{}}', JSON.stringify(read), JSON.stringify(done)];
  const requests: Message[][] = []; let executions = 0;
  await runAgent({ complete: async (_model, messages) => { requests.push(structuredClone(messages)); return responses[requests.length - 1]; } }, 'fake', history,
    { execute: async () => { executions++; return { text: '# developer comment\nreturn 1', hash: 'a'.repeat(64) }; } }, () => 'Full access', new AbortController().signal, () => {});
  assert.equal(requests.length, 4); assert.equal(executions, 2);
  assert.equal(requests[0][0].content, taskProtocol('Full access'));
  for (const messages of requests.slice(1)) {
    assert.equal(messages[0].content.split('Editing guidance:').length, 2);
    assert.equal(messages[0].content.split('PowerShell guidance:').length, 2);
    assert.deepEqual(messages.slice(1, 4), history);
    assert.match(JSON.stringify(messages), /developer comment/);
  }
  assert.match(requests[2].at(-1)!.content, /format-only/);
});

test('direct edits need no discovery turn and validation failures load repair instructions before the next request', async () => {
  let calls = 0, checks = 0, edits = 0;
  const requests: string[] = [];
  const responses: Action[] = [{ version: 1, tool: 'create_file', args: { path: 'new.ps1', content: 'return 1' } }, done, done];
  await runAgent({ complete: async (_model, messages) => { requests.push(messages[0].content); return JSON.stringify(responses[calls++]); } }, 'fake', [], {
    execute: async action => { assert.equal(action.tool, 'create_file'); edits++; return { applied: true }; },
    beforeComplete: async () => ++checks === 1 ? { status: 'failed', steps: [] } : undefined
  }, () => 'Full access', new AbortController().signal, () => {});
  assert.equal(calls, 3); assert.equal(edits, 1); assert.equal(checks, 2);
  assert.match(requests[0], /create_file \{path:string,content:string\}/);
  assert.match(requests[1], /Editing guidance:/); assert.match(requests[2], /Validation guidance:/);
});

test('permission changes refresh even repair prompts and still reject mutations', async () => {
  let mode = 'Full access', calls = 0;
  await assert.rejects(runAgent({ complete: async (_model, messages) => {
    calls++;
    if (calls === 1) { mode = 'Review'; return '{}'; }
    assert.match(messages[0].content, /read-only/); assert.doesNotMatch(messages[0].content, /Editing tools:/);
    return JSON.stringify({ version: 1, tool: 'create_file', args: { path: 'blocked.ps1', content: 'x' } });
  } }, 'fake', [], { execute: async () => assert.fail('Denied tool executed') }, () => mode, new AbortController().signal, () => {}), /denied/);
  assert.equal(calls, 2);
});

test('invalid, denied and cancelled actions cannot select guidance or replay work', async () => {
  for (const kind of ['invalid', 'denied', 'cancelled']) {
    const controller = new AbortController(), prompt = new ProgressivePrompt(); let observations = 0, calls = 0;
    const observe = prompt.observe.bind(prompt); prompt.observe = action => { observations++; observe(action); };
    await assert.rejects(runAgent({ complete: async () => {
      calls++; if (kind === 'cancelled') controller.abort();
      return kind === 'invalid' ? '{"version":1,"tool":"read_file","args":{}}' : JSON.stringify({ version: 1, tool: 'create_file', args: { path: 'x.ps1', content: 'x' } });
    } }, 'fake', [], { execute: async () => assert.fail('No action may execute') }, () => 'Review', controller.signal, () => {}, undefined, prompt));
    assert.equal(observations, 0); assert.equal(calls, kind === 'invalid' ? 3 : 1);
  }
});
