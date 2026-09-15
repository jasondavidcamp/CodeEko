import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { safePath, contained, authorize, ReadRequired } from '../src/policy/boundary';
import { parseAction } from '../src/protocol/actions';
import { RepositoryIndex } from '../src/indexing';
import { git, resolveRepository } from '../src/repository/git';
import { ThreadStore, repositoryStorage } from '../src/state/threads';
import { GeminiClient, apiBase } from '../src/api/client';
import { runAgent } from '../src/agent/loop';
import { ReadOnlyTools } from '../src/tools/readOnly';
import { acquireRepositoryLease } from '../src/state/lease';
async function fixture(t: any) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ekod-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); await fs.mkdir(root); await git(root, ['init']);
  return { root, storage: path.join(temp, 'storage'), temp };
}
test('containment rejects siblings, traversal, absolute and alternate-stream paths', async t => {
  const { root, temp } = await fixture(t); await fs.writeFile(path.join(root, 'ok.ps1'), 'ok');
  assert.equal(contained(root, root + '-other'), false);
  for (const bad of ['../escape', '/etc/passwd', 'x:stream', '.git/config', '.GIT/config', '.git./config', '..\\escape']) await assert.rejects(safePath(root, bad));
  assert.equal(await safePath(root, 'ok.ps1'), path.join(root, 'ok.ps1'));
  const outside = path.join(temp, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret'), 'private');
  await fs.symlink(outside, path.join(root, 'link'), 'junction');
  await assert.rejects(safePath(root, 'link/secret'));
});
test('strict protocol rejects unknown, extra, malformed, and unbounded actions', () => {
  for (const raw of ['{}', '```json\n{}\n```', '{"version":2,"tool":"git_status","args":{}}', '{"version":1,"tool":"run_command","args":{}}', '{"version":1,"tool":"git_status","args":{"command":"x"}}', '{"version":1,"tool":"read_file","args":{"path":"a","startLine":0}}']) assert.throws(() => parseAction(raw));
  assert.equal(parseAction('{"version":1,"tool":"git_status","args":{}}').tool, 'git_status');
  for (const mode of ['Review','Workspace','Full access','Custom']) { authorize('read_file', mode); assert.throws(() => authorize('run_command', mode)); }
});
test('workspace selection happens before repository access and cancellation stops resolution', async t => {
  const { root } = await fixture(t); let called = false;
  assert.equal(await resolveRepository([root], async () => { throw new Error('Unexpected picker'); }), await fs.realpath(root));
  assert.equal(await resolveRepository(['missing', root], async choices => { called = true; assert.equal(choices.length, 2); return root; }), await fs.realpath(root));
  assert.ok(called); await assert.rejects(resolveRepository(['missing', root], async () => undefined), /cancelled/);
});
test('index honors ignored tracked/untracked, sensitive, binary, generated and linked paths; refresh updates symbols', async t => {
  const { root, storage, temp } = await fixture(t);
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored*\n');
  await fs.writeFile(path.join(root, 'ignored-tracked.ps1'), 'secret'); await git(root, ['add','-f','ignored-tracked.ps1']);
  await fs.writeFile(path.join(root, 'ignored.ps1'), 'secret'); await fs.writeFile(path.join(root, '.env'), 'key');
  await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0,1,2])); await fs.mkdir(path.join(root, 'dist')); await fs.writeFile(path.join(root, 'dist/x.ps1'), 'x');
  await fs.writeFile(path.join(root, 'main.ps1'), 'function Get-Pilot {\n param([string]$Name)\n}\nImport-Module Test\n. ./helper.ps1\nDescribe "pilot" {}');
  await fs.symlink(storage, path.join(root, 'linked'), 'junction');
  const index = new RepositoryIndex(root, storage); await index.refresh();
  assert.deepEqual([...index.entries.keys()].sort(), ['.gitignore','main.ps1']);
  assert.ok(index.entries.get('main.ps1')?.symbols.some(s => s.kind === 'function' && s.name === 'Get-Pilot'));
  await fs.writeFile(path.join(root, 'main.ps1'), 'function Get-ChangedLonger {}'); await index.refresh();
  assert.equal(index.entries.get('main.ps1')?.symbols[0].name, 'Get-ChangedLonger');
  assert.ok((await fs.stat(path.join(storage, 'index.json'))).isFile());
  const tools = new ReadOnlyTools(index, async () => 'answer');
  assert.match(JSON.stringify(await tools.execute(parseAction('{"version":1,"tool":"search_text","args":{"query":"Changed"}}'), new AbortController().signal)), /main.ps1/);
  await assert.rejects(index.read('.env'));
  await fs.unlink(path.join(root, 'main.ps1')); await fs.writeFile(path.join(temp, 'outside.txt'), 'secret');
  await fs.symlink(temp, path.join(root, 'redirect'), 'junction'); await assert.rejects(index.read('redirect/outside.txt'));
});
test('model discovery validates response and normalizes endpoint; chat uses strict JSON mode', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init) => { calls.push({ url: String(input), init }); return new Response(JSON.stringify(String(input).endsWith('/models') ? { data: [{ id: 'b' },{ id: 'a' },{ id: 'a' }] } : { choices: [{ message: { content: '{"version":1,"tool":"git_status","args":{}}' } }] })); };
  const api = new GeminiClient('https://approved.example/v1/', 'private-key', 1000, transport);
  assert.deepEqual(await api.models(), ['a','b']); await api.complete('a', []);
  assert.equal(calls[0].url, 'https://approved.example/v1/models'); assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(JSON.parse(calls[1].init?.body as string).response_format.type, 'json_object');
  assert.throws(() => apiBase('http://bad.example')); assert.throws(() => apiBase('https://key:secret@bad.example'));
  assert.equal(apiBase('https://approved.example/v1beta/openai/'), 'https://approved.example/v1beta/openai');
  assert.equal(apiBase('https://approved.example/gateway/'), 'https://approved.example/gateway/v1');
  await assert.rejects(new GeminiClient('https://approved.example', 'secret', 1000, async () => new Response('{"data":[]}')).models(), /no models/);
  await assert.rejects(new GeminiClient('https://approved.example', 'secret', 1000, async () => new Response('secret', { status: 401 })).models(), e => e instanceof Error && !e.message.includes('secret') && e.message.includes('401'));
});
test('cancellation aborts API transport, index and loop before tools execute', async t => {
  const { root, storage } = await fixture(t); const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(new RepositoryIndex(root, storage).refresh(cancelled.signal));
  let ran = false;
  await assert.rejects(runAgent({ complete: async () => { ran = true; return ''; } }, 'm', [], { execute: async () => { ran = true; } }, () => 'Review', cancelled.signal, () => {})); assert.equal(ran, false);
  const controller = new AbortController();
  const api = new GeminiClient('https://approved.example', 'secret', 1000, async (_input, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); controller.abort(); }));
  await assert.rejects(api.models(controller.signal), /Cancelled/);
});
test('agent iterates evidence, rejects unsafe actions, and stops at hard limits', async () => {
  let count = 0;
  const answer = await runAgent({ complete: async () => ++count === 1 ? '{"version":1,"tool":"list_files","args":{}}' : '{"version":1,"tool":"complete_task","args":{"summary":"See main.ps1:1"}}' }, 'm', [{ role: 'user', content: 'Explain' }], { execute: async () => ({ files: ['main.ps1'] }) }, () => 'Full access', new AbortController().signal, () => {});
  assert.equal(answer, 'See main.ps1:1'); assert.equal(count, 2);
  await assert.rejects(runAgent({ complete: async () => '{"version":1,"tool":"run_command","args":{}}' }, 'm', [], { execute: async () => { throw new Error('Must not execute'); } }, () => 'Full access', new AbortController().signal, () => {}));
  await assert.rejects(runAgent({ complete: async () => '{"version":1,"tool":"list_files","args":{}}' }, 'm', [], { execute: async () => ({}) }, () => 'Review', new AbortController().signal, () => {}), /20 model turns/);
});
test('named threads persist independently, interrupted tasks recover, corrupt data is preserved', async t => {
  const { root, storage } = await fixture(t); const dir = repositoryStorage(storage, root); const store = new ThreadStore(dir);
  await store.load(); const first = store.create('First'); first.messages.push({ role: 'user', content: 'Question' }); first.status = 'running'; store.create('Second'); await store.save();
  const loaded = new ThreadStore(dir); await loaded.load(); assert.equal(loaded.threads.length, 2); assert.equal(loaded.threads[0].status, 'interrupted'); assert.equal(loaded.threads[0].messages[0].content, 'Question');
  assert.notEqual(dir, repositoryStorage(storage, root + '-other'));
  await fs.writeFile(path.join(dir, 'threads.json'), 'broken'); await assert.rejects(new ThreadStore(dir).load(), /preserved/); assert.equal(await fs.readFile(path.join(dir, 'threads.json'), 'utf8'), 'broken');
});
test('repository lease excludes a second owner and can be reacquired after release', async t => {
  const { root } = await fixture(t); const release = await acquireRepositoryLease(root);
  try { await assert.rejects(acquireRepositoryLease(root), /already open/); } finally { await release(); }
  const again = await acquireRepositoryLease(root); await again();
});
test('new ignore rules revoke file reads and subsequent tool results', async t => {
  const { root, storage } = await fixture(t); await fs.writeFile(path.join(root, 'config.ps1'), 'function Get-Config {}');
  const index = new RepositoryIndex(root, storage); await index.refresh();
  await fs.writeFile(path.join(root, '.gitignore'), 'config.ps1\n');
  await assert.rejects(index.read('config.ps1'), /ignored/);
  const tools = new ReadOnlyTools(index, async () => '');
  const result = await tools.execute(parseAction('{"version":1,"tool":"list_files","args":{}}'), new AbortController().signal);
  assert.ok(!JSON.stringify(result).includes('config.ps1'));
});
test('HTTP response size, timeout and credential echo protections', async () => {
  await assert.rejects(new GeminiClient('https://approved.example', 'private-key', 1000, async () => new Response('x'.repeat(1000001))).models(), /limit/);
  const slow: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(new GeminiClient('https://approved.example', 'private-key', 10, slow).models(), /timed out/);
  const api = new GeminiClient('https://approved.example', 'private-key', 1000, async () => new Response(JSON.stringify({ choices: [{ message: { content: 'echo private-key' } }] })));
  assert.equal(await api.complete('m', []), 'echo [REDACTED API KEY]');
});
test('nested repositories prompt for a boundary before Git execution', async t => {
  const { root } = await fixture(t); const nested = path.join(root, 'nested'); await fs.mkdir(nested); await git(nested, ['init']);
  let choices: string[] = [];
  const selected = await resolveRepository([root], async candidates => { choices = candidates; return nested; });
  assert.equal(selected, await fs.realpath(nested)); assert.deepEqual(choices, [root, nested].sort());
  await assert.rejects(resolveRepository([root], async () => undefined), /cancelled/);
});
test('one protocol correction can recover a missing version without executing invalid actions', async () => {
  let calls = 0; let executions = 0;
  const responses = ['{"tool":"list_files","args":{}}', '{"version":1,"tool":"list_files","args":{}}', '{"version":1,"tool":"complete_task","args":{"summary":"Done"}}'];
  const answer = await runAgent({ complete: async () => responses[calls++] }, 'm', [], { execute: async () => { executions++; return {}; } }, () => 'Review', new AbortController().signal, () => {});
  assert.equal(answer, 'Done'); assert.equal(calls, 3); assert.equal(executions, 1);
  calls = 0;
  await assert.rejects(runAgent({ complete: async () => { calls++; return '{"tool":"list_files","args":{}}'; } }, 'm', [], { execute: async () => { throw new Error('Invalid action executed'); } }, () => 'Review', new AbortController().signal, () => {}), /repeatedly sent an unusable response/);
  assert.equal(calls, 3);
});

