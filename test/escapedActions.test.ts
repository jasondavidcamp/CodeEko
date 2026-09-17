import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction, taskProtocol, ActionFormatError } from '../src/protocol/actions';
import { runAgent } from '../src/agent/loop';
import { GeminiClient } from '../src/api/client';
import { ProgressivePrompt } from '../src/protocol/prompt';

// Synthetic reproduction of captured output: the model escaped an entire
// create_file object (sometimes twice) without its enclosing string quotes.
const source = 'BeforeAll { . (Join-Path $PSScriptRoot "..\\Seven.ps1") }\r\nDescribe "Seven" { It "filters" { @(Get-Seven).Count | Should -Be 0 } }\r\n';
const create = JSON.stringify({ version: 1, tool: 'create_file', args: { path: 'tests/Seven.Tests.ps1', content: source } });
const escaped = (value: string) => JSON.stringify(value).slice(1, -1);

test('over-escaped actions get a precise hint but are never decoded or accepted', () => {
  for (const raw of [escaped(create), escaped(escaped(create)), JSON.stringify(create), JSON.stringify(JSON.stringify(create))]) {
    assert.throws(() => parseAction(raw), error => error instanceof ActionFormatError && /Encode the action exactly once/.test(error.hint));
  }
  const action = parseAction(create);
  assert.equal(action.tool, 'create_file');
  if (action.tool === 'create_file') assert.equal(action.args.content, source);
  for (const raw of ['{"version":1', create + create, '```json\n' + create + '\n```', '{"version":1,"tool":"create_file","args":{"path":"x","content":"x","extra":true}}']) {
    assert.throws(() => parseAction(raw));
  }
});

test('editing prompt provides a schema-valid multiline example without exposing edit tools in Review', () => {
  const session = new ProgressivePrompt();
  assert.doesNotMatch(session.render('Full access'), /"tool":"create_file"/);
  session.observe({ version: 1, tool: 'read_file', args: { path: 'main.ps1' } });
  const prompt = session.render('Full access');
  const example = prompt.split('\n').find(line => line.startsWith('{"version":1,"tool":"create_file"'))!;
  const action = parseAction(example);
  assert.equal(action.tool, 'create_file');
  if (action.tool === 'create_file') assert.equal(action.args.content, 'Write-Output "example"\n$relativePath = ".\\Example.ps1"\n');
  assert.doesNotMatch(taskProtocol('Review'), /"tool":"create_file"/);
  assert.doesNotMatch(session.render('Review'), /"tool":"create_file"/);
});

test('compatible transport repairs escaped code with original evidence before execution and validation', async () => {
  let calls = 0, validations = 0;
  const executed: string[] = [];
  const client = new GeminiClient('https://example.test', 'synthetic-key', 1000, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const prompt = body.messages[0].content;
    assert.equal(body.model, 'selected-model');
    assert.equal(body.response_format, undefined);
    assert.match(prompt, /End of conversation records.*standalone action JSON object/);
    assert.match(prompt, /add seven-character tests/);
    calls++;
    if (calls === 3) {
      assert.match(prompt, /Encode the action exactly once/);
      assert.match(prompt, /current source evidence/);
      assert.match(prompt, /format-only correction/);
    }
    const content = calls === 1 ? JSON.stringify({ version: 1, tool: 'read_file', args: { path: 'Seven.ps1' } })
      : calls === 2 ? escaped(escaped(create)) : calls === 3 ? create
      : JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Tests added.' } });
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  });
  const result = await runAgent(client, 'selected-model', [{ role: 'user', content: 'add seven-character tests' }], {
    execute: async action => {
      executed.push(action.tool);
      if (action.tool === 'create_file') assert.equal(action.args.content, source);
      return 'current source evidence';
    },
    beforeComplete: async () => { validations++; }
  }, () => 'Full access', new AbortController().signal, () => {});
  assert.equal(result, 'Tests added.');
  assert.deepEqual(executed, ['read_file', 'create_file']);
  assert.equal(calls, 4); assert.equal(validations, 1);
});

test('escaped-action repairs remain bounded and a corrected edit still obeys Review permission', async () => {
  let calls = 0;
  await assert.rejects(runAgent({ complete: async () => { calls++; return escaped(create); } }, 'model', [],
    { execute: async () => { assert.fail('Malformed action executed'); } }, () => 'Full access', new AbortController().signal, () => {}), /unusable response/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(runAgent({ complete: async () => ++calls === 1 ? escaped(create) : create }, 'model', [],
    { execute: async () => { assert.fail('Unauthorized action executed'); } }, () => 'Review', new AbortController().signal, () => {}), /denied/);
  assert.equal(calls, 2);
});
