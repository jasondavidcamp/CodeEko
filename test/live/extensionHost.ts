import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { runLiveSmoke } from './smoke';
import * as fs from 'node:fs/promises';
import { runLiveEditing } from './editing';
import { NativeReview } from '../../src/ui/review';
import { runLiveValidation } from './validation';

// Invoked only by VS Code's --extensionTestsPath, never by npm test or a packaged VSIX.
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('internal-pilot.llm-coding-agent-runtime');
  assert.ok(extension, 'Development extension must be installed in the test host.');
  await extension.activate(); assert.ok(extension.isActive);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['llmRuntime.open', 'llmRuntime.setKey', 'llmRuntime.selectModel']) assert.ok(commands.includes(command));
  assert.equal(vscode.workspace.getConfiguration('llmRuntime').get('endpoint'), '', 'Fresh profile must have no endpoint default.');
  await vscode.commands.executeCommand('llmRuntime.open');
  const findTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'LLM Coding Agent Runtime');
  const deadline = Date.now() + 5000;
  // Tab-group notifications are asynchronous across the extension-host/UI boundary.
  while (!findTabs().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const tabs = findTabs();
  assert.equal(tabs.length, 1, 'Conversation webview must open in the actual extension host.');
  await vscode.window.tabGroups.close(tabs);
  console.log(`EXTENSION HOST PASSED (VS Code ${vscode.version}): activation, commands, blank endpoint default and conversation webview lifecycle.`);
  const live = await runLiveSmoke();
  const nativeReview = new NativeReview('llm-runtime-test-snapshot');
  let editing;
  try {
    editing = await runLiveEditing(task => nativeReview.open(task));
    const deadline = Date.now() + 5000;
    const diffs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.label.includes('Agent task changes'));
    while (diffs().length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(diffs().length >= 3, 'Native task diffs must open for all edited files.');
    await vscode.window.tabGroups.close(diffs());
  } finally { nativeReview.dispose(); }
  const validation = await runLiveValidation();
  assert.ok(process.env.LLM_RUNTIME_HOST_REPORT, 'Test launcher must provide a result path.');
  await fs.writeFile(process.env.LLM_RUNTIME_HOST_REPORT, JSON.stringify({ vscodeVersion: vscode.version, extensionActivation: true, commandsRegistered: true, blankEndpointDefault: true, webviewOpenedAndClosed: true, nativeDiffsOpened: true, live, editing, validation }));
}