test('repeated missing reads stop after two corrections inside the existing action budget', async () => {
  let calls = 0;
  let reads = 0;
  await assert.rejects(runAgent({ complete: async () => { calls++; return JSON.stringify({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash: '0'.repeat(64), edits: [{ oldText: 'a', newText: 'b' }] } }); } }, 'm', [], { execute: async action => { if (action.tool === 'read_file') { reads++; return { path: 'main.ps1', text: 'a' }; } throw new ReadRequired('main.ps1'); } }, () => 'Full access', new AbortController().signal, () => {}), /two read\/hash corrections/);
  assert.equal(calls, 3);
  assert.equal(reads, 2);
});

test('reads, no-op patches and unrelated successful edits do not reset an unresolved file failure', async () => {
  let calls = 0; let reads = 0;
  const controller = new AbortController();
  await assert.rejects(runAgent({ complete: async () => {
    calls++;
    if (calls === 3) return JSON.stringify({ version: 1, tool: 'create_file', args: { path: 'other.ps1', content: 'unrelated' } });
    return JSON.stringify({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: 'a', newText: calls === 2 ? 'a' : 'b' }] } });
  } }, 'mock', [], { execute: async action => {
    if (action.tool === 'read_file') { reads++; return { path: 'main.ps1', text: 'a' }; }
    if (action.tool === 'create_file') return { applied: true };
    if (action.tool === 'apply_patch' && action.args.edits[0].newText === 'a') return { applied: false };
    throw new ReadRequired('main.ps1');
  } }, () => 'Full access', controller.signal, () => {}), /two read\/hash corrections/);
  assert.equal(calls, 5); assert.equal(reads, 2);
});

