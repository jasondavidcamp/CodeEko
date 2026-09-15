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

test('delayed watcher notification after a move cannot remove source from a validation snapshot', async t => {
  const f = await fixture(t);
  const tools = new EditingTools(f.reads, f.task, f.hooks.mode, async () => {});
  const read = await tools.execute({ version: 1, tool: 'read_file', args: { path: 'main.ps1' } }, signal()) as { hash: string };
  await tools.execute({ version: 1, tool: 'move_file', args: { path: 'main.ps1', destination: 'Renamed.ps1', expectedHash: read.hash } }, signal());
  const refresh = f.index.refresh.bind(f.index); let refreshed = 0;
  f.index.refresh = async currentSignal => {
    await refresh(currentSignal);
    // A delayed VS Code notification arrives after refresh populated membership,
    // before validation enumerates it following its asynchronous Git checks.
    if (++refreshed === 1) f.index.invalidate('Renamed.ps1');
  };
  const parsed: string[] = []; let pesterCalls = 0;
  const validation = new TaskValidation(f.task, f.validationHooks, async (operation, payload) => {
    if (operation === 'inspect') return available;
    if (operation === 'parse') { parsed.push(...(payload as { files: { path: string }[] }).files.map(file => file.path)); return clean; }
    if (operation === 'analyze') return clean;
    if (operation === 'pester') { pesterCalls++; return { total: 1, passed: 1, failed: 0, skipped: 0, result: 'Passed', failures: [], containerErrors: [] }; }
    throw new Error('Unexpected operation');
  });
  assert.equal((await validation.run(signal())).status, 'passed');
  assert.ok(parsed.includes('Renamed.ps1')); assert.equal(pesterCalls, 1);
});
test('completion automatically validates and repairs, preserving failure evidence and enforcing three rounds', async t => {
  const f = await fixture(t); let rounds = 0;
  const runner: PowerShellRunner = async (operation, payload) => {
    if (operation === 'inspect') { rounds++; return available; }
    if (operation === 'parse') return rounds === 1 && (payload as any).files[0].text.includes('return 2') ? { count: 1, diagnostics: [{ path: 'main.ps1', line: 1, message: 'Wrong value private-token', rule: 'FixtureFailure', severity: 'Error' }] } : clean;
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
  assert.match(validation.summary(), /No test files eligible/);
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
  let roundNumber = 0;
  const validation = new TaskValidation(f.task, f.validationHooks, async operation => {
    if (operation === 'inspect') { roundNumber++; return available; }
    throw new Error(`Synthetic validator process failure ${roundNumber}`);
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

test('source diagnostics distinguish task-start findings from new findings and unknown comparisons', async t => {
  const f = await fixture(t);
  const tools = new EditingTools(f.reads, f.task, f.hooks.mode, async () => {});
  const read = await tools.execute({ version: 1, tool: 'read_file', args: { path: 'main.ps1' } }, signal()) as { hash: string };
  await tools.execute({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash: read.hash, edits: [{ oldText: 'return 1', newText: 'return 2' }] } }, signal());
  let unavailable = false;
  const runner: PowerShellRunner = async (operation, payload) => {
    if (operation === 'inspect') return available;
    if (operation === 'analyze') return clean;
    const current = (payload as any).files[0].text.includes('return 2');
    if (!current && unavailable) throw new Error('Baseline analyzer unavailable');
    const diagnostic = { path: 'main.ps1', line: 1, message: 'Existing issue', rule: 'Existing', severity: 'Error' };
    const findings = [diagnostic, ...(current ? [{ ...diagnostic, message: 'New issue', rule: 'New' }] : [])];
    return { count: findings.length, diagnostics: findings };
  };
  const first = await new TaskValidation(f.task, f.validationHooks, runner).run(signal());
  const detail = first.steps.find(step => step.command.includes('Parser'))!.detail as any;
  assert.deepEqual(detail.diagnostics.map((item: any) => item.origin), ['preexisting','new since task baseline']);
  unavailable = true;
  const second = await new TaskValidation(f.task, f.validationHooks, runner).run(signal());
  assert.ok((second.steps.find(step => step.command.includes('Parser'))!.detail as any).diagnostics.every((item: any) => item.origin === 'unknown'));
});

test('repeating failed validation without edits stops without launching more commands', async t => {
  const f = await fixture(t); let executions = 0;
  const validation = new TaskValidation(f.task, f.validationHooks, async operation => {
    executions++; if (operation === 'inspect') return available;
    throw new Error('Known failure');
  });
  await validation.run(signal()); const count = executions;
  await validation.run(signal()); await assert.rejects(validation.run(signal()), /no repair progress/);
  assert.equal(executions, count);
});

test('unchanged diagnostics after an edit stop repair early even when line numbers move', async t => {
  const f = await fixture(t); let round = 0;
  const validation = new TaskValidation(f.task, f.validationHooks, async operation => {
    if (operation === 'inspect') { round++; return available; }
    if (operation === 'analyze') return clean;
    return { count: 1, diagnostics: [{ path: 'main.ps1', line: round, message: 'Same unresolved failure', rule: 'Same', severity: 'Error' }] };
  });
  await validation.run(signal());
  await fs.appendFile(path.join(f.root, 'main.ps1'), '# unrelated change\n');
  await assert.rejects(validation.run(signal()), /no diagnostic progress/);
  assert.equal(round, 2); assert.match(validation.summary(), /round 2\/3: failed/);
});
test('identical Pester failures stop early despite changed attribution metadata', async t => {
  const f = await fixture(t);
  const validation = new TaskValidation(f.task, f.validationHooks, async operation => {
    if (operation === 'inspect') return available;
    if (operation === 'parse' || operation === 'analyze') return clean;
    const detail = { name: 'value', path: path.join(f.root, 'tests/Value.Tests.ps1'), message: 'Same failed assertion' };
    return { total: 1, passed: 0, failed: 1, skipped: 0, result: 'Failed', failures: [detail], cases: [{ ...detail, result: 'Failed' }], containerErrors: [] };
  });
  await validation.run(signal());
  const tools = new EditingTools(f.reads, f.task, f.hooks.mode, async () => {}, validation);
  const read = await tools.execute({ version: 1, tool: 'read_file', args: { path: 'main.ps1' } }, signal()) as { hash: string };
  await tools.execute({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash: read.hash, edits: [{ oldText: 'return 1', newText: 'return 2' }] } }, signal());
  await assert.rejects(validation.run(signal()), /no diagnostic progress/);
  assert.match(validation.summary(), /preexisting/);
});

test('stale pre-edit Pester observations never become a baseline', async t => {
  const f = await fixture(t); let pesterCalls = 0;
  const validation = new TaskValidation(f.task, f.validationHooks, async operation => {
    if (operation === 'inspect') return available;
    if (operation === 'parse' || operation === 'analyze') return clean;
    if (++pesterCalls === 1) await fs.appendFile(path.join(f.root, 'main.ps1'), '# external change\n');
    const detail = { name: 'value', path: path.join(f.root, 'tests/Value.Tests.ps1'), message: 'failure' };
    return { total: 1, passed: 0, failed: 1, skipped: 0, result: 'Failed', failures: [detail], cases: [{ ...detail, result: 'Failed' }], containerErrors: [] };
  });
  await assert.rejects(validation.run(signal()), /stale/);
  const report = await validation.run(signal());
  const detail = report.steps.find(step => step.command.startsWith('Invoke-Pester'))!.detail as any;
  assert.equal(detail.comparison.baselineRound, null); assert.equal(detail.failures[0].origin, 'unknown');
});

test('real Pester pre-edit comparison reports preexisting and newly failing tests, then observed resolution', { skip: process.platform !== 'win32' }, async t => {
  const runner = createPowerShellRunner('RemoteSigned');
  const detected = await runner('inspect', { pesterMajor: 5 }, signal()) as typeof available;
  if (!detected.modules.Pester || !detected.modules.PSScriptAnalyzer) { t.skip('Pester 5 and analyzer required.'); return; }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-test-baseline-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  const source = 'function Get-Value { return 1 }\nfunction Get-Other { return 1 }\n';
  const testText = "BeforeAll { . (Join-Path $PSScriptRoot '../main.ps1') }\nDescribe 'baseline' { It 'already fails' { Get-Value | Should -Be 2 }; It 'initially passes' { Get-Other | Should -Be 1 } }";
  await fs.writeFile(path.join(root, 'main.ps1'), source); await fs.writeFile(path.join(root, 'tests/Value.Tests.ps1'), testText);
  await git(root, ['init']); await git(root, ['add','.']); await git(root, ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
  await fs.writeFile(path.join(root, 'Notes.txt'), 'developer work'); await git(root, ['add','Notes.txt']);
  const staged = await git(root, ['diff','--cached','--no-ext-diff','--no-textconv']);
  const index = new RepositoryIndex(root, path.join(temp, 'storage'));
  const hooks = { mode: () => 'Full access', isDirty: () => false, confirm: async () => true, preview: async () => {} };
  const task = await EditTask.capture(index, path.join(temp, 'storage'), hooks, signal()); let selections = 0;
  const validation = new TaskValidation(task, { ...hooks, pesterMajor: () => 5, installMissing: () => false, progress: () => {}, redact: text => text, selectTests: async names => { selections++; return names; } }, runner);
  const tools = new EditingTools(new ReadOnlyTools(index, async () => ''), task, hooks.mode, async () => {}, validation);
  const before = await validation.run(signal()); assert.equal(before.status, 'failed');
  const change = async (oldText: string, newText: string) => {
    const doc = await tools.execute({ version: 1, tool: 'read_file', args: { path: 'main.ps1' } }, signal()) as { hash: string };
    await tools.execute({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash: doc.hash, edits: [{ oldText, newText }] } }, signal());
  };
  await change('function Get-Other { return 1 }', 'function Get-Other { return 0 }');
  const after = await validation.run(signal());
  const detail = after.steps.find(step => step.command.startsWith('Invoke-Pester'))!.detail as any;
  assert.deepEqual(detail.failures.map((f: any) => f.origin), ['preexisting','newly failing since baseline']);
  assert.ok(detail.cases.every((c: any) => c.path === 'tests/Value.Tests.ps1'));
  await change('function Get-Value { return 1 }\nfunction Get-Other { return 0 }', 'function Get-Value { return 2 }\nfunction Get-Other { return 1 }');
  const final = await validation.run(signal()); assert.equal(final.round, 3); assert.equal(final.status, 'passed');
  const resolved = (final.steps.find(step => step.command.startsWith('Invoke-Pester'))!.detail as any).comparison.resolved;
  assert.equal(resolved.length, 1); assert.match(resolved[0].name, /already fails/);
  assert.equal(selections, 1); assert.throws(() => validation.assertCanEdit(), /Three/);
  assert.equal(await fs.readFile(path.join(root, 'tests/Value.Tests.ps1'), 'utf8'), testText);
  assert.equal(await git(root, ['diff','--cached','--no-ext-diff','--no-textconv']), staged);
  assert.match(await fs.readFile(path.join(task.directory, 'validation.json'), 'utf8'), /newly failing since baseline/);
});
test('selected Pester major reaches discovery and execution, and changing it invalidates cached results', async t => {
  const f = await fixture(t); let major: 4 | 5 = 4; const versions: string[] = [];
  const validation = new TaskValidation(f.task, { ...f.validationHooks, pesterMajor: () => major }, async (operation, payload) => {
    if (operation === 'inspect') { assert.equal((payload as any).pesterMajor, major); return { ...available, modules: { ...available.modules, Pester: major === 4 ? '4.10.1' : '5.7.1' } }; }
    if (operation === 'parse' || operation === 'analyze') return clean;
    versions.push((payload as any).version);
    return { total: 1, passed: 1, failed: 0, skipped: 0, result: 'Passed', failures: [], containerErrors: [] };
  });
  assert.equal((await validation.run(signal())).round, 1); major = 5;
  assert.equal((await validation.run(signal())).round, 2); assert.deepEqual(versions, ['4.10.1','5.7.1']);
});
test('each installed supported Pester adapter reports pass and failure without substituting majors', { skip: process.platform !== 'win32' }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-pester-versions-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'Versions.Tests.ps1');
  await fs.writeFile(file, "Describe 'versions' { It 'passes' { 2 | Should -Be 2 }; It 'fails' { 1 | Should -Be 2 } }");
  for (const major of [4,5]) {
    const detected = await runPowerShell('inspect', { pesterMajor: major }, signal()) as typeof available;
    await t.test(`Pester ${major}`, { skip: detected.modules.Pester ? false : 'Requested major is not installed; no fallback was used.' }, async () => {
      assert.ok(detected.modules.Pester!.startsWith(`${major}.`));
      const result = await createPowerShellRunner('RemoteSigned')('pester', { paths: [file], version: detected.modules.Pester }, signal()) as any;
      assert.equal(result.total, 2); assert.equal(result.passed, 1); assert.equal(result.failed, 1);
      if (major === 5) {
        assert.equal(result.containerErrors.length, 0, 'assertion failures are not container setup errors');
        assert.equal(result.cases.length, 2);
        assert.ok(result.cases.every((c: any) => c.path === file && c.name.startsWith('versions.')));
        assert.equal(result.failures[0].message, result.cases.find((c: any) => c.result === 'Failed').message);
        await fs.writeFile(file, "throw 'Synthetic discovery failure'");
        const broken = await createPowerShellRunner('RemoteSigned')('pester', { paths: [file], version: detected.modules.Pester }, signal()) as any;
        assert.equal(broken.result, 'Failed');
        assert.ok(broken.containerErrors.some((message: string) => message.includes('Synthetic discovery failure')));
      }
    });
  }
});
test('failed optional module installation is reported as reduced coverage, never as a passed install', async t => {
  const f = await fixture(t);
  const validation = new TaskValidation(f.task, { ...f.validationHooks, installMissing: () => true }, async operation => {
    if (operation === 'inspect') return { ...available, modules: { ...available.modules, PSScriptAnalyzer: null } };
    if (operation === 'install') return { modules: [{ name: 'PSScriptAnalyzer', installed: false, reason: 'Publisher verification refused this version.' }] };
    if (operation === 'parse') return clean;
    return { total: 1, passed: 1, failed: 0, skipped: 0, result: 'Passed', failures: [], containerErrors: [] };
  });
  const result = await validation.run(signal()); assert.equal(result.status, 'partial');
  const installation = result.steps.find(step => step.command.startsWith('Install'))!;
  assert.equal(installation.status, 'skipped'); assert.match(String(installation.detail), /Publisher verification/);
});


test('automatic selection inspects setup and transitive source without executing it', { skip: process.platform !== 'win32' }, async () => {
  const { selectUnitTests } = await import('../src/validation/selection');
  const files = [
    { path: 'main.ps1', text: 'function Get-Value { param([int]$Count) return $Count * 9 }' },
    { path: 'tests/Value.Tests.ps1', text: `. (Join-Path $PSScriptRoot '../main.ps1')
Describe 'value' { It 'works' { Get-Value 4 | Should -Be 36 } }` },
    { path: 'tests/Simple.Tests.ps1', text: `Describe 'simple' { It 'works' { 1 | Should -Be 1 } }` },
    { path: 'tests/Integration.Tests.ps1', text: `Describe 'integration' { It 'works' { 1 | Should -Be 1 } }` },
    { path: 'tests/Setup.Tests.ps1', text: `BeforeAll { Start-Service example }
Describe 'looks unit' { It 'works' { 1 | Should -Be 1 } }` },
    { path: 'tests/Dynamic.Tests.ps1', text: `& $command` },
    { path: 'tests/External.Tests.ps1', text: `. (Join-Path $PSScriptRoot '../../outside.ps1')` },
    { path: 'tests/Method.Tests.ps1', text: `[IO.File]::WriteAllText('tripwire', 'bad')` },
    { path: 'tests/Module.Tests.ps1', text: `Import-Module Operational` },
    { path: 'tests/Tagged.Tests.ps1', text: `Describe 'suite' -Tag Integration { It 'works' { 1 | Should -Be 1 } }` },
    { path: 'tests/Dependency.Tests.ps1', text: `. (Join-Path $PSScriptRoot '../unsafe.ps1')` },
    { path: 'tests/Root.Tests.ps1', text: `$PSScriptRoot = 'elsewhere'; . (Join-Path $PSScriptRoot '../main.ps1')` },
    { path: 'tests/Member.Tests.ps1', text: `$value | ForEach-Object Delete` },
    { path: 'unsafe.ps1', text: 'function Get-Other { Invoke-RestMethod https://example.invalid }' }
  ];
  const result = await selectUnitTests(files, runPowerShell, signal());
  assert.deepEqual(result.selected, ['tests/Value.Tests.ps1', 'tests/Simple.Tests.ps1']);
  assert.equal(result.skipped.length, 10);
  assert.match(result.skipped.find(f => f.path.includes('Dependency'))!.reason, /invoke-restmethod/);
});

test('production validation automatically selects tests and reinspects edits each round without a picker', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); const progress: string[] = []; let executions = 0;
  const validation = new TaskValidation(f.task, { ...f.validationHooks, selectTests: undefined, progress: text => progress.push(text) }, async (operation, payload, abort) => {
    if (operation === 'inspectTests') return runPowerShell(operation, payload, abort);
    if (operation === 'inspect') return available;
    if (operation === 'pester') {
      executions++;
      assert.deepEqual((payload as any).paths, [path.join(f.root, 'tests/Value.Tests.ps1')]);
      return { total: 1, passed: 1, failed: 0, skipped: 0, result: 'Passed', failures: [], containerErrors: [] };
    }
    return clean;
  });
  const first = await validation.run(signal());
  assert.equal(executions, 1);
  assert.ok(first.steps.some(s => s.command.startsWith('Invoke-Pester') && s.status === 'passed'));
  assert.ok(progress.some(p => p.includes('automatically selected')));
  await fs.appendFile(path.join(f.root, 'tests/Value.Tests.ps1'), '\nStart-Service example');
  await validation.run(signal());
  assert.equal(executions, 1, 'changed setup loses eligibility before execution');
  assert.match(validation.summary(), /start-service/);
});


