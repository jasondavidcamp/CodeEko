import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { runLiveSmoke } from './smoke';
import * as fs from 'node:fs/promises';
import { runLiveEditing } from './editing';
import { NativeReview } from '../../src/ui/review';
import { runLiveValidation } from './validation';
import * as path from 'node:path';
import * as os from 'node:os';
import { git } from '../../src/repository/git';
import { RepositoryIndex } from '../../src/indexing';
import { EditTask } from '../../src/state/editTask';

async function verifyDirtyEditor(): Promise<void> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-host-buffer-'));
  const root = path.join(temp, 'repo'); const storage = path.join(temp, 'storage');
  await fs.mkdir(root); await git(root, ['init']);
  const file = path.join(root, 'main.ps1'); const original = 'function Get-Value { return 1 }\n';
  await fs.writeFile(file, original);
  await git(root, ['add', '.']); await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  try {
    const index = new RepositoryIndex(root, storage);
    const hooks = { mode: () => 'Full access', isDirty: (target: string) => vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'file' && doc.uri.fsPath.toLowerCase() === target.toLowerCase() && doc.isDirty), confirm: async () => false, preview: async () => {} };
    const signal = new AbortController().signal;
    const task = await EditTask.capture(index, storage, hooks, signal);
    const disk = await index.readDocument('main.ps1'); task.observe('main.ps1', disk.hash);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);
    const edit = new vscode.WorkspaceEdit(); edit.insert(document.uri, new vscode.Position(0, 0), '# unsaved developer note\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(document.isDirty, true);
    await assert.rejects(task.execute({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash: disk.hash, edits: [{ oldText: 'return 1', newText: 'return 2' }] } }, signal), /unsaved editor changes/);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    assert.equal(document.getText(), '# unsaved developer note\n' + original);
    assert.equal(task.changes().length, 0);
    // Discard only this synthetic document in the isolated test profile.
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert.equal(document.isDirty, false);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

// Invoked only by VS Code's --extensionTestsPath, never by npm test or a packaged VSIX.
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('jasondavidcamp.ekod');
  assert.ok(extension, 'Development extension must be installed in the test host.');
  await extension.activate(); assert.ok(extension.isActive);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['ekod.open', 'ekod.setKey', 'ekod.selectModel']) assert.ok(commands.includes(command));
  assert.equal(vscode.workspace.getConfiguration('ekod').get('endpoint'), '', 'Fresh profile must have no endpoint default.');
  const startupDeadline = Date.now() + 10000;
  while (!extension.exports.isConversationVisible() && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(extension.exports.isConversationVisible(), true, 'Conversation must appear automatically without invoking Open Conversation.');
  // Check this launch before any explicit focus/refocus can mask restoration problems.
  let startupEvents: { event: string; pid?: number }[] = [];
  const readyDeadline = Date.now() + 15000;
  while (Date.now() < readyDeadline) {
    const report = await vscode.commands.executeCommand<{ launches: { event: string; pid?: number }[][] }>('ekod.exportStartupDiagnostics');
    startupEvents = report?.launches.find(launch => launch.some(event => event.event === 'activate' && event.pid === process.pid)) ?? [];
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    if (startupEvents.some(event => event.event === 'state.ack')) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(startupEvents.some(event => event.event === 'state.ack'), 'Current launch must render automatically; previous launch acknowledgements cannot satisfy this check.');
  assert.equal(await vscode.commands.executeCommand('ekod.open'), true, 'Sidebar provider must initialize.');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  assert.equal(await vscode.commands.executeCommand('ekod.open'), true, 'Refocusing must reuse the sidebar.');
  assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'EKOD').length, 0, 'Conversation must not occupy an editor tab.');
  console.log(`EXTENSION HOST PASSED (VS Code ${vscode.version}): sidebar initialized and refocused without an editor tab.`);
  await verifyDirtyEditor();
  console.log('EXTENSION HOST PASSED: real unsaved editor buffer blocks edits and preserves disk and buffer contents.');
  const diagnostics = await vscode.commands.executeCommand<{ launches: { event: string }[][] }>('ekod.exportStartupDiagnostics');
  assert.ok(diagnostics?.launches.flat().some(entry => entry.event === 'state.ack'), 'The real webview must acknowledge rendering its initial state.');
  for (const event of ['stage.end', 'webview.bootstrap', 'webview.main']) assert.ok(diagnostics?.launches.flat().some(entry => entry.event === event), event);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  console.log('EXTENSION HOST PASSED: exported startup diagnostics include a real webview render acknowledgement.');
  await vscode.commands.executeCommand('ekod.openSettings');
  await vscode.commands.executeCommand('ekod.openSettings');
  const findSettings = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'EKOD Settings');
  const settingsDeadline = Date.now() + 5000;
  while (!findSettings().length && Date.now() < settingsDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  const settingsTabs = findSettings();
  assert.equal(settingsTabs.length, 1, 'Settings must reuse one native editor tab.');
  await vscode.window.tabGroups.close(settingsTabs);
  if (process.env.EKOD_HOST_UI_ONLY === '1') {
    await fs.writeFile(process.env.EKOD_HOST_REPORT!, JSON.stringify({ vscodeVersion: vscode.version, extensionActivation: true, sidebarInitializedAndRefocused: true, dirtyBufferPreserved: true }));
    return;
  }
  const live = await runLiveSmoke();
  const nativeReview = new NativeReview('ekod-test-snapshot');
  let editing;
  try {
    editing = await runLiveEditing(task => nativeReview.open(task));
    const deadline = Date.now() + 5000;
    const diffs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.label.includes('Agent task changes'));
    while (diffs().length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(diffs().length >= 3, 'Native task diffs must open for all edited files.');
    await vscode.window.tabGroups.close(diffs());
  } finally { nativeReview.dispose(); }
  const validation = await runLiveValidation(true);
  assert.ok(process.env.EKOD_HOST_REPORT, 'Test launcher must provide a result path.');
  await fs.writeFile(process.env.EKOD_HOST_REPORT, JSON.stringify({ vscodeVersion: vscode.version, extensionActivation: true, commandsRegistered: true, blankEndpointDefault: true, sidebarInitializedAndRefocused: true, dirtyBufferPreserved: true, nativeDiffsOpened: true, live, editing, validation }));
}