test('successful mutations allow later independent recovery on the same file', async () => {
  let calls = 0; let edits = 0;
  const summary = await runAgent({ complete: async () => JSON.stringify(++calls === 7
    ? { version: 1, tool: 'complete_task', args: { summary: 'Completed three recovered edits.' } }
    : { version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: 'a', newText: 'b' }] } }) }, 'mock', [], { execute: async action => {
    if (action.tool === 'read_file') return { path: 'main.ps1', text: 'a' };
    if (++edits % 2) throw new ReadRequired('main.ps1');
    return { applied: true };
  } }, () => 'Full access', new AbortController().signal, () => {});
  assert.match(summary, /three recovered edits/); assert.equal(edits, 6);
});

test('file reads preserve literal source while range metadata identifies omitted lines', async t => {
  const { root, storage } = await fixture(t);
  await fs.writeFile(path.join(root, 'main.ps1'), 'first\r\n    "quoted"\r\nlast\r\n');
  const tools = new ReadOnlyTools(new RepositoryIndex(root, storage), async () => '');
  const result = await tools.execute({ version: 1, tool: 'read_file', args: { path: 'main.ps1', startLine: 2, endLine: 2 } }, new AbortController().signal) as { text: string; startLine: number; endLine: number; truncated: boolean };
  assert.equal(result.text, '    "quoted"'); assert.equal(result.startLine, 2); assert.equal(result.endLine, 2); assert.equal(result.truncated, true);
});

