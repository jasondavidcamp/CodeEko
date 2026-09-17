import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../src/agent/loop';
import { RepositoryIndex } from '../src/indexing';
import { git } from '../src/repository/git';
import { EditTask, EditHooks } from '../src/state/editTask';
import { RepositorySession } from '../src/state/repositorySession';
import { TaskValidation } from '../src/validation/task';
import { Action, taskProtocol } from '../src/protocol/actions';
import { performanceDiagnostics } from '../src/state/performanceDiagnostics';
import { TaskConflict } from '../src/policy/boundary';
import { ThreadStore } from '../src/state/threads';

const read: Action = { version: 1, tool: 'read_file', args: { path: 'main.ps1' } };
const patch: Action = { version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: 'return 1', newText: 'return 2' }] } };
const done: Action = { version: 1, tool: 'complete_task', args: { summary: 'Done.' } };
const signal = () => new AbortController().signal;

async function fixture(t: TestContext) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codeeko-lazy-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'), storage = path.join(temp, 'storage');
  await fs.mkdir(root); await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'main.ps1'), 'function Get-Value { return 1 }\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n');
  await fs.writeFile(path.join(root, 'tests/Value.Tests.ps1'), "Describe 'value' { It 'works' { 1 | Should -Be 1 } }");
  await git(root, ['init']); await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  const index = new RepositoryIndex(root, storage);
  const counts = { refresh: 0, capture: 0, validation: 0, launches: 0, ready: 0, questions: 0, previews: 0 };
  const refresh = index.refresh.bind(index);
  index.refresh = async signal => { counts.refresh++; await refresh(signal); };
  const capture = EditTask.capture;
  t.mock.method(EditTask, 'capture', async (...args: Parameters<typeof capture>) => { counts.capture++; return capture(...args); });
  let mode = 'Full access'; let dirty = false; let task: EditTask | undefined; let validation: TaskValidation | undefined;
  const hooks: EditHooks = { mode: () => mode, isDirty: () => dirty, confirm: async () => true, preview: async () => { counts.previews++; } };
  const reviews: string[] = [];
  const options = {
    index, storage, hooks, commitRequested: false, progress: (_text: string) => {},
    ask: async () => { counts.questions++; return 'An answer'; },
    review: async (edit: EditTask) => { for (const change of edit.changes()) reviews.push(await edit.snapshot(change.before), await edit.snapshot(change.after)); },
    ready: async (edit: EditTask, checks: TaskValidation) => { counts.ready++; task = edit; validation = checks; },
    createValidation: (edit: EditTask) => {
      counts.validation++;
      return new TaskValidation(edit, { ...hooks, installMissing: () => false, redact: text => text, progress: () => {} }, async operation => {
        counts.launches++;
        if (operation === 'inspect') return { version: '5.1.0', modules: { Pester: '5.7.1', PSScriptAnalyzer: '1.24.0' } };
        if (operation === 'pester') return { total: 1, passed: 1, failed: 0, skipped: 0, result: 'Passed', failures: [], containerErrors: [] };
        return { count: 0, diagnostics: [] };
      });
    }
  };
  const session = new RepositorySession(options);
  return { root, storage, index, counts, hooks, options, session, reviews, task: () => task!, validation: () => validation!, mode: (value: string) => { mode = value; }, dirty: () => { dirty = true; } };
}
async function noJournals(storage: string) {
  assert.deepEqual(await fs.readdir(path.join(storage, 'tasks')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; }), []);
}

test('hello and test-related ordinary conversation use one unchanged prompt and zero repository preparation', async t => {
  const f = await fixture(t);
  for (const text of ['hello', 'What is a unit test?']) {
    // Even missing previous journals must not be opened for conversation.
    const session = new RepositorySession({ ...f.options, previousTaskId: randomUUID(), undoTaskId: randomUUID() });
    let calls = 0;
    const answer = await runAgent({ complete: async (_model, messages) => {
      calls++; assert.deepEqual(messages, [{ role: 'system', content: taskProtocol('Full access') }, { role: 'user', content: text }]);
      return JSON.stringify(done);
    } }, 'fake', [{ role: 'user', content: text }], session, f.hooks.mode, signal(), () => {});
    assert.equal(answer, 'Done.'); assert.equal(calls, 1);
  }
  assert.deepEqual(f.counts, { refresh: 0, capture: 0, validation: 0, launches: 0, ready: 0, questions: 0, previews: 0 });
  await noJournals(f.storage);
});

