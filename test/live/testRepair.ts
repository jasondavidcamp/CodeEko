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
  const endpoint = process.env.EKOD_TEST_ENDPOINT, key = process.env.EKOD_TEST_API_KEY, model = process.env.EKOD_TEST_MODEL;
  assert.ok(endpoint && key && model, 'Configure live test credentials in the environment.');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-test-repair-'));
  const root = path.join(temp, 'repo'), storage = path.join(temp, 'storage');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 240000);
  try {
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    const source = `# Preserve this developer note.
function Get-SixCharacterName {
    [CmdletBinding()]
    param([Parameter(ValueFromPipeline=$true)][string[]]$Names)
    process { foreach ($name in $Names) { if ($name.Length -eq 6) { $name } } }
}
`;
    await fs.writeFile(path.join(root, 'Names.ps1'), source);
    await fs.writeFile(path.join(root, 'tests/Names.Tests.ps1'), `BeforeAll { . (Join-Path $PSScriptRoot '../Names.ps1') }
Describe 'Six-character names' {
    It 'selects six characters' {
        $result = @('Alicia', 'Brenda', 'Carlos', 'Diana', 'Edward') | Get-SixCharacterName
        $result | Should -Be @('Alicia', 'Brenda', 'Carlos')
    }
    It 'excludes other lengths' {
        $result = @('Al', 'Roberto', 'Chris', 'Jonathan') | Get-SixCharacterName
        $result | Should -BeEmpty
    }
    It 'accepts an empty list' {
        $result = @() | Get-SixCharacterName
        $result | Should -BeEmpty
    }
    It 'handles mixed lengths' {
        $result = @('Banana', 'Orange', 'Cherry', 'Grape', 'Lemon') | Get-SixCharacterName
        $result | Should -Be @('Banana', 'Orange', 'Cherry', 'Lemon')
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
    const initial = await validation.run(controller.signal);
    assert.equal(initial.status, 'failed');
    assert.equal((initial.steps.find(step => step.command.startsWith('Invoke-Pester'))!.detail as { failed: number }).failed, 4);
    const tools = new EditingTools(new ReadOnlyTools(index, async () => { throw new Error('No clarification needed for fixture.'); }), task, hooks.mode, async () => {}, validation);
    let calls = 0;
    await runAgent({ complete: async (id, messages, signal) => {
      // Force one malformed response, then let the real model correct its format
      // and repair the actual failing suite using the normal persisted context.
      if (++calls === 1) return '{"tool":"read_files","args":{"paths":["Names.ps1","tests/Names.Tests.ps1"]}}';
      return api.complete(id, messages, signal);
    } }, model, [{ role: 'user', content: 'The function correctly selects six-character names. Fix incorrect expected outputs and unsupported assertions in the existing four tests. Preserve all input examples, case coverage, source code and unrelated work. Validate the repair. Prior validation: ' + JSON.stringify(initial) }], tools, hooks.mode, controller.signal, console.log);
    const report = await validation.run(controller.signal);
    assert.equal(report.status, 'passed');
    const detail = report.steps.find(step => step.command.startsWith('Invoke-Pester'))!.detail as { total: number; passed: number };
    assert.equal(detail.total, 4); assert.equal(detail.passed, 4);
    assert.equal(await fs.readFile(path.join(root, 'Names.ps1'), 'utf8'), source);
    assert.equal(await git(root, ['diff', '--cached']), staged);
    console.log(JSON.stringify({ passed: true, modelCalls: calls, validationRounds: report.round, testsPassed: 4, sourceAndStagedWorkPreserved: true }));
  } finally { clearTimeout(timer); await fs.rm(temp, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error instanceof Error ? error.message : 'Live test repair failed.'); process.exitCode = 1; });
