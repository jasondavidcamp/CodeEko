import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { git } from '../src/repository/git';
import { RepositoryIndex } from '../src/indexing';
import { EditTask, EditHooks } from '../src/state/editTask';
import { encode } from '../src/repository/document';

const signal = () => new AbortController().signal;
async function fixture(t: any, encoding: 'utf8bom' | 'utf16le' = 'utf8bom') {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-undo-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); const storage = path.join(temp, 'storage'); await fs.mkdir(root);
  const bytes = encode('function Get-Value { return 1 }\n' + (encoding === 'utf16le' ? '# developer comment\n' : ''), { encoding, eol: '\r\n', mixedEol: false });
  await fs.writeFile(path.join(root, 'main.ps1'), bytes); await fs.writeFile(path.join(root, 'delete.txt'), 'restore me\n'); await fs.writeFile(path.join(root, 'move.txt'), 'move me\n');
  await git(root, ['init']); await git(root, ['add','.']); await git(root, ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
  const baseline = encode('function Get-Value { return 1 }\n# developer comment\n', { encoding, eol: '\r\n', mixedEol: false });
  await fs.writeFile(path.join(root, 'main.ps1'), baseline); await fs.writeFile(path.join(root, 'Notes.txt'), 'staged developer work\n'); await git(root, ['add','Notes.txt']);
  const index = new RepositoryIndex(root, storage);
  const hooks: EditHooks = { mode: () => 'Workspace', isDirty: () => false, confirm: async () => true, preview: async () => {} };
  const task = await EditTask.capture(index, storage, hooks, signal());
  const observe = async (name: string) => { const doc = await index.readDocument(name); task.observe(name, doc.hash); return doc.hash; };
  await task.execute({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash: await observe('main.ps1'), edits: [{ oldText: 'return 1', newText: 'return 2' }] } }, signal());
  await task.execute({ version: 1, tool: 'create_file', args: { path: 'created.txt', content: 'agent-created' } }, signal());
  await task.execute({ version: 1, tool: 'delete_file', args: { path: 'delete.txt', expectedHash: await observe('delete.txt') } }, signal());
  await task.execute({ version: 1, tool: 'move_file', args: { path: 'move.txt', destination: 'moved.txt', expectedHash: await observe('move.txt') } }, signal());
  await task.finish('complete');
  const load = (custom: Partial<EditHooks> = {}) => EditTask.load(index, storage, task.id, { ...hooks, ...custom });
  return { root, storage, index, hooks, task, baseline, load };
}
test('undo restores exact baseline bytes across patch/create/delete/move without changing staged developer work', async t => {
  const f = await fixture(t); const staged = await git(f.root, ['diff','--cached','--no-ext-diff','--no-textconv']); const head = await git(f.root, ['rev-parse','HEAD']);
  const task = await f.load(); await task.undo(signal());
  assert.deepEqual(await fs.readFile(path.join(f.root, 'main.ps1')), f.baseline);
  assert.equal(await fs.readFile(path.join(f.root, 'delete.txt'), 'utf8'), 'restore me\n');
  assert.equal(await fs.readFile(path.join(f.root, 'move.txt'), 'utf8'), 'move me\n');
  for (const file of ['created.txt','moved.txt']) await assert.rejects(fs.stat(path.join(f.root, file)));
  assert.equal(await git(f.root, ['diff','--cached','--no-ext-diff','--no-textconv']), staged); assert.equal(await git(f.root, ['rev-parse','HEAD']), head);
  assert.match((await f.load()).undoSummary(), /Undo complete: 5/);
  await assert.rejects((await f.load()).undo(signal()), /already been undone/);
});
test('undo preflights every path and rechecks approval-time changes before any restoration', async t => {
  const f = await fixture(t); const agentBytes = await fs.readFile(path.join(f.root, 'main.ps1'));
  await fs.writeFile(path.join(f.root, 'created.txt'), 'later developer work');
  await assert.rejects((await f.load()).undo(signal()), /changed after the task/);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'main.ps1')), agentBytes);
  await fs.writeFile(path.join(f.root, 'created.txt'), 'agent-created');
  await assert.rejects((await f.load({ confirm: async () => { await fs.writeFile(path.join(f.root, 'created.txt'), 'changed during approval'); return true; } })).undo(signal()), /changed after the task/);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'main.ps1')), agentBytes);
});
test('undo restores UTF-16LE BOM and CRLF bytes exactly', async t => {
  const f = await fixture(t, 'utf16le'); await (await f.load()).undo(signal());
  assert.deepEqual(await fs.readFile(path.join(f.root, 'main.ps1')), f.baseline);
});
test('undo denies Review mode, dirty buffers, changed HEAD, and declined confirmation', async t => {
  const f = await fixture(t);
  await assert.rejects((await f.load({ mode: () => 'Review' })).undo(signal()), /denied/);
  await assert.rejects((await f.load({ isDirty: () => true })).undo(signal()), /unsaved/);
  await assert.rejects((await f.load({ confirm: async () => false })).undo(signal()), /not approved/);
  await git(f.root, ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','new HEAD']);
  await assert.rejects((await f.load()).undo(signal()), /checkout changed/);
});
test('a persisted pending restoration resumes after interruption without overwriting later edits', async t => {
  const f = await fixture(t); const file = path.join(f.task.directory, 'task.json');
  const journal = JSON.parse(await fs.readFile(file, 'utf8'));
  // Simulate termination after the first file replacement, before its applied marker was saved.
  journal.undo = { state: 'running', restored: [], pending: 'main.ps1' };
  await fs.writeFile(file, JSON.stringify(journal)); await fs.writeFile(path.join(f.root, 'main.ps1'), f.baseline);
  const loaded = await f.load();
  await assert.rejects(EditTask.capture(f.index, f.storage, f.hooks, signal(), loaded), /undo is incomplete/);
  await loaded.undo(signal()); assert.match(loaded.undoSummary(), /Undo complete/);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'main.ps1')), f.baseline);
});
test('unconfirmed edits and corrupt baseline blobs cannot be undone', async t => {
  const f = await fixture(t); const file = path.join(f.task.directory, 'task.json');
  const journal = JSON.parse(await fs.readFile(file, 'utf8'));
  journal.changes[0].state = 'prepared'; await fs.writeFile(file, JSON.stringify(journal));
  await assert.rejects((await f.load()).undo(signal()), /Unconfirmed edits/);
  journal.changes[0].state = 'applied'; await fs.writeFile(file, JSON.stringify(journal));
  await fs.writeFile(path.join(f.task.directory, 'blobs', journal.changes[0].before), 'corrupt');
  await assert.rejects((await f.load()).undo(signal()), /integrity/);
});
test('cancellation after one restoration is resumable and preserves the completed restoration', async t => {
  const f = await fixture(t); const controller = new AbortController();
  const original = f.index.invalidate.bind(f.index); let restored = 0;
  f.index.invalidate = name => { original(name); if (++restored === 1) controller.abort(); };
  const task = await f.load(); await assert.rejects(task.undo(controller.signal));
  assert.match(task.undoSummary(), /Undo incomplete: 1/);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'main.ps1')), f.baseline);
  f.index.invalidate = original;
  const loaded = await f.load(); await loaded.undo(signal()); assert.match(loaded.undoSummary(), /Undo complete: 5/);
});