test('watcher invalidation refreshes symbols without hiding membership and real deletion still revokes reads', async t => {
  const { root, storage } = await fixture(t); const file = path.join(root, 'main.ps1');
  const stamp = new Date('2020-01-01T00:00:00Z');
  await fs.writeFile(file, 'function Get-First {}'); await fs.utimes(file, stamp, stamp);
  const index = new RepositoryIndex(root, storage); await index.refresh();
  await fs.writeFile(file, 'function Get-Other {}'); await fs.utimes(file, stamp, stamp);
  index.invalidate('main.ps1'); assert.ok(index.entries.has('main.ps1'));
  await index.refresh(); assert.equal(index.entries.get('main.ps1')!.symbols[0].name, 'Get-Other');
  await fs.unlink(file); index.invalidate('main.ps1');
  await assert.rejects(index.readDocument('main.ps1'));
  await index.refresh(); assert.equal(index.entries.has('main.ps1'), false);
});

test('automatic recovery reads respect cancellation and the total read budget', async () => {
  const controller = new AbortController(); let executions = 0;
  const action = JSON.stringify({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: 'a', newText: 'b' }] } });
  await assert.rejects(runAgent({ complete: async () => action }, 'm', [], { execute: async () => { executions++; controller.abort(); throw new ReadRequired('main.ps1'); } }, () => 'Full access', controller.signal, () => {}), /abort/i);
  assert.equal(executions, 1);
  let calls = 0; let reads = 0;
  await assert.rejects(runAgent({ complete: async () => {
    if (++calls <= 6) return JSON.stringify({ version: 1, tool: 'read_files', args: { paths: ['a', 'b', 'c', 'd', 'e'] } });
    return action;
  } }, 'm', [], { execute: async value => { if (value.tool === 'read_files') { reads += value.args.paths.length; return []; } if (value.tool === 'read_file') { reads++; return {}; } throw new ReadRequired('main.ps1'); } }, () => 'Full access', new AbortController().signal, () => {}), /file-read limit/);
  assert.equal(reads, 30);
});


