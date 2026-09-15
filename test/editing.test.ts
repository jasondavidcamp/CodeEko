import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { git } from '../src/repository/git';
import { decode, encode } from '../src/repository/document';
import { RepositoryIndex } from '../src/indexing';
import { EditTask, EditHooks } from '../src/state/editTask';
import { EditingTools } from '../src/tools/editing';
import { ReadOnlyTools } from '../src/tools/readOnly';
import { Action, parseAction } from '../src/protocol/actions';
import { authorize, ReadRequired } from '../src/policy/boundary';
import { runAgent } from '../src/agent/loop';

const signal = () => new AbortController().signal;
async function fixture(t: any, bytes: Buffer = Buffer.from('# stable\nfunction Get-Count {\n    return 4\n}\n# original comment\n')) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-edit-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); const storage = path.join(temp, 'storage');
  await fs.mkdir(root); await git(root, ['init']);
  await fs.writeFile(path.join(root, 'main.ps1'), bytes);
  await fs.writeFile(path.join(root, 'other.ps1'), 'unchanged\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n');
  await git(root, ['add','.']); await git(root, ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
  const index = new RepositoryIndex(root, storage);
  let mode = 'Full access'; let dirty = false; let approved = false; let confirmations = 0; let previews = 0;
  const hooks: EditHooks = { mode: () => mode, isDirty: () => dirty, confirm: async () => { confirmations++; return approved; }, preview: async () => { previews++; } };
  const start = async (previous?: EditTask) => {
    const task = await EditTask.capture(index, storage, hooks, signal(), previous);
    const tools = new EditingTools(new ReadOnlyTools(index, async () => ''), task, hooks.mode, async () => {});
    return { task, tools };
  };
  return { temp, root, storage, index, hooks, start, mode: (value: string) => { mode = value; }, dirty: (value: boolean) => { dirty = value; }, approve: (value: boolean) => { approved = value; }, counts: () => ({ confirmations, previews }) };
}
async function read(tools: EditingTools, file = 'main.ps1'): Promise<string> {
  return (await tools.execute({ version: 1, tool: 'read_file', args: { path: file } }, signal()) as { hash: string }).hash;
}
const patch = (expectedHash: string, oldText = 'return 4', newText = 'return 8'): Action => ({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash, edits: [{ oldText, newText }] } });

test('agent recovers a missing read or copied hash without relaxing external-edit checks', async t => {
  const f = await fixture(t); const { task, tools } = await f.start(); let calls = 0;
  const summary = await runAgent({ complete: async (_model, messages) => {
    calls++;
    if (calls === 1) return JSON.stringify(patch('0'.repeat(64)));
    if (calls === 2) {
      assert.match(messages.at(-1)!.content, /read_required/); assert.equal(task.changes().length, 0);
      return JSON.stringify({ version: 1, tool: 'read_file', args: { path: 'main.ps1' } });
    }
    if (calls === 3) return JSON.stringify(patch(JSON.parse(messages.at(-1)!.content).result.hash));
    return JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Fixed after a fresh read.' } });
  } }, 'mock', [], tools, f.hooks.mode, signal(), () => {});
  assert.match(summary, /fresh read/); assert.equal(calls, 4); assert.equal(task.changes().length, 1);
  await assert.rejects(tools.execute(patch('0'.repeat(64), 'return 8', 'return 12'), signal()), ReadRequired);
  await fs.appendFile(path.join(f.root, 'main.ps1'), '# external save\n');
  const external = await fs.readFile(path.join(f.root, 'main.ps1')); let retries = 0;
  await assert.rejects(runAgent({ complete: async () => { retries++; return JSON.stringify(patch('0'.repeat(64))); } }, 'mock', [], tools, f.hooks.mode, signal(), () => {}), /changed after/);
  assert.equal(retries, 1); assert.deepEqual(await fs.readFile(path.join(f.root, 'main.ps1')), external);
});

