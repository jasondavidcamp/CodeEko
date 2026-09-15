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
import { TaskValidation } from '../../src/validation/task';
import { runPowerShell, createPowerShellRunner } from '../../src/validation/powershell';

export async function runLiveValidation(injectMissingRead = false) {
  const endpoint = process.env.LLM_RUNTIME_TEST_ENDPOINT; const key = process.env.LLM_RUNTIME_TEST_API_KEY; const model = process.env.LLM_RUNTIME_TEST_MODEL;
  assert.ok(endpoint && key && model, 'Configure live test endpoint, key and model in the environment.');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-live-validation-')); const root = path.join(temp, 'repo');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 240000);
  try {
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    const source = 'function Get-WidgetCapacity {\n    param([int]$Workers)\n    return $Workers * 7\n}\n';
    const testText = "BeforeAll { . (Join-Path $PSScriptRoot '../main.ps1') }\nDescribe 'Widget capacity' {\n    It 'provides capacity for four workers' { (Get-WidgetCapacity -Workers 4) | Should -Be 36 }\n}\n";
    await fs.writeFile(path.join(root, 'main.ps1'), source); await fs.writeFile(path.join(root, 'tests/Widget.Tests.ps1'), testText);
    await fs.writeFile(path.join(root, 'tests/Integration.Tests.ps1'), "throw 'Integration tripwire must never execute'");
    await git(root, ['init']); await git(root, ['add','.']); await git(root, ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
    const head = await git(root, ['rev-parse','HEAD']);
    await fs.writeFile(path.join(root, 'Notes.txt'), 'preexisting staged work\n'); await git(root, ['add','Notes.txt']);
    const staged = await git(root, ['diff','--cached','--no-ext-diff','--no-textconv']);
    const api = new GeminiClient(endpoint, key, 30000);
    const hooks = { mode: () => 'Full access', isDirty: () => false, confirm: async () => false, preview: async () => {} };
    const index = new RepositoryIndex(root, path.join(temp, 'storage'));
    const task = await EditTask.capture(index, path.join(temp, 'storage'), hooks, controller.signal);
    const validation = new TaskValidation(task, { ...hooks, installMissing: () => false, redact: text => api.redact(text), progress: console.log, selectTests: async candidates => { assert.deepEqual(candidates, ['tests/Widget.Tests.ps1']); return candidates; } }, createPowerShellRunner('RemoteSigned'));
    // Establish a real failing validation result before asking the model to repair it.
    const initial = await validation.run(controller.signal);
    assert.equal(initial.status, 'failed');
    const failedTests = initial.steps.find(step => step.command.startsWith('Invoke-Pester'));
    assert.equal(failedTests?.status, 'failed');
    const tools = new EditingTools(new ReadOnlyTools(index, async () => 'Fix the implementation, preserving existing test expectations.'), task, hooks.mode, async () => {}, validation);
    let calls = 0;
    let readCorrection = false;
    const summary = await runAgent({ complete: async (id, messages, signal) => {
      assert.ok(++calls <= 16);
      if (injectMissingRead && calls === 1) return JSON.stringify({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash: '0'.repeat(64), edits: [{ oldText: '* 7', newText: '* 9' }] } });
      return api.complete(id, messages, signal);
    } }, model, [{ role: 'user', content: 'The existing unit test requires capacity 36 for four workers. Repair the implementation to pass this test, preserving test expectations and unrelated work. Add docs/CHANGE.md explaining the corrected multiplier. Run validation and finish with actual results. Here is the first validation report:\n' + JSON.stringify(initial) }], tools, hooks.mode, controller.signal, text => { if (text.includes('A fresh read')) readCorrection = true; console.log(text); });
    if (injectMissingRead) assert.equal(readCorrection, true);
    const final = await validation.run(controller.signal);
    assert.equal(final.status, 'passed'); assert.ok(final.round >= 2 && final.round <= 3);
    assert.match(await fs.readFile(path.join(root, 'main.ps1'), 'utf8'), /\*\s*9/);
    assert.equal(await fs.readFile(path.join(root, 'tests/Widget.Tests.ps1'), 'utf8'), testText);
    assert.equal(await git(root, ['rev-parse','HEAD']), head); assert.equal(await git(root, ['diff','--cached','--no-ext-diff','--no-textconv']), staged);
    await task.finish('complete');
    console.log('LIVE VALIDATION PASSED: ' + api.redact(summary));
    const installed = await runPowerShell('inspect', {}, controller.signal);
    return { model, modelCalls: calls, validationRounds: final.round, readCorrection, initialFailure: true, repaired: true, preexistingWorkPreserved: true, testsPreserved: true, leftUncommitted: true, installed };
  } finally { clearTimeout(timer); await fs.rm(temp, { recursive: true, force: true }); }
}
if (require.main === module) runLiveValidation().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error instanceof Error ? error.message : 'Live validation failed.'); process.exitCode = 1; });
