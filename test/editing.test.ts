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
  let mode = 'Workspace'; let dirty = false; let approved = false; let confirmations = 0; let previews = 0;
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

test('resolved patch and move failures do not exhaust recovery for a later source move', async t => {
  const f = await fixture(t); f.mode('Full access');
  await fs.writeFile(path.join(f.root, 'Notes.txt'), 'developer staged work\n'); await git(f.root, ['add', 'Notes.txt']);
  const staged = await git(f.root, ['diff', '--cached']);
  const { tools } = await f.start(); let calls = 0; let sourceHash = ''; let testHash = ''; let refreshed = '';
  const move = (file: string, destination: string, expectedHash: string): Action => ({ version: 1, tool: 'move_file', args: { path: file, destination, expectedHash } });
  const testPatch = (oldText: string): Action => ({ version: 1, tool: 'apply_patch', args: { path: 'other.ps1', edits: [{ oldText, newText: 'updated test' }] } });
  let validationReached = false;
  const executor = { execute: tools.execute.bind(tools), beforeComplete: async () => { validationReached = true; return undefined; } };
  await runAgent({ complete: async (_model, messages) => {
    const result = calls ? JSON.parse(messages.at(-1)!.content).result : undefined;
    switch (++calls) {
      case 1: return JSON.stringify({ version: 1, tool: 'read_file', args: { path: 'main.ps1' } });
      case 2: sourceHash = result.hash; return JSON.stringify(patch(sourceHash));
      case 3: return JSON.stringify({ version: 1, tool: 'read_file', args: { path: 'other.ps1' } });
      case 4: testHash = result.hash; return JSON.stringify(testPatch('missing literal'));
      case 5: assert.equal(result.error, 'patch_target_required'); return JSON.stringify(testPatch('unchanged'));
      case 6: return JSON.stringify(move('other.ps1', 'renamed-test.ps1', testHash));
      case 7: assert.equal(result.error, 'read_required'); return JSON.stringify(move('other.ps1', 'renamed-test.ps1', result.currentRead.hash));
      case 8: return JSON.stringify({ version: 1, tool: 'read_file', args: { path: 'renamed-test.ps1' } });
      case 9: return JSON.stringify(move('main.ps1', 'renamed-source.ps1', sourceHash));
      case 10: assert.equal(result.error, 'read_required'); refreshed = result.currentRead.hash; return JSON.stringify(move('main.ps1', 'renamed-source.ps1', refreshed));
      default: return JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Edits and moves completed.' } });
    }
  } }, 'mock', [], executor, f.hooks.mode, signal(), () => {});
  assert.equal(calls, 11); assert.equal(validationReached, true); assert.notEqual(refreshed, sourceHash);
  assert.match(await fs.readFile(path.join(f.root, 'renamed-source.ps1'), 'utf8'), /return 8/);
  assert.match(await fs.readFile(path.join(f.root, 'renamed-test.ps1'), 'utf8'), /updated test/);
  assert.equal(await git(f.root, ['diff', '--cached']), staged);
});

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


test('Full access deletes, moves and erases without confirmation while preserving stale-file guards', async t => {
  const f = await fixture(t); f.mode('Full access');
  const { tools } = await f.start();
  await tools.execute({ version: 1, tool: 'delete_file', args: { path: 'other.ps1', expectedHash: await read(tools, 'other.ps1') } }, signal());
  const hash = await read(tools);
  await tools.execute({ version: 1, tool: 'move_file', args: { path: 'main.ps1', destination: 'moved.ps1', expectedHash: hash } }, signal());
  const moved = await read(tools, 'moved.ps1');
  const text = await fs.readFile(path.join(f.root, 'moved.ps1'), 'utf8');
  await tools.execute({ version: 1, tool: 'apply_patch', args: { path: 'moved.ps1', expectedHash: moved, edits: [{ oldText: text, newText: '' }] } }, signal());
  assert.equal(f.counts().confirmations, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'moved.ps1'), 'utf8'), '');
  const current = await read(tools, 'moved.ps1');
  await fs.writeFile(path.join(f.root, 'moved.ps1'), 'external edit');
  await assert.rejects(tools.execute({ version: 1, tool: 'delete_file', args: { path: 'moved.ps1', expectedHash: current } }, signal()));
  assert.equal(await fs.readFile(path.join(f.root, 'moved.ps1'), 'utf8'), 'external edit');
});


