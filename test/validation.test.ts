import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { git } from '../src/repository/git';
import { RepositoryIndex } from '../src/indexing';
import { EditTask } from '../src/state/editTask';
import { TaskValidation, ValidationHooks } from '../src/validation/task';
import { PowerShellRunner, runPowerShell, createPowerShellRunner, validationEnvironment } from '../src/validation/powershell';
import { EditingTools } from '../src/tools/editing';
import { ReadOnlyTools } from '../src/tools/readOnly';
import { runAgent } from '../src/agent/loop';
import { authorize, TaskConflict } from '../src/policy/boundary';

const signal = () => new AbortController().signal;
const available = { version: '5.1.0', modules: { Pester: '5.7.1', PSScriptAnalyzer: '1.24.0' } };
const clean = { count: 0, diagnostics: [] };
async function fixture(t: any) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-validation-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); await fs.mkdir(root); await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'main.ps1'), 'function Get-Value { return 1 }\n');
  await fs.writeFile(path.join(root, 'tests/Value.Tests.ps1'), "Describe 'value' { It 'works' { 1 | Should -Be 1 } }");
  await fs.writeFile(path.join(root, 'tests/Integration.Tests.ps1'), "throw 'Must never execute'");
  await git(root, ['init']); await git(root, ['add','.']); await git(root, ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
  const index = new RepositoryIndex(root, path.join(temp, 'storage'));
  const hooks = { mode: () => 'Full access', isDirty: () => false, confirm: async () => false, preview: async () => {} };
  const task = await EditTask.capture(index, path.join(temp, 'storage'), hooks, signal());
  const validationHooks: ValidationHooks = { ...hooks, selectTests: async candidates => { assert.deepEqual(candidates, ['tests/Value.Tests.ps1']); return candidates; }, installMissing: () => false, progress: () => {}, redact: text => text.replaceAll('private-token', '[REDACTED]') };
  const reads = new ReadOnlyTools(index, async () => '');
  return { root, task, index, hooks, validationHooks, reads };
}
test('validation is mode-gated and child environment excludes secrets and inherited search overrides', () => {
  for (const mode of ['Review','Custom']) assert.throws(() => authorize('run_validation', mode));
  for (const mode of ['Workspace','Full access']) authorize('run_validation', mode);
  process.env.LLM_VALIDATION_SECRET = 'do-not-inherit';
  try { assert.equal(validationEnvironment().LLM_VALIDATION_SECRET, undefined); assert.ok(!validationEnvironment().PATH?.includes(process.cwd())); }
  finally { delete process.env.LLM_VALIDATION_SECRET; }
});
test('completion automatically validates and repairs, preserving failure evidence and enforcing three rounds', async t => {
  const f = await fixture(t); let rounds = 0;
  const runner: PowerShellRunner = async operation => {
    if (operation === 'inspect') return available;
    if (operation === 'parse') { rounds++; return rounds === 1 ? { count: 1, diagnostics: [{ path: 'main.ps1', line: 1, message: 'Wrong value private-token', rule: 'FixtureFailure', severity: 'Error' }] } : clean; }
    if (operation === 'analyze') return clean;
    if (operation === 'pester') return { total: 1, passed: 1, failed: 0, skipped: 0, result: 'Passed', failures: [], containerErrors: [] };
    throw new Error('Unexpected operation');
  };
  const validation = new TaskValidation(f.task, f.validationHooks, runner);
  const tools = new EditingTools(f.reads, f.task, f.hooks.mode, async () => {}, validation);
  let step = 0;
  const summary = await runAgent({ complete: async (_id, messages) => {
    step++;
    if (step === 4) assert.match(messages.at(-1)!.content, /REDACTED/);
    if (step === 1 || step === 4) return JSON.stringify({ version: 1, tool: 'read_file', args: { path: 'main.ps1' } });
    if (step === 2 || step === 5) return JSON.stringify({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash: JSON.parse(messages.at(-1)!.content).result.hash, edits: [{ oldText: step === 2 ? 'return 1' : 'return 2', newText: step === 2 ? 'return 2' : 'return 3' }] } });
    return JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Implemented and validated.' } });
  } }, 'mock', [], tools, f.hooks.mode, signal(), () => {});
  assert.equal(summary, 'Implemented and validated.'); assert.equal(rounds, 2); assert.equal(step, 6);
  assert.match(validation.summary(), /round 2\/3: passed/);
  const journal = await fs.readFile(path.join(f.task.directory, 'validation.json'), 'utf8');
  assert.ok(!journal.includes('private-token')); assert.match(journal, /FixtureFailure/);
  await validation.run(signal()); assert.equal(rounds, 2, 'same bytes reuse results');
  await fs.appendFile(path.join(f.root, 'main.ps1'), '# another round\n'); await validation.run(signal());
  assert.throws(() => validation.assertCanEdit(), TaskConflict);
  await fs.appendFile(path.join(f.root, 'main.ps1'), '# fourth denied\n'); await assert.rejects(validation.run(signal()), /Three validation rounds/);
});
test('missing validators and declined tests are explicit partial results; Pester never auto-discovers execution', async t => {
  const f = await fixture(t); let pesterCalls = 0;
  const validation = new TaskValidation(f.task, { ...f.validationHooks, selectTests: async () => [] }, async operation => {
    if (operation === 'inspect') return { ...available, modules: { ...available.modules, PSScriptAnalyzer: null } };
    if (operation === 'parse') return clean;
    if (operation === 'pester') pesterCalls++;
    throw new Error('Must not run');
  });
  const result = await validation.run(signal());
  assert.equal(result.status, 'partial'); assert.equal(pesterCalls, 0);
  assert.match(validation.summary(), /No test files approved/);
});
test('selection cannot inject paths, stale results are rejected, and cancellation is propagated', async t => {
  const f = await fixture(t);
  const runner: PowerShellRunner = async operation => operation === 'inspect' ? available : clean;
  await assert.rejects(new TaskValidation(f.task, { ...f.validationHooks, selectTests: async () => ['../outside.ps1'] }, runner).run(signal()), /eligibility/);
  await assert.rejects(new TaskValidation(f.task, { ...f.validationHooks, selectTests: async candidates => { await fs.appendFile(path.join(f.root, 'main.ps1'), '# external edit'); return candidates; } }, runner).run(signal()), /Repository changed/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(new TaskValidation(f.task, f.validationHooks, runner).run(cancelled.signal));
});
test('real Windows PowerShell parses without executing and Pester reports failing tests', { skip: process.platform !== 'win32' }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-real-validation-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const marker = path.join(temp, 'must-not-exist');
  const parsed = await runPowerShell('parse', { files: [{ path: 'good.ps1', text: `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'bad')` }, { path: 'bad.ps1', text: 'function Broken {' }] }, signal()) as any;
  assert.equal(parsed.count, 1); await assert.rejects(fs.stat(marker));
  const detected = await runPowerShell('inspect', {}, signal()) as typeof available;
  assert.match(detected.version, /^5\.1\./);
  if (!detected.modules.Pester) { t.diagnostic('Pester unavailable; real test invocation omitted.'); return; }
  const testFile = path.join(temp, 'Value.Tests.ps1');
  await fs.writeFile(testFile, "Describe 'value' { It 'fails meaningfully' { 1 | Should -Be 2 } }");
  const result = await createPowerShellRunner('RemoteSigned')('pester', { paths: [testFile], version: detected.modules.Pester }, signal()) as any;
  assert.equal(result.total, 1); assert.equal(result.failed, 1); assert.match(JSON.stringify(result.failures), /2/);
  if (detected.modules.PSScriptAnalyzer) {
    const analysis = await runPowerShell('analyze', { version: detected.modules.PSScriptAnalyzer, files: [{ path: 'warning.ps1', text: 'function Get-Value { Write-Host 42 }' }] }, signal()) as any;
    assert.ok(analysis.diagnostics.some((item: any) => item.rule === 'PSAvoidUsingWriteHost'));
  }
});