test('isolated format mistakes receive specific feedback without replaying tools or exposing counters', async () => {
  const { runAgent } = await import('../src/agent/loop');
  let calls = 0; let executions = 0; const progress: string[] = [];
  const replies = [
    { version: 1, tool: 'read_file', args: {} },
    { version: 1, tool: 'read_file', args: { path: 'main.ps1' } },
    { version: 1, tool: 'complete_task', args: { summary: 42 } },
    { version: 1, tool: 'complete_task', args: { summary: 'Done' } }
  ];
  const answer = await runAgent({ complete: async (_model, messages) => {
    if (calls === 0) assert.match(messages.at(-1)!.content, /tests\/Value.Tests.ps1/);
    if (calls === 1) assert.match(messages.at(-1)!.content, /args.path/);
    if (calls === 3) assert.match(messages.at(-1)!.content, /args.summary/);
    return JSON.stringify(replies[calls++]);
  } }, 'fake', [{ role: 'user', content: 'create a pester test' }], {
    initialContext: async () => ({ files: ['tests/Value.Tests.ps1'] }),
    execute: async () => { executions++; return {}; }
  }, () => 'Full access', new AbortController().signal, text => progress.push(text));
  assert.equal(answer, 'Done'); assert.equal(executions, 1); assert.equal(calls, 4);
  assert.ok(progress.includes('Reading main.ps1…'));
  assert.ok(progress.every(p => !/context characters|\d+\/20/.test(p)));
});