test('local commit includes only selected whole files and preserves unrelated staged work', async t => {
  const f = await fixture(t); f.mode('Full access');
  await git(f.root, ['config','user.name','Test']); await git(f.root, ['config','user.email','test@example.invalid']);
  await fs.writeFile(path.join(f.root, 'other.ps1'), 'unrelated staged work'); await git(f.root, ['add','other.ps1']);
  const staged = await git(f.root, ['diff','--cached','--','other.ps1']);
  await fs.writeFile(path.join(f.root, 'new.ps1'), 'function Get-New { 1 }');
  const { task } = await f.start();
  const result = await task.commit('Add new function', ['new.ps1'], true, signal());
  assert.match(result.hash, /^[a-f0-9]{40,64}$/);
  assert.equal((await git(f.root, ['show','--format=','--name-only','HEAD'])).trim(), 'new.ps1');
  assert.equal(await git(f.root, ['diff','--cached','--','other.ps1']), staged);
  assert.equal(f.counts().confirmations, 0); assert.ok(task.committed());
  assert.doesNotMatch(task.summary(), /Changes remain uncommitted/);
  await assert.rejects(task.commit('Duplicate', ['new.ps1'], true, signal()), /already attempted/);
});

test('commit requires explicit intent, honors modes and Workspace cancellation, and rejects unsafe configuration', async t => {
  const f = await fixture(t);
  await git(f.root, ['config','user.name','Test']); await git(f.root, ['config','user.email','test@example.invalid']);
  const { task } = await f.start();
  await assert.rejects(task.commit('No request', ['main.ps1'], false, signal()), /explicit request/);
  f.mode('Review'); await assert.rejects(task.commit('Read only', ['main.ps1'], true, signal()), /denied/);
  f.mode('Workspace'); await assert.rejects(task.commit('Declined', ['main.ps1'], true, signal()), /cancelled/);
  assert.equal(f.counts().confirmations, 1);
  f.mode('Full access'); await git(f.root, ['config','commit.gpgsign','true']);
  await assert.rejects(task.commit('Signing', ['main.ps1'], true, signal()), /signing/);
  assert.equal((await git(f.root, ['status','--porcelain'])).trim(), '');
});

test('commit rejects changed buffers, external edits, and excluded paths before staging', async t => {
  const f = await fixture(t); f.mode('Full access');
  await git(f.root, ['config','user.name','Test']); await git(f.root, ['config','user.email','test@example.invalid']);
  const { task } = await f.start();
  f.dirty(true); await assert.rejects(task.commit('Dirty', ['main.ps1'], true, signal()), /unsaved/); f.dirty(false);
  await fs.appendFile(path.join(f.root, 'main.ps1'), '# external');
  await assert.rejects(task.commit('External', ['main.ps1'], true, signal()), /outside this task/);
  await assert.rejects(task.commit('Outside', ['../outside.ps1'], true, signal()));
  assert.equal((await git(f.root, ['diff','--cached'])).trim(), '');
});


test('commit blocks index/reference hooks and selected filters before changing the index', async t => {
  const f = await fixture(t); f.mode('Full access');
  const { task } = await f.start();
  await fs.writeFile(path.join(f.root, '.git/hooks/post-index-change'), 'must not execute');
  await assert.rejects(task.commit('Hook', ['main.ps1'], true, signal()), /hooks/);
  await fs.unlink(path.join(f.root, '.git/hooks/post-index-change'));
  await fs.writeFile(path.join(f.root, '.gitattributes'), '*.ps1 filter=example');
  await assert.rejects(task.commit('Filter', ['main.ps1'], true, signal()), /filters/);
  assert.equal((await git(f.root, ['diff','--cached'])).trim(), '');
});


test('Workspace can commit a selected deletion after in-pane approval', async t => {
  const f = await fixture(t); f.approve(true);
  await git(f.root, ['config','user.name','Test']); await git(f.root, ['config','user.email','test@example.invalid']);
  const { task, tools } = await f.start();
  await tools.execute({ version: 1, tool: 'delete_file', args: { path: 'other.ps1', expectedHash: await read(tools, 'other.ps1') } }, signal());
  await task.commit('Remove unused file', ['other.ps1'], true, signal());
  assert.equal(f.counts().confirmations, 2);
  assert.match(await git(f.root, ['show','--format=','--name-status','HEAD']), /D\s+other.ps1/);
});