test('a conflict after intent is recorded preserves evidence and prevents further task mutations', async t => {
  const f = await fixture(t); const { task, tools } = await f.start();
  const original = await fs.readFile(path.join(f.root, 'main.ps1'));
  const expected = await read(tools);
  // Simulate an editor becoming dirty once the pending operation is recorded.
  f.hooks.isDirty = () => JSON.parse(readFileSync(path.join(task.directory, 'task.json'), 'utf8')).changes.some((change: any) => change.state === 'prepared');
  await assert.rejects(tools.execute(patch(expected), signal()), /unsaved/);
  const evidence = await fs.readFile(path.join(task.directory, 'task.json'));
  assert.deepEqual(await fs.readFile(path.join(f.root, 'main.ps1')), original);
  assert.equal(task.changes()[0].state, 'prepared');
  f.hooks.isDirty = () => false;
  await assert.rejects(tools.execute({ version: 1, tool: 'create_file', args: { path: 'later.txt', content: 'must not execute' } }, signal()), /Unconfirmed edits/);
  assert.deepEqual(await fs.readFile(path.join(task.directory, 'task.json')), evidence);
  await assert.rejects(fs.stat(path.join(f.root, 'later.txt')));
});

test('guarded multi-file edits preserve staged and unstaged developer work and task attribution', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.root, 'other.ps1'), 'user work\n'); await git(f.root, ['add','other.ps1']);
  const original = (await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8')).replace('# original comment', '# developer note');
  await fs.writeFile(path.join(f.root, 'main.ps1'), original);
  const indexBefore = await git(f.root, ['diff','--cached','--no-ext-diff','--no-textconv']);
  const { task, tools } = await f.start();
  const hash = await read(tools); await tools.execute(patch(hash), signal());
  await tools.execute({ version: 1, tool: 'create_file', args: { path: 'Public/New.ps1', content: 'function Get-New { 9 }\n' } }, signal());
  assert.equal(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), original.replace('return 4','return 8'));
  assert.equal(await fs.readFile(path.join(f.root, 'other.ps1'), 'utf8'), 'unchanged\nuser work\n');
  assert.equal(await git(f.root, ['diff','--cached','--no-ext-diff','--no-textconv']), indexBefore);
  const changes = task.changes(); assert.equal(changes.length, 2); assert.equal(changes[0].preexisting, true);
  assert.equal(await task.snapshot(changes[0].before), original);
  assert.equal(changes[1].before, null); assert.equal((await fs.readFile(path.join(f.root, 'Public/New.ps1'))).subarray(0,3).toString('hex'), 'efbbbf');
  await task.finish('complete');
  const reloaded = await EditTask.load(f.index, f.storage, task.id, f.hooks);
  assert.equal(await reloaded.snapshot(reloaded.changes()[0].after), original.replace('return 4','return 8'));
  const followup = await f.start(reloaded); await followup.tools.execute(patch(await read(followup.tools), 'return 8', 'return 12'), signal());
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /developer note/);
});

test('overlapping preexisting edits, stale hashes and unsaved documents stop without overwriting', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'main.ps1'), 'function Get-Count { return 17 }\n');
  const initial = await fs.readFile(path.join(f.root, 'main.ps1'));
  const { tools } = await f.start(); const hash = await read(tools);
  await assert.rejects(tools.execute(patch(hash, 'return 17', 'return 99'), signal()), /preexisting/);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'main.ps1')), initial);
  await fs.appendFile(path.join(f.root, 'main.ps1'), '# external save\n');
  await assert.rejects(tools.execute(patch(hash), signal()), /changed after/);
  f.dirty(true);
  await assert.rejects(tools.execute(patch(hash), signal()), /unsaved/);
});

test('UTF-8 BOM, UTF-16LE BOM, CRLF and final newline are preserved byte-for-byte outside the replacement', async t => {
  for (const encoding of ['utf8', 'utf8bom', 'utf16le'] as const) {
    const bytes = encode('function Get-Count {\n    return 4\n}', { encoding, eol: '\r\n', mixedEol: false });
    const f = await fixture(t, bytes); const { tools } = await f.start();
    await tools.execute(patch(await read(tools)), signal());
    const expected = encode('function Get-Count {\n    return 8\n}', { encoding, eol: '\r\n', mixedEol: false });
    assert.deepEqual(await fs.readFile(path.join(f.root, 'main.ps1')), expected);
  }
});

