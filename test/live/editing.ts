import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { GeminiClient } from '../../src/api/client';
import { runAgent } from '../../src/agent/loop';
import { RepositoryIndex } from '../../src/indexing';
import { git } from '../../src/repository/git';
import { EditTask } from '../../src/state/editTask';
import { ReadOnlyTools } from '../../src/tools/readOnly';
import { EditingTools } from '../../src/tools/editing';
import { encode } from '../../src/repository/document';
import { Action } from '../../src/protocol/actions';

export async function runLiveEditing(review: (task: EditTask) => Promise<void> = async () => {}) {
  const endpoint = process.env.CODEEKO_TEST_ENDPOINT; const key = process.env.CODEEKO_TEST_API_KEY; const modelId = process.env.CODEEKO_TEST_MODEL;
  assert.ok(endpoint && key && modelId, 'Configure the live test environment.');
  const api = new GeminiClient(endpoint, key, 30000);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-live-edit-'));
  const root = path.join(temp, 'repository'); const storage = path.join(temp, 'storage');
  await fs.mkdir(root); await fs.mkdir(path.join(root, 'Private')); await fs.mkdir(path.join(root, 'tests')); await git(root, ['init']);
  const source = 'function Get-WidgetCapacity {\n    param([int]$Workers)\n    return $Workers * 7\n}\n';
  const tests = "Describe 'Widget capacity' {\n    It 'provides capacity for four workers' {\n        (Get-WidgetCapacity -Workers 4) | Should -Be 28\n    }\n}\n";
  const format = { encoding: 'utf8bom' as const, eol: '\r\n' as const, mixedEol: false };
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    await fs.writeFile(path.join(root, 'Private/Get-WidgetCapacity.ps1'), encode(source, format));
    await fs.writeFile(path.join(root, 'tests/Widget.Tests.ps1'), encode(tests, format));
    await fs.writeFile(path.join(root, 'Notes.txt'), 'original\n');
    await git(root, ['add','.']); await git(root, ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
    const developerNote = '# Developer note: preserve this exact line.\n';
    await fs.writeFile(path.join(root, 'Private/Get-WidgetCapacity.ps1'), encode(source + developerNote, format));
    const notes = Buffer.from('original\nPreexisting staged developer note.\n');
    await fs.writeFile(path.join(root, 'Notes.txt'), notes); await git(root, ['add','Notes.txt']);
    const staged = await git(root, ['diff','--cached','--no-ext-diff','--no-textconv']);
    const startHead = await git(root, ['rev-parse','HEAD']);
    const index = new RepositoryIndex(root, storage);
    const hooks = { mode: () => 'Full access', isDirty: () => false, confirm: async () => false, preview: async () => {} };
    const task = await EditTask.capture(index, storage, hooks, controller.signal);
    const tools = new EditingTools(new ReadOnlyTools(index, async () => 'Make only the requested focused edits.'), task, hooks.mode, review);
    const actions: string[] = []; let calls = 0;
    const limitedModel = { complete: async (id: string, messages: Parameters<GeminiClient['complete']>[1], signal?: AbortSignal) => {
      assert.ok(++calls <= 16, 'Editing live test exceeded 16 calls.'); return api.complete(id, messages, signal);
    } };
    const executor = { execute: async (action: Action, signal: AbortSignal) => { actions.push(action.tool); return tools.execute(action, signal); } };
    const summary = await runAgent(limitedModel, modelId, [{ role: 'user', content: 'Change Get-WidgetCapacity to multiply Workers by 9 instead of 7. Update the existing Pester expectation for four workers accordingly. Create docs/CHANGE.md explaining the new multiplier. Preserve the preexisting developer note and all unrelated files. Use minimal exact replacements, avoiding unchanged comment lines. Do not delete, move, execute code, run tests, or commit. Make the changes now and briefly summarize them.' }], executor, hooks.mode, controller.signal, message => console.log(message));
    assert.deepEqual(await fs.readFile(path.join(root, 'Private/Get-WidgetCapacity.ps1')), encode(source.replace('* 7','* 9') + developerNote, format));
    assert.deepEqual(await fs.readFile(path.join(root, 'tests/Widget.Tests.ps1')), encode(tests.replace('Be 28','Be 36'), format));
    assert.match(await fs.readFile(path.join(root, 'docs/CHANGE.md'), 'utf8'), /9/);
    assert.deepEqual(await fs.readFile(path.join(root, 'Notes.txt')), notes);
    assert.equal(await git(root, ['diff','--cached','--no-ext-diff','--no-textconv']), staged);
    assert.equal(await git(root, ['rev-parse','HEAD']), startHead);
    assert.equal(task.changes().length, 3); assert.ok(task.changes().every(change => change.state === 'applied'));
    await task.finish('complete');
    const reloaded = await EditTask.load(index, storage, task.id, hooks);
    assert.match(await reloaded.snapshot(reloaded.changes().find(c => c.path === 'Private/Get-WidgetCapacity.ps1')!.before), /\* 7/);
    await review(reloaded);
    const undoTask = await EditTask.load(index, storage, task.id, { ...hooks, confirm: async () => true });
    await undoTask.undo(controller.signal);
    assert.deepEqual(await fs.readFile(path.join(root, 'Private/Get-WidgetCapacity.ps1')), encode(source + developerNote, format));
    assert.deepEqual(await fs.readFile(path.join(root, 'tests/Widget.Tests.ps1')), encode(tests, format));
    await assert.rejects(fs.stat(path.join(root, 'docs/CHANGE.md')));
    assert.deepEqual(await fs.readFile(path.join(root, 'Notes.txt')), notes);
    assert.equal(await git(root, ['diff','--cached','--no-ext-diff','--no-textconv']), staged);
    console.log('LIVE EDITING PASSED: ' + api.redact(summary));
    return { model: modelId, modelCalls: calls, actions, changedFiles: task.changes().map(c => c.path), preexistingWorkPreserved: true, encodingsPreserved: true, stagedIndexPreserved: true, leftUncommitted: true, reviewSnapshotsReloaded: true, undoRestoredBaseline: true };
  } finally { clearTimeout(timeout); await fs.rm(temp, { recursive: true, force: true }); }
}

if (require.main === module) runLiveEditing().catch(error => { console.error(error instanceof Error ? error.message : 'Live editing failed.'); process.exitCode = 1; });