test('clean committed files do not inherit stale overlap protection from an earlier task', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'main.ps1'), 'function Get-Count { return 6 }\n');
  const prior = await f.start();
  await git(f.root, ['add','main.ps1']); await git(f.root, ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','Save work']);
  assert.equal((await git(f.root, ['status','--porcelain'])).trim(), '');
  const current = await f.start(prior.task);
  await current.tools.execute(patch(await read(current.tools), 'return 6', 'return 8'), signal());
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 8/);
});

test('Full access can update preexisting overlapping edits without changing staged work', async t => {
  const f = await fixture(t); f.mode('Full access');
  await fs.writeFile(path.join(f.root, 'main.ps1'), 'function Get-Count { return 6 }\n');
  await git(f.root, ['add','main.ps1']); const staged = await git(f.root, ['diff','--cached']);
  const { tools } = await f.start();
  await tools.execute(patch(await read(tools), 'return 6', 'return 8'), signal());
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 8/);
  assert.equal(await git(f.root, ['diff','--cached']), staged);
  assert.equal(f.counts().confirmations, 0);
});


test('patches bind to the latest runtime read without a model-copied hash', async t => {
  const f = await fixture(t); f.mode('Full access'); const { tools } = await f.start();
  const action: Action = { version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: 'return 4', newText: 'return 6' }] } };
  await assert.rejects(tools.execute(action, signal()), ReadRequired);
  await read(tools); await tools.execute(action, signal());
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 6/);
  const next: Action = { version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: 'return 6', newText: 'return 8' }] } };
  await assert.rejects(tools.execute(next, signal()), ReadRequired);
  await read(tools); await fs.appendFile(path.join(f.root, 'main.ps1'), '# external');
  await assert.rejects(tools.execute(next, signal()), /changed after/);
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 6/);
});

test('runtime refreshes rejected edits and supplies post-write contents without another model read turn', async t => {
  const f = await fixture(t); f.mode('Full access'); const { task, tools } = await f.start();
  await fs.appendFile(path.join(f.root, 'other.ps1'), '# staged work\n');
  await git(f.root, ['add', 'other.ps1']);
  const staged = await git(f.root, ['diff', '--cached']);
  let calls = 0;
  await runAgent({ complete: async (_model, messages) => {
    calls++;
    if (calls === 2 || calls === 4) {
      const result = JSON.parse(messages.at(-1)!.content).result;
      assert.equal(result.error, 'read_required');
      assert.match(result.currentRead.text, calls === 2 ? /return 4/ : /return 6/);
      assert.equal(task.changes().length, calls === 2 ? 0 : 1);
    }
    if (calls <= 4) return JSON.stringify({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: calls <= 2 ? 'return 4' : 'return 6', newText: calls <= 2 ? 'return 6' : 'return 8' }] } });
    return JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Updated.' } });
  } }, 'mock', [], tools, f.hooks.mode, signal(), () => {});
  assert.equal(calls, 5);
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 8/);
  assert.equal(await git(f.root, ['diff', '--cached']), staged);
});

test('external saves during automatic read recovery still stop the replacement', async t => {
  const f = await fixture(t); f.mode('Full access'); const { tools } = await f.start(); let calls = 0;
  await assert.rejects(runAgent({ complete: async () => {
    if (++calls === 2) await fs.appendFile(path.join(f.root, 'main.ps1'), '# external save\n');
    return JSON.stringify({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: 'return 4', newText: 'return 8' }] } });
  } }, 'mock', [], tools, f.hooks.mode, signal(), () => {}), /changed after/);
  assert.equal(calls, 2);
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 4[\s\S]*# external save/);
});