test('ask_user and completion work without index, journals, snapshots or validation', async t => {
  const f = await fixture(t); let calls = 0;
  await runAgent({ complete: async (_model, messages) => {
    if (++calls === 1) return JSON.stringify({ version: 1, tool: 'ask_user', args: { question: 'Which tests?' } });
    assert.match(messages.at(-1)!.content, /An answer/); return JSON.stringify(done);
  } }, 'fake', [{ role: 'user', content: 'Explain tests' }], f.session, f.hooks.mode, signal(), () => {});
  assert.equal(calls, 2); assert.equal(f.counts.questions, 1);
  assert.equal(f.counts.refresh + f.counts.capture + f.counts.validation + f.counts.launches + f.counts.ready, 0);
  await noJournals(f.storage);
});

test('read with deferred test inventory refreshes once and never captures an edit baseline', async t => {
  const f = await fixture(t); let calls = 0;
  await runAgent({ complete: async (_model, messages) => {
    if (++calls === 1) { assert.equal(f.counts.refresh, 0); return JSON.stringify(read); }
    assert.ok(messages.some(message => message.content.includes('Repository file inventory') && message.content.includes('tests/Value.Tests.ps1')));
    assert.match(messages.at(-1)!.content, /function Get-Value/); return JSON.stringify(done);
  } }, 'fake', [{ role: 'user', content: 'Explain this function and its tests' }], f.session, f.hooks.mode, signal(), () => {});
  assert.equal(calls, 2); assert.equal(f.counts.refresh, 1); assert.equal(f.counts.capture + f.counts.validation + f.counts.launches, 0);
  await noJournals(f.storage);
});

test('read to edit captures once, validates on completion, reviews snapshots and supports task undo', async t => {
  const f = await fixture(t); let calls = 0;
  const actions: Action[] = [read, patch, { version: 1, tool: 'open_diff', args: { path: 'main.ps1' } }, done];
  await runAgent({ complete: async () => {
    if (calls === 1) assert.equal(f.counts.capture, 0);
    if (calls === 2) { assert.equal(f.counts.refresh, 2, 'one read refresh, one later baseline refresh'); assert.equal(f.counts.capture, 1); }
    return JSON.stringify(actions[calls++]);
  } }, 'fake', [{ role: 'user', content: 'Change return value' }], f.session, f.hooks.mode, signal(), () => {});
  assert.equal(calls, 4); assert.equal(f.counts.capture, 1); assert.equal(f.counts.validation, 1); assert.equal(f.counts.ready, 1);
  assert.ok(f.counts.launches > 0); assert.match(f.validation().summary(), /passed/);
  assert.deepEqual(f.reviews, ['function Get-Value { return 1 }\n', 'function Get-Value { return 2 }\n']);
  await f.task().finish('complete');
  const loaded = await EditTask.load(f.index, f.storage, f.task().id, f.hooks);
  await loaded.undo(signal());
  assert.equal(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), f.reviews[0]);
});

test('direct creation uses one initial refresh, and explicit validation initializes edit state only once', async t => {
  const f = await fixture(t);
  await f.session.execute({ version: 1, tool: 'create_file', args: { path: 'new.ps1', content: '# new file\n' } }, signal());
  assert.equal(f.counts.refresh, 1); assert.equal(f.counts.capture, 1);
  await f.session.execute({ version: 1, tool: 'run_validation', args: {} }, signal());
  await f.session.beforeComplete(signal());
  assert.equal(f.counts.capture, 1); assert.equal(f.counts.validation, 1);
  assert.ok(f.index.entries.has('new.ps1'), 'validation refresh sees new membership');
});

for (const explicitHash of [false, true]) test(`external changes between read and edit reject stale context (expectedHash=${explicitHash})`, async t => {
  const f = await fixture(t); let calls = 0; let digest = '';
  await assert.rejects(runAgent({ complete: async (_model, messages) => {
    if (++calls === 1) return JSON.stringify(read);
    digest = JSON.parse(messages.at(-1)!.content).result.hash;
    await fs.appendFile(path.join(f.root, 'main.ps1'), '# developer change\n');
    return JSON.stringify({ ...patch, args: { ...patch.args, ...(explicitHash ? { expectedHash: digest } : {}) } });
  } }, 'fake', [], f.session, f.hooks.mode, signal(), () => {}), /changed after the agent read/);
  assert.equal(calls, 2); assert.equal(f.counts.ready + f.counts.validation, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), 'function Get-Value { return 1 }\n# developer change\n');
  await noJournals(f.storage);
});