test('third failing validation round blocks completion; child failures never count as passed', async t => {
  const f = await fixture(t);
  const validation = new TaskValidation(f.task, f.validationHooks, async operation => {
    if (operation === 'inspect') return available;
    throw new Error('Synthetic validator process failure');
  });
  const tools = new EditingTools(f.reads, f.task, f.hooks.mode, async () => {}, validation);
  for (let round = 1; round <= 3; round++) {
    const read = await tools.execute({ version: 1, tool: 'read_file', args: { path: 'main.ps1' } }, signal()) as { hash: string };
    await tools.execute({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash: read.hash, edits: [{ oldText: `return ${round}`, newText: `return ${round + 1}` }] } }, signal());
    assert.equal((await validation.run(signal())).status, 'failed');
  }
  await assert.rejects(validation.beforeComplete(signal()), /still fails after three rounds/);
});

test('cancelling an active Pester process stops it and records no successful result', { skip: process.platform !== 'win32' }, async t => {
  const detected = await runPowerShell('inspect', {}, signal()) as typeof available;
  if (!detected.modules.Pester) { t.skip('Supported Pester unavailable.'); return; }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-cancel-validation-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const marker = path.join(temp, 'started'); const testFile = path.join(temp, 'Slow.Tests.ps1');
  await fs.writeFile(testFile, `Describe 'slow' { It 'waits' { [IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'started'); Start-Sleep -Seconds 60; 1 | Should -Be 1 } }`);
  const controller = new AbortController();
  const result = createPowerShellRunner('RemoteSigned')('pester', { paths: [testFile], version: detected.modules.Pester }, controller.signal);
  const rejection = assert.rejects(result, /cancelled/);
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await fs.stat(marker).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(await fs.stat(marker).then(() => true, () => false), 'Fixture must enter the running test before cancellation');
  } finally { controller.abort(); }
  await rejection;
});