test('two malformed repair actions after failed validation recover without executing invalid edits', async () => {
  let calls = 0; const executed: string[] = [];
  const patch = { version: 1, tool: 'apply_patch', args: { path: 'tests/Names.Tests.ps1', edits: [{ oldText: 'Should -BeEmpty', newText: 'Should -BeNullOrEmpty' }] } };
  const replies = [
    { version: 1, tool: 'run_validation', args: {} },
    { tool: patch.tool, args: patch.args },
    { ...patch, explanation: 'Correct the assertion' }, patch,
    { version: 1, tool: 'complete_task', args: { summary: 'Repaired.' } }
  ];
  const answer = await runAgent({ complete: async (_model, messages) => {
    if (calls === 3) { assert.equal(messages.length, 2); assert.match(messages[0].content, /format/i); }
    if (calls === 4) assert.ok(messages.some(message => message.content.includes('Parameter set cannot be resolved')));
    return JSON.stringify(replies[calls++]);
  } }, 'mock', [{ role: 'user', content: 'Fix the generated tests for six-character names.' }], { execute: async action => {
    executed.push(action.tool);
    return action.tool === 'run_validation' ? { status: 'failed', steps: [{ command: 'Pester', status: 'failed', detail: { failures: [{ message: 'Parameter set cannot be resolved' }] } }] } : { applied: true };
  } }, () => 'Full access', new AbortController().signal, () => {});
  assert.equal(answer, 'Repaired.'); assert.deepEqual(executed, ['run_validation', 'apply_patch']); assert.equal(calls, 5);
});

test('validation context drops passing-case inventory but preserves repair evidence and original report', async () => {
  const { compactValidation } = await import('../src/agent/loop');
  const report = { round: 1, fingerprint: 'private-state', status: 'failed', steps: [{ command: 'Pester', status: 'failed', detail: { total: 200, passed: 199, cases: Array.from({ length: 200 }, (_, i) => ({ name: `case ${i}`, result: 'Passed' })), failures: [{ name: 'relevant test', message: 'Expected 5', origin: 'unknown' }], comparison: { resolved: [] } } }] };
  const compact = compactValidation(report) as any;
  assert.equal(compact.steps[0].detail.cases, undefined);
  assert.deepEqual(compact.steps[0].detail.failures, report.steps[0].detail.failures);
  assert.equal(report.steps[0].detail.cases.length, 200);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(report).length / 5);
});


test('test inventory supplies source paths as well as existing suites without a model round trip', async () => {
  const { EditingTools } = await import('../src/tools/editing');
  let request: unknown;
  const reads = { execute: async (action: unknown) => { request = action; return { files: ['Get-Value.ps1', 'tests/Value.Tests.ps1'] }; } };
  const tools = new EditingTools(reads as any, {} as any, () => 'Full access', async () => {});
  assert.deepEqual(await tools.initialContext(new AbortController().signal), { files: ['Get-Value.ps1', 'tests/Value.Tests.ps1'] });
  assert.deepEqual(request, { version: 1, tool: 'list_files', args: {} });
});


test('commit request detection rejects discussion and negation; schema rejects push and extra options', async () => {
  const { explicitCommitRequest } = await import('../src/tools/editing');
  for (const text of ['commit it', 'commit the code with that commit message', 'please commit these changes', 'can you commit this?', 'commit just the six character test for now', 'please commit only this test']) assert.ok(explicitCommitRequest(text));
  for (const text of ['explain git commit', 'do not commit', 'commit message suggestion', 'go', 'create a function', 'do not commit just the test', 'please do not commit only this file']) assert.equal(explicitCommitRequest(text), false);
  assert.throws(() => parseAction(JSON.stringify({ version: 1, tool: 'git_commit', args: { message: 'x', paths: ['main.ps1'], push: true } })));
  assert.throws(() => parseAction(JSON.stringify({ version: 1, tool: 'git_commit', args: { message: '', paths: [] } })));
});


test('successful local commit finishes without another model request', async () => {
  let calls = 0;
  const answer = await runAgent({ complete: async () => { calls++; return JSON.stringify({ version: 1, tool: 'git_commit', args: { message: 'Add tests', paths: ['tests/Value.Tests.ps1'] } }); } }, 'fake', [], { execute: async () => ({ hash: 'a'.repeat(40), paths: ['tests/Value.Tests.ps1'] }) }, () => 'Full access', new AbortController().signal, () => {});
  assert.equal(calls, 1); assert.match(answer, /Created local commit/); assert.match(answer, /Nothing was pushed/);
  assert.throws(() => authorize('git_commit', 'Review'));
});