test('rereading cannot silently rebase earlier evidence, and deleted/ignored observations are rejected', async t => {
  const f = await fixture(t);
  await f.session.execute(read, signal());
  await fs.appendFile(path.join(f.root, 'main.ps1'), '# external\n');
  await f.session.execute(read, signal());
  await assert.rejects(f.session.execute(patch, signal()), /changed after the agent read/);
  await noJournals(f.storage);
  for (const change of ['delete', 'ignore']) {
    await fs.writeFile(path.join(f.root, 'main.ps1'), 'function Get-Value { return 1 }\n');
    const session = new RepositorySession(f.options);
    await session.execute(read, signal());
    if (change === 'delete') await fs.unlink(path.join(f.root, 'main.ps1'));
    else await fs.appendFile(path.join(f.root, '.gitignore'), 'main.ps1\n');
    await assert.rejects(session.execute(patch, signal()), TaskConflict);
    await noJournals(f.storage);
  }
});

test('checkout changes after a read stop editing even when the observed file is unchanged', async t => {
  const f = await fixture(t);
  await f.session.execute(read, signal());
  await git(f.root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'external checkout']);
  await assert.rejects(f.session.execute(patch, signal()), /checkout changed/); await noJournals(f.storage);
});

for (const tool of ['search_text', 'find_symbol'] as const) test(`${tool} preserves context hashes without granting explicit file-read authority`, async t => {
  const f = await fixture(t);
  const action: Action = { version: 1, tool, args: { query: 'Get-Value' } };
  await f.session.execute(action, signal());
  assert.equal(f.counts.capture, 0);
  await assert.rejects(f.session.execute(patch, signal()), /Read main.ps1 again/);
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 1/);
  const next = new RepositorySession(f.options);
  await next.execute(action, signal());
  await fs.appendFile(path.join(f.root, 'main.ps1'), '# changed after search\n');
  await next.execute(read, signal());
  await assert.rejects(next.execute(patch, signal()), /changed after the agent read/);
});

test('unconfirmed prior edits are never replayed or inherited as agent-owned changes', async t => {
  const f = await fixture(t);
  await f.session.execute(read, signal()); await f.session.execute(patch, signal()); await f.task().finish('failed');
  const filename = path.join(f.task().directory, 'task.json');
  const journal = JSON.parse(await fs.readFile(filename, 'utf8')); journal.changes[0].state = 'prepared';
  await fs.writeFile(filename, JSON.stringify(journal));
  f.mode('Workspace');
  const next = new RepositorySession({ ...f.options, previousTaskId: f.task().id });
  await next.execute(read, signal());
  await assert.rejects(next.execute({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: 'return 2', newText: 'return 3' }] } }, signal()), /preexisting|overlap/);
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 2/);
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).changes[0].state, 'prepared');
});