test('native Pester runs automatically selected local unit tests without human selection', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const available = await runPowerShell('inspect', {}, signal()) as any;
  if (!available.modules.Pester) { t.skip('Pester unavailable'); return; }
  await fs.writeFile(path.join(f.root, 'tests/Value.Tests.ps1'), `BeforeAll { . (Join-Path $PSScriptRoot '../main.ps1') }
Describe 'value' { It 'works' { Get-Value | Should -Be 1 } }`);
  const validation = new TaskValidation(f.task, { ...f.validationHooks, selectTests: undefined }, createPowerShellRunner('RemoteSigned'));
  const report = await validation.run(signal());
  const pester = report.steps.find(s => s.command.startsWith('Invoke-Pester'));
  assert.equal(pester?.status, 'passed', validation.summary());
  assert.equal((pester?.detail as any).total, 1);
  assert.equal(report.status, 'partial', 'excluded integration suite is explicitly omitted');
});


test('explicit third failed validation ends the agent immediately with the validation reason', async () => {
  let calls = 0;
  const validation = { run: async () => ({ round: 3, status: 'failed', steps: [] }) };
  const tools = new EditingTools({} as any, {} as any, () => 'Full access', async () => {}, validation as any);
  await assert.rejects(runAgent({ complete: async () => { calls++; return JSON.stringify({ version: 1, tool: 'run_validation', args: {} }); } }, 'fake', [], tools, () => 'Full access', signal(), () => {}), /Validation still fails after three rounds/);
  assert.equal(calls, 1, 'no more model requests after the repair budget is exhausted');
});


test('Pester parameter-set failures provide assertion-specific repair guidance', async t => {
  const f = await fixture(t);
  const validation = new TaskValidation(f.task, f.validationHooks, async operation => {
    if (operation === 'inspect') return available;
    if (operation === 'pester') return { total: 1, passed: 0, failed: 1, skipped: 0, result: 'Failed', failures: [{ name: 'empty input', message: 'Parameter set cannot be resolved using the specified named parameters.' }], containerErrors: [] };
    return clean;
  });
  const report = await validation.run(signal());
  const detail = report.steps.find(step => step.command.startsWith('Invoke-Pester'))!.detail as any;
  assert.match(detail.repairHint, /test assertion|test and check Should syntax/);
  assert.match(detail.repairHint, /@\(\$result\).Count/);
  assert.equal(report.status, 'failed');
});
