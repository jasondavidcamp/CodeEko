import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GeminiClient } from '../../src/api/client';
import { git } from '../../src/repository/git';
import { RepositoryIndex } from '../../src/indexing';
import { EditTask } from '../../src/state/editTask';
import { ReadOnlyTools } from '../../src/tools/readOnly';
import { EditingTools } from '../../src/tools/editing';
import { TaskValidation } from '../../src/validation/task';
import { createPowerShellRunner } from '../../src/validation/powershell';
import { runAgent } from '../../src/agent/loop';

async function run() {
  const endpoint = process.env.LLM_RUNTIME_TEST_ENDPOINT, key = process.env.LLM_RUNTIME_TEST_API_KEY, model = process.env.LLM_RUNTIME_TEST_MODEL;
  assert.ok(endpoint && key && model, 'Configure live test credentials in the environment.');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-literal-recovery-'));
  const root = path.join(temp, 'repo'), storage = path.join(temp, 'storage');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 240000);
  try {
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.writeFile(path.join(root, 'Names.ps1'), '# Keep this developer note.\nfunction Get-FiveCharacterName {\n    param([string[]]$Names)\n    $Names | Where-Object { $_.Length -eq 5 }\n}\n');
    await fs.writeFile(path.join(root, 'tests/Names.Tests.ps1'), `BeforeAll { . (Join-Path $PSScriptRoot '../Names.ps1') }
Describe 'Get-FiveCharacterName' {
    It 'selects matching names' {
        $result = @(Get-FiveCharacterName -Names @('Alice', 'Robert', 'Bob', 'Alfred'))
        $result | Should -Be @('Alice')
    }
    It 'returns no results for nonmatching names' {
        @(Get-FiveCharacterName -Names @('Al', 'Jonathan')).Count | Should -Be 0
    }
    It 'handles an empty list' {
        @(Get-FiveCharacterName -Names @()).Count | Should -Be 0
    }
}
`);
    await git(root, ['init']); await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
    await fs.writeFile(path.join(root, 'Notes.txt'), 'unrelated staged work\n'); await git(root, ['add', 'Notes.txt']);
    const staged = await git(root, ['diff', '--cached']);
    const api = new GeminiClient(endpoint, key, 30000);
    const hooks = { mode: () => 'Full access', isDirty: () => false, confirm: async () => false, preview: async () => {} };
    const index = new RepositoryIndex(root, storage), task = await EditTask.capture(index, storage, hooks, controller.signal);
    const validation = new TaskValidation(task, { ...hooks, installMissing: () => false, redact: text => api.redact(text), progress: console.log }, createPowerShellRunner('RemoteSigned'));
    const tools = new EditingTools(new ReadOnlyTools(index, async () => { throw new Error('No clarification needed for fixture.'); }), task, hooks.mode, async () => {}, validation);
    // Reproduce the rejected repeated literal; real Gemini must recover from the
    // diagnostic and raw current read, then complete a representative test update.
    await tools.execute({ version: 1, tool: 'read_file', args: { path: 'tests/Names.Tests.ps1' } }, controller.signal);
    let calls = 0;
    await runAgent({ complete: async (id, messages, signal) => {
      if (++calls === 1) return JSON.stringify({ version: 1, tool: 'apply_patch', args: { path: 'tests/Names.Tests.ps1', edits: [{ oldText: 'Get-FiveCharacterName', newText: 'Get-SixCharacterName' }] } });
      return api.complete(id, messages, signal);
    } }, model, [{ role: 'user', content: 'Change the names function to select exactly six characters and rename it Get-SixCharacterName. Update the existing tests to check the requested behavior, including matching names, no matches and empty input. Keep the existing filenames and developer note. Validate the result.' }], tools, hooks.mode, controller.signal, console.log);
    const report = await validation.run(controller.signal);
    assert.equal(report.status, 'passed');
    const source = await fs.readFile(path.join(root, 'Names.ps1'), 'utf8');
    const tests = await fs.readFile(path.join(root, 'tests/Names.Tests.ps1'), 'utf8');
    assert.match(source, /Get-SixCharacterName/); assert.match(source, /-eq\s+6/); assert.match(source, /# Keep this developer note\./);
    assert.doesNotMatch(tests, /Get-FiveCharacterName/); assert.match(tests, /Robert/); assert.match(tests, /Alfred/);
    assert.equal(await git(root, ['diff', '--cached']), staged);
    console.log(JSON.stringify({ passed: true, modelCalls: calls, validationRounds: report.round, stagedWorkPreserved: true }));
  } finally { clearTimeout(timer); await fs.rm(temp, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error instanceof Error ? error.message : 'Live literal recovery failed.'); process.exitCode = 1; });