test('late baseline protects developer changes and dirty buffers, with undo retaining preexisting bytes', async t => {
  const f = await fixture(t);
  // These edits happen after the message, but before the first repository read.
  await fs.appendFile(path.join(f.root, 'main.ps1'), '# developer comment\n');
  f.mode('Workspace'); await f.session.execute(read, signal());
  await f.session.execute(patch, signal());
  await f.session.execute(read, signal());
  await assert.rejects(f.session.execute({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', edits: [{ oldText: '# developer comment', newText: '# overwritten' }] } }, signal()), /overlap|preexisting/);
  await f.task().finish('blocked');
  await (await EditTask.load(f.index, f.storage, f.task().id, f.hooks)).undo(signal());
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 1[\s\S]*# developer comment/);
  const session = new RepositorySession(f.options); await session.execute(read, signal()); f.dirty();
  await assert.rejects(session.execute(patch, signal()), /unsaved/i);
});

test('cancelled capture removes unpublished snapshots and cannot retry initialization in the same turn', async t => {
  const f = await fixture(t); const controller = new AbortController();
  await f.session.execute(read, controller.signal);
  const readDocument = f.index.readDocument.bind(f.index);
  t.mock.method(f.index, 'readDocument', async (...args: Parameters<typeof readDocument>) => { const doc = await readDocument(...args); controller.abort(); return doc; });
  await assert.rejects(f.session.execute(patch, controller.signal), /abort/i);
  assert.equal(f.counts.ready + f.counts.validation, 0); await noJournals(f.storage);
  await assert.rejects(f.session.execute(patch, signal())); assert.equal(f.counts.capture, 1);
  assert.match(await fs.readFile(path.join(f.root, 'main.ps1'), 'utf8'), /return 1/);
});

test('validation construction failure removes unpublished resources and preserves repository files', async t => {
  const f = await fixture(t);
  const session = new RepositorySession({ ...f.options, createValidation: () => { throw new Error('fixture initialization failure'); } });
  await session.execute(read, signal());
  await assert.rejects(session.execute(patch, signal()), /could not be initialized safely/);
  await assert.rejects(session.execute(patch, signal()), /could not be initialized safely/);
  assert.equal(f.counts.capture, 1); assert.equal(f.counts.ready, 0); await noJournals(f.storage);
});

test('missing/corrupt prior journals and incomplete undo block repository tools but never conversation', async t => {
  const f = await fixture(t);
  await f.session.execute(read, signal()); await f.session.execute(patch, signal()); await f.task().finish('complete');
  const filename = path.join(f.task().directory, 'task.json');
  const original = JSON.parse(await fs.readFile(filename, 'utf8'));
  for (const kind of ['undo', 'corrupt', 'wrong-root', 'missing']) {
    const journal = structuredClone(original);
    if (kind === 'undo') journal.undo = { state: 'running', restored: [], pending: null };
    if (kind === 'corrupt') journal.version = 999;
    if (kind === 'wrong-root') journal.root = path.dirname(f.root);
    await fs.writeFile(filename, JSON.stringify(journal));
    const session = new RepositorySession({ ...f.options, previousTaskId: kind === 'missing' ? randomUUID() : f.task().id, undoTaskId: f.task().id });
    await session.execute(done, signal());
    const before = f.counts.refresh;
    await assert.rejects(session.execute(read, signal()), TaskConflict);
    assert.equal(f.counts.refresh, before, 'journal recovery precedes repository operations');
  }
});

test('permissions reject mutations before any lazy resource initialization', async t => {
  const f = await fixture(t); f.mode('Review');
  await assert.rejects(f.session.execute(patch, signal()), /denied/);
  assert.equal(f.counts.capture + f.counts.refresh + f.counts.validation, 0); await noJournals(f.storage);
});

test('performance retains task timing without local preparation phases for conversation', async t => {
  const f = await fixture(t); performanceDiagnostics.clear();
  await performanceDiagnostics.task(() => runAgent({ complete: async () => JSON.stringify(done) }, 'fake', [], f.session, f.hooks.mode, signal(), () => {}), () => 'complete');
  const report = performanceDiagnostics.snapshot();
  assert.equal(report.tasks.length, 1); assert.ok(report.tasks[0].elapsedMs! >= 0);
  assert.deepEqual(report.phases.map(phase => phase.phase), ['completion-check']);
});

test('restart distinguishes interrupted conversation from active edits without reading edit journals', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codeeko-lazy-history-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ThreadStore(directory);
  const reviewId = randomUUID(), previousId = randomUUID(), currentId = randomUUID();
  for (const kind of ['conversation', 'after-commit', 'edit', 'legacy']) {
    const thread = store.create(kind);
    thread.taskId = previousId; thread.reviewTaskId = reviewId;
    if (kind !== 'after-commit') thread.undoTaskId = reviewId;
    thread.status = 'running';
    if (kind !== 'legacy') thread.activeEditTaskId = kind === 'edit' ? currentId : null;
  }
  await store.save();
  const recovered = new ThreadStore(directory); await recovered.load();
  const [conversation, committed, edit, legacy] = recovered.threads;
  assert.equal(conversation.reviewTaskId, reviewId); assert.equal(conversation.undoTaskId, reviewId);
  assert.equal(committed.reviewTaskId, reviewId); assert.equal(committed.undoTaskId, undefined);
  assert.equal(edit.reviewTaskId, currentId); assert.equal(edit.undoTaskId, currentId);
  assert.equal(legacy.reviewTaskId, previousId); assert.equal(legacy.undoTaskId, previousId);
  for (const thread of recovered.threads) { assert.equal(thread.status, 'interrupted'); assert.equal(thread.taskId, previousId); assert.equal(thread.activeEditTaskId, undefined); }
  await noJournals(directory);
});
