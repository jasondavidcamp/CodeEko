import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { GeminiClient } from '../../src/api/client';
import { runAgent } from '../../src/agent/loop';
import { RepositoryIndex } from '../../src/indexing';
import { ReadOnlyTools } from '../../src/tools/readOnly';
import { git } from '../../src/repository/git';
import { ThreadStore } from '../../src/state/threads';
import { Action } from '../../src/protocol/actions';

// Explicit opt-in only. Credentials remain in memory and are never copied to the fixture.
export async function runLiveSmoke() {
  const endpoint = process.env.LLM_RUNTIME_TEST_ENDPOINT;
  const key = process.env.LLM_RUNTIME_TEST_API_KEY;
  const requestedModel = process.env.LLM_RUNTIME_TEST_MODEL;
  assert.ok(endpoint && key && requestedModel, 'Set LLM_RUNTIME_TEST_ENDPOINT, LLM_RUNTIME_TEST_API_KEY and LLM_RUNTIME_TEST_MODEL.');
  const api = new GeminiClient(endpoint, key, 30000);
  const models = await api.models();
  assert.ok(models.includes(requestedModel), 'Requested test model must be returned by discovery.');
  console.log(`Live discovery passed (${models.length} models).`);

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-runtime-live-'));
  const root = path.join(temp, 'repository'); const storage = path.join(temp, 'storage');
  await fs.mkdir(root); await git(root, ['init']);
  const files: Record<string, string> = {
    '.gitignore': 'ignored-data.txt\n',
    'Widget.psd1': "@{ RootModule = 'Widget.psm1'; ModuleVersion = '1.0.0'; FunctionsToExport = @('Get-WidgetPlan') }\n",
    'Widget.psm1': ". $PSScriptRoot/Private/Get-WidgetCapacity.ps1\n. $PSScriptRoot/Public/Get-WidgetPlan.ps1\nExport-ModuleMember -Function Get-WidgetPlan\n",
    'Private/Get-WidgetCapacity.ps1': "function Get-WidgetCapacity {\n    param([int]$Workers)\n    return $Workers * 7\n}\n",
    'Public/Get-WidgetPlan.ps1': "function Get-WidgetPlan {\n    param([int]$Workers)\n    $capacity = Get-WidgetCapacity -Workers $Workers\n    [pscustomobject]@{ Capacity = $capacity; Reserved = 3; Available = $capacity - 3 }\n}\n",
    'tests/Widget.Tests.ps1': "Import-Module $PSScriptRoot/../Widget.psd1 -Force\nDescribe 'Widget plan' {\n    It 'reserves three slots from four workers' {\n        $plan = Get-WidgetPlan -Workers 4\n        $plan.Capacity | Should -Be 28\n        $plan.Available | Should -Be 25\n    }\n}\n",
    '.env': 'EXCLUDED_FIXTURE_MARKER=not-a-real-credential\n',
    'ignored-data.txt': 'Ignored fixture marker\n'
  };
  const digest = async () => {
    const hash = createHash('sha256');
    for (const name of Object.keys(files).sort()) hash.update(name).update(await fs.readFile(path.join(root, name)));
    return hash.digest('hex');
  };
  try {
    for (const [name, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), text);
    }
    const initialDigest = await digest();
    const initialStatus = await git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    const index = new RepositoryIndex(root, storage); await index.refresh();
    assert.ok(!index.entries.has('.env') && !index.entries.has('ignored-data.txt'));
    const tools = new ReadOnlyTools(index, async () => 'Use the repository evidence and make no changes.');
    const actions: string[] = []; const evidence = new Set<string>(); let calls = 0;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
    const model = {
      complete: async (id: string, messages: Parameters<GeminiClient['complete']>[1], signal?: AbortSignal) => {
        assert.ok(++calls <= 16, 'Live test exceeded its 16-call budget.');
        return api.complete(id, messages, signal);
      }
    };
    const executor = {
      execute: async (action: Action, signal: AbortSignal) => {
        actions.push(action.tool);
        const result = await tools.execute(action, signal);
        if (action.tool === 'read_file') evidence.add((action.args as { path: string }).path);
        if (action.tool === 'read_files') (action.args as { paths: string[] }).paths.forEach(file => evidence.add(file));
        return result;
      }
    };
    let answer: string;
    try {
      answer = await runAgent(model, requestedModel, [{ role: 'user', content: 'Explain how the public Widget plan function is exported and how its helper calculates available slots for four workers. Locate the Pester test proving that result. Read the implementation and test files, and cite the relevant file paths and line numbers. Do not execute or change any code.' }], executor, () => 'Review', controller.signal, message => console.log(message));
      assert.ok(evidence.has('Public/Get-WidgetPlan.ps1') && evidence.has('Private/Get-WidgetCapacity.ps1') && evidence.has('tests/Widget.Tests.ps1'), 'Answer must be backed by actual implementation and test reads.');
      assert.match(answer, /28/); assert.match(answer, /25/);
      assert.ok(answer.includes('Get-WidgetPlan.ps1') && answer.includes('Widget.Tests.ps1'), 'Answer must cite implementation and test files.');

      const store = new ThreadStore(storage); await store.load(); const first = store.create('Widget explanation');
      first.messages.push({ role: 'user', content: 'Explain the Widget plan.' }, { role: 'assistant', content: answer }); first.status = 'complete';
      store.create('Another topic'); await store.save();
      const reopened = new ThreadStore(storage); await reopened.load();
      assert.equal(reopened.threads.length, 2); assert.equal(reopened.threads[0].messages[1].content, answer);
      const followup = await runAgent(model, requestedModel, [...reopened.threads[0].messages, { role: 'user', content: 'For five workers, what are capacity and available slots using that same implementation? Briefly give both values and cite the implementation.' }], executor, () => 'Review', controller.signal, message => console.log(message));
      assert.match(followup, /35/); assert.match(followup, /32/);
      console.log(JSON.stringify({ answer: api.redact(answer), followup: api.redact(followup), calls, actions, readFiles: [...evidence] }, null, 2));
    } finally { clearTimeout(timer); }

    // Refresh after a saved edit, then restore the fixture before the unchanged-file check.
    await fs.appendFile(path.join(root, 'Private/Get-WidgetCapacity.ps1'), '\nfunction Get-NewlyIndexedSymbol {}\n');
    await index.refresh(); assert.ok(index.entries.get('Private/Get-WidgetCapacity.ps1')?.symbols.some(s => s.name === 'Get-NewlyIndexedSymbol'));
    await fs.writeFile(path.join(root, 'Private/Get-WidgetCapacity.ps1'), files['Private/Get-WidgetCapacity.ps1']);
    assert.equal(await digest(), initialDigest);
    assert.equal(await git(root, ['status', '--porcelain=v1', '--untracked-files=all']), initialStatus);

    // Cancellation reaches the actual fetch call, without needing a long generated response.
    const cancelled = new AbortController();
    const pending = api.models(cancelled.signal); cancelled.abort();
    await assert.rejects(pending, /Cancelled/);
    console.log('LIVE SMOKE PASSED: grounded answer, follow-up, two-thread persistence, index refresh, cancellation, unchanged repository.');
    return { model: requestedModel, discoveredModels: models.length, modelCalls: calls, actions, readFiles: [...evidence], groundedAnswer: true, followup: true, threadPersistence: true, indexRefresh: true, cancellation: true, repositoryUnchanged: true };
  } finally {
    // Only this function's freshly created temporary directory is removed.
    await fs.rm(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runLiveSmoke().catch(error => {
    console.error(error instanceof Error ? error.message : 'Live smoke failed.');
    process.exitCode = 1;
  });
}