test('repeated literal rename is explicit, preflighted and preserves bytes outside its matches', async t => {
  const source = '# developer note\r\nDescribe "Get-FiveCharacterName" {\r\n    Get-FiveCharacterName | Should -Be "Alice"\r\n}\r\n';
  const f = await fixture(t, Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(source)]));
  f.mode('Full access'); const { tools } = await f.start();
  const current = await tools.execute({ version: 1, tool: 'read_file', args: { path: 'main.ps1' } }, signal()) as { text: string };
  assert.equal(current.text, source.replaceAll('\r\n', '\n'));
  const action: Action = { version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: 'Get-FiveCharacterName', newText: 'Get-SixCharacterName', replaceAll: true }] } };
  const ambiguous = structuredClone(action); if (ambiguous.tool === 'apply_patch') delete ambiguous.args.edits[0].replaceAll;
  await assert.rejects(tools.execute(ambiguous, signal()), /matched 2 locations/);
  const missing = structuredClone(action); if (missing.tool === 'apply_patch') missing.args.edits.push({ oldText: 'missing text', newText: '' });
  await assert.rejects(tools.execute(missing, signal()), /matched 0 locations/);
  assert.equal(decode(await fs.readFile(path.join(f.root, 'main.ps1'))).text, current.text);
  await tools.execute(action, signal());
  assert.deepEqual(await fs.readFile(path.join(f.root, 'main.ps1')), Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(source.replaceAll('Get-FiveCharacterName', 'Get-SixCharacterName'))]));
  await read(tools);
  const overlap: Action = { version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: 'Get-SixCharacterName', newText: 'X', replaceAll: true }, { oldText: 'SixCharacter', newText: 'Y', replaceAll: true }] } };
  await assert.rejects(tools.execute(overlap, signal()), /overlap/);
  assert.throws(() => parseAction(JSON.stringify({ ...action, args: { ...action.args, edits: [{ oldText: 'x', newText: 'y', replaceAll: 'true' }] } })));
});

test('replace-all rejects excessive expansion and overlapping literal occurrences before writing', async t => {
  const f = await fixture(t, Buffer.from('a'.repeat(1001))); f.mode('Full access'); const { tools } = await f.start();
  await read(tools);
  const replacement = (oldText: string, newText: string): Action => ({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText, newText, replaceAll: true }] } });
  await assert.rejects(tools.execute(replacement('a', 'b'), signal()), /too many locations/);
  await assert.rejects(tools.execute(replacement('aa', 'b'), signal()), /overlap/);
  await assert.rejects(tools.execute(replacement('aa', 'b'.repeat(12000)), signal()), /file size limit/);
  assert.equal(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), 'a'.repeat(1001));
});


test('status exposes staged and unstaged deletions and both rename paths for local commits', async t => {
  const f = await fixture(t); f.mode('Full access');
  await git(f.root, ['config','user.name','Test']); await git(f.root, ['config','user.email','test@example.invalid']);
  for (const file of ['staged.ps1','ignored.ps1','.env.private']) await fs.writeFile(path.join(f.root,file), 'fixture');
  await git(f.root, ['add','.']); await git(f.root, ['commit','-m','Fixture']);
  await fs.writeFile(path.join(f.root,'.gitignore'), 'ignored.ps1\n');
  await fs.rename(path.join(f.root,'main.ps1'),path.join(f.root,'renamed.ps1'));
  for (const file of ['other.ps1','staged.ps1','ignored.ps1','.env.private']) await fs.unlink(path.join(f.root,file));
  await git(f.root, ['add','--all','--','main.ps1','renamed.ps1','staged.ps1']);
  await fs.writeFile(path.join(f.root,'Notes.txt'),'unrelated staged work'); await git(f.root,['add','Notes.txt']);
  const {task,tools} = await f.start();
  const result = await tools.execute({version:1,tool:'git_status',args:{}},signal()) as {entries:{path:string;status:string}[]};
  for (const file of ['main.ps1','other.ps1','staged.ps1']) assert.ok(result.entries.some(e=>e.path===file && e.status.includes('D')),file);
  assert.ok(result.entries.some(e=>e.path==='renamed.ps1'));
  assert.ok(!result.entries.some(e=>['ignored.ps1','.env.private'].includes(e.path)));
  await task.commit('Rename and remove unused code',result.entries.filter(e=>['main.ps1','other.ps1','staged.ps1','renamed.ps1'].includes(e.path)).map(e=>e.path),true,signal());
  const committed = await git(f.root,['show','--format=','--name-status','--no-renames','HEAD']);
  for (const file of ['main.ps1','other.ps1','staged.ps1']) assert.ok(committed.includes('D\t'+file),file);
  assert.ok(committed.includes('A\trenamed.ps1'));
  assert.equal((await git(f.root,['diff','--cached','--name-only'])).trim(),'Notes.txt');
});