test('every mode enforces mutation policy; paths cannot escape, cross nested repositories, or overwrite existing files', async t => {
  for (const mode of ['Review','Custom']) assert.throws(() => authorize('create_file', mode));
  for (const mode of ['Workspace','Full access']) authorize('create_file', mode);
  const f = await fixture(t); const { tools } = await f.start();
  const outside = path.join(f.temp, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, path.join(f.root, 'linked'), 'junction');
  await fs.mkdir(path.join(f.root, 'nested')); await git(path.join(f.root, 'nested'), ['init']);
  for (const file of ['../escape.ps1', '.git/config', '.gitignore', 'ignored/x.ps1', '.env', 'linked/x.ps1', 'nested/x.ps1', 'other.ps1', 'NUL.ps1']) {
    await assert.rejects(tools.execute({ version: 1, tool: 'create_file', args: { path: file, content: 'bad' } }, signal()));
  }
  assert.equal(await fs.readFile(path.join(f.root, 'other.ps1'), 'utf8'), 'unchanged\n');
  assert.equal((await fs.readdir(outside)).length, 0);
});

test('delete and move require specific approval, recheck after approval, and never overwrite the destination', async t => {
  const f = await fixture(t); const { task, tools } = await f.start(); const hash = await read(tools);
  const deletion: Action = { version: 1, tool: 'delete_file', args: { path: 'main.ps1', expectedHash: hash } };
  await assert.rejects(tools.execute(deletion, signal()), /not approved/);
  assert.deepEqual(f.counts(), { previews: 1, confirmations: 1 }); assert.ok(await fs.stat(path.join(f.root, 'main.ps1')));
  f.approve(true);
  await assert.rejects(tools.execute({ version: 1, tool: 'move_file', args: { path: 'main.ps1', destination: 'other.ps1', expectedHash: hash } }, signal()), /baseline/);
  await tools.execute({ version: 1, tool: 'move_file', args: { path: 'main.ps1', destination: 'Moved.ps1', expectedHash: hash } }, signal());
  await assert.rejects(fs.stat(path.join(f.root, 'main.ps1')), /ENOENT/);
  const movedHash = await read(tools, 'Moved.ps1');
  await tools.execute({ version: 1, tool: 'delete_file', args: { path: 'Moved.ps1', expectedHash: movedHash } }, signal());
  assert.equal(task.changes().find(c => c.path === 'main.ps1')?.after, null);
  await assert.rejects(fs.stat(path.join(f.root, 'Moved.ps1')), /ENOENT/);
});

test('cancellation retains completed edits and prevents further writes; permission changes during confirmation take effect', async t => {
  const f = await fixture(t); const { task, tools } = await f.start();
  await tools.execute(patch(await read(tools)), signal());
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(tools.execute({ version: 1, tool: 'create_file', args: { path: 'cancelled.ps1', content: 'never' } }, cancelled.signal));
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 8/);
  assert.match(task.summary(), /1 file change/);
  const hash = await read(tools);
  f.hooks.confirm = async () => { f.mode('Review'); return true; };
  await assert.rejects(tools.execute({ version: 1, tool: 'delete_file', args: { path: 'main.ps1', expectedHash: hash } }, signal()), /could not finish safely/);
  assert.ok(await fs.stat(path.join(f.root, 'main.ps1')));
  await task.finish('cancelled');
});

