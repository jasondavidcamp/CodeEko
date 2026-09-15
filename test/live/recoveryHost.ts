import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RepositoryIndex } from '../../src/indexing';
import { EditTask } from '../../src/state/editTask';
import { ThreadStore, repositoryStorage } from '../../src/state/threads';
import { NativeReview } from '../../src/ui/review';
import { git } from '../../src/repository/git';
import { TaskValidation } from '../../src/validation/task';
import { createPowerShellRunner } from '../../src/validation/powershell';

// Dedicated opt-in host test. Its launcher kills only the isolated instance it created.
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('jasondavidcamp.ekod'); assert.ok(extension); await extension.activate();
  const root = await fs.realpath(vscode.workspace.workspaceFolders![0].uri.fsPath);
  const base = process.env.LLM_RUNTIME_RECOVERY_STORAGE!; const marker = process.env.LLM_RUNTIME_RECOVERY_MARKER!;
  const storage = repositoryStorage(base, root); const index = new RepositoryIndex(root, storage);
  const store = new ThreadStore(storage); await store.load();
  const review = new NativeReview('llm-runtime-recovery-test');
  const hooks = { mode: () => 'Full access', isDirty: () => false, confirm: async () => true, preview: (file: string, before: string, after: string) => review.preview(file, before, after) };
  const signal = new AbortController().signal;
  if (process.env.LLM_RUNTIME_RECOVERY_PHASE === 'seed') {
    const first = store.create('Interrupted feature'); first.messages.push({ role: 'user', content: 'Change the return value to 2.' }); first.status = 'running';
    const second = store.create('Other conversation'); second.messages.push({ role: 'user', content: 'Keep this independent history.' });
    const task = await EditTask.capture(index, storage, hooks, signal);
    first.taskId = task.id; await store.save();
    const document = await index.readDocument('main.ps1'); task.observe('main.ps1', document.hash);
    await task.execute({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash: document.hash, edits: [{ oldText: 'return 1', newText: 'return 2' }] } }, signal);
    const validation = new TaskValidation(task, { ...hooks, selectTests: async candidates => { assert.deepEqual(candidates, ['tests/Slow.Tests.ps1']); return candidates; }, installMissing: () => false, progress: () => {}, redact: text => text }, createPowerShellRunner('RemoteSigned'));
    let completed = false;
    const running = validation.run(signal).finally(() => { completed = true; });
    // Attach a rejection handler while waiting for the controlled child-process checkpoint.
    void running.catch(() => {});
    const deadline = Date.now() + 30000;
    const childMarker = process.env.LLM_RUNTIME_RECOVERY_CHILD!;
    while (!await fs.stat(childMarker).then(() => true, () => false)) {
      if (completed || Date.now() > deadline) throw new Error('Synthetic Pester validation did not reach its checkpoint.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const { validatorPid, descendantPid } = JSON.parse(await fs.readFile(childMarker, 'utf8'));
    for (const pid of [validatorPid, descendantPid]) { assert.ok(Number.isInteger(pid) && pid > 0); process.kill(pid, 0); }
    // Keep validation running; the launcher kills this host PID alone first.
    await fs.writeFile(marker, JSON.stringify({ id: task.id, thread: first.id, root, hostPid: process.pid, validatorPid, descendantPid, staged: await git(root, ['diff','--cached','--no-ext-diff','--no-textconv']) }));
    await running;
    return;
  }
  try {
    const seeded = JSON.parse(await fs.readFile(marker, 'utf8'));
    assert.equal(store.threads.length, 2);
    const interrupted = store.threads.find(thread => thread.id === seeded.thread)!;
    assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.undoTaskId, seeded.id);
    assert.equal(store.threads[1].messages[0].content, 'Keep this independent history.');
    assert.equal(await fs.readFile(path.join(root, 'main.ps1'), 'utf8'), 'function Get-Value { return 2 }\n# developer note\n');
    assert.equal(await vscode.commands.executeCommand('llmRuntime.open'), true, 'Sidebar must restore after restart.');
    // Opening the real panel must not replay the interrupted mutation or undo automatically.
    assert.equal(await fs.readFile(path.join(root, 'main.ps1'), 'utf8'), 'function Get-Value { return 2 }\n# developer note\n');
    const task = await EditTask.load(index, storage, seeded.id, hooks);
    assert.equal(task.changes()[0].state, 'applied');
    const validation = JSON.parse(await fs.readFile(path.join(task.directory, 'validation.json'), 'utf8'));
    assert.equal(validation.reports.length, 1); assert.notEqual(validation.reports[0].status, 'passed');
    assert.ok(!validation.reports[0].steps.some((step: any) => step.command.includes('Pester') && step.status === 'passed'));
    await assert.rejects(task.execute({ version: 1, tool: 'create_file', args: { path: 'replayed.txt', content: 'must not execute' } }, signal), /closed/);
    await review.open(task); await task.undo(signal);
    assert.equal(await fs.readFile(path.join(root, 'main.ps1'), 'utf8'), 'function Get-Value { return 1 }\n# developer note\n');
    assert.equal(await git(root, ['diff','--cached','--no-ext-diff','--no-textconv']), seeded.staged);
    await assert.rejects(fs.stat(path.join(root, 'replayed.txt')));
    await fs.writeFile(process.env.LLM_RUNTIME_RECOVERY_REPORT!, JSON.stringify({ vscodeVersion: vscode.version, threadsRecovered: true, interruptedStatus: true, appliedEditPreserved: true, validationInterrupted: true, noFalseValidationPass: true, noAutomaticReplay: true, nativeSidebarReopened: true, undoAfterRestart: true, developerWorkPreserved: true }));
  } finally { review.dispose(); }
}