test('external saves and new destinations during approval are preserved; full erasure needs approval', async t => {
  const f = await fixture(t); const { tools } = await f.start(); const hash = await read(tools);
  const before = await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8');
  await assert.rejects(tools.execute(patch(hash, before, ''), signal()), /not approved/);
  f.hooks.confirm = async () => { await fs.appendFile(path.join(f.root, 'main.ps1'), '# external change\n'); return true; };
  await assert.rejects(tools.execute({ version: 1, tool: 'delete_file', args: { path: 'main.ps1', expectedHash: hash } }, signal()), /changed after/);
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /external change/);
  const next = await f.start(); const nextHash = await read(next.tools);
  f.hooks.confirm = async () => { await fs.writeFile(path.join(f.root, 'Destination.ps1'), 'new developer file'); return true; };
  await assert.rejects(next.tools.execute({ version: 1, tool: 'move_file', args: { path: 'main.ps1', destination: 'Destination.ps1', expectedHash: nextHash } }, signal()), /could not finish safely/);
  assert.equal(await fs.readFile(path.join(f.root, 'Destination.ps1'), 'utf8'), 'new developer file');
  assert.ok(await fs.stat(path.join(f.root, 'main.ps1')));
});

test('ambiguous patches, mixed newlines, hard links, and unsafe schemas fail closed', async t => {
  assert.throws(() => parseAction('{"version":1,"tool":"apply_patch","args":{"path":"x","expectedHash":"bad","edits":[]}}'));
  const f = await fixture(t, Buffer.from('return 4\r\nreturn 4\n'));
  const { tools } = await f.start(); const hash = await read(tools);
  await assert.rejects(tools.execute(patch(hash), signal()), /ambiguous/);
  await assert.rejects(tools.execute(patch(hash, 'return 4\nreturn 4\n', 'return 8\n'), signal()), /could not finish safely/);
  await fs.link(path.join(f.root, 'main.ps1'), path.join(f.temp, 'alias.ps1'));
  await assert.rejects(tools.execute(patch(hash), signal()), /Hard-linked/);
  assert.equal(decode(await fs.readFile(path.join(f.root, 'main.ps1'))).mixedEol, true);
});

test('Git clean filters cannot execute during status, baseline capture or editing', async t => {
  const f = await fixture(t);
  const sentinel = path.join(f.temp, 'filter-executed'); const script = path.join(f.temp, 'filter.cjs');
  await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'executed');process.stdin.pipe(process.stdout);`);
  await fs.writeFile(path.join(f.root, '.gitattributes'), '*.ps1 filter=tripwire\n');
  await git(f.root, ['config','filter.tripwire.clean', `node "${script.replaceAll('\\','/')}"`]);
  await git(f.root, ['config','filter.tripwire.required','true']);
  await fs.appendFile(path.join(f.root, 'main.ps1'), '# developer note\n');
  const { tools } = await f.start();
  await tools.execute(patch(await read(tools)), signal());
  await assert.rejects(fs.stat(sentinel), /ENOENT/);
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 8/);
});

test('a single empty-text insertion initializes an empty tracked file', async t => {
  const f = await fixture(t, Buffer.alloc(0)); const { tools } = await f.start();
  await tools.execute(patch(await read(tools), '', 'function Get-Count { 4 }'), signal());
  assert.equal(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), 'function Get-Count { 4 }');
});


test('invalid literal patch recovers within the read correction budget and retains follow-up intent', async t => {
  const f = await fixture(t); const { task, tools } = await f.start(); let calls = 0;
  const history = [{ role: 'user' as const, content: 'Change the return value to eight; preserve my notes.' }, { role: 'assistant' as const, content: 'The previous edit overlapped developer work.' }, { role: 'user' as const, content: 'go' }];
  await runAgent({ complete: async (_model, messages) => {
    calls++;
    assert.ok(messages.some(m => m.content === history[0].content));
    if (calls === 1 || calls === 3) {
      if (calls === 3) { assert.match(messages.at(-1)!.content, /patch_target_required/); assert.equal(task.changes().length, 0); }
      return JSON.stringify({ version: 1, tool: 'read_file', args: { path: 'main.ps1' } });
    }
    if (calls === 2 || calls === 4) return JSON.stringify(patch(JSON.parse(messages.at(-1)!.content).result.hash, calls === 2 ? 'return 999' : 'return 4', 'return 8'));
    return JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Updated.' } });
  } }, 'mock', history, tools, f.hooks.mode, signal(), () => {});
  assert.equal(calls, 5); assert.equal(task.changes().length, 1);
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 8/);
});
