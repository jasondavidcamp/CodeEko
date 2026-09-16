import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { git } from '../src/repository/git';
import { RepositoryIndex } from '../src/indexing';
import { EditTask } from '../src/state/editTask';
import { encode } from '../src/repository/document';

test('forced process death preserves evidence at repository mutation boundaries', { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
  for (const scenario of ['partial-write','replace-before','replace-after','replace-again','delete-before','delete-after','move-first-journal','move-linked','move-unlinked','create-linked','create-recorded']) await t.test(scenario, async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-interruption-'));
    const root = path.join(temp, 'repo'); const storage = path.join(temp, 'storage'); await fs.mkdir(root);
    const format = { encoding: scenario.startsWith('replace') || scenario === 'partial-write' ? 'utf8bom' as const : 'utf16le' as const, eol: '\r\n' as const, mixedEol: false };
    const original = encode('function Get-Value { return 1 }\n', format);
    const baseline = encode('function Get-Value { return 1 }\n# developer comment\n', format);
    const main = path.join(root, 'main.ps1'); const target = path.join(root, 'created.ps1');
    await fs.writeFile(main, original); await git(root, ['init']); await git(root, ['add','.']);
    await git(root, ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
    await fs.writeFile(main, baseline); await fs.writeFile(path.join(root, 'Notes.txt'), 'staged developer work\n'); await git(root, ['add','Notes.txt']);
    const staged = await git(root, ['diff','--cached','--no-ext-diff','--no-textconv']); const head = await git(root, ['rev-parse','HEAD']);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
    const worker = spawn(process.execPath, [path.join(__dirname, 'fixtures/interruptedEdit.js'), root, storage, scenario], { env, windowsHide: true, stdio: ['ignore','ignore','pipe','ipc'] });
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    try {
      const checkpoint = await new Promise<{ id: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker did not reach checkpoint.')), 25000);
        worker.once('message', (message: any) => { clearTimeout(timer); message.checkpoint === scenario ? resolve(message) : reject(new Error(message.error)); });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
        worker.once('exit', () => { clearTimeout(timer); reject(new Error('Worker exited before checkpoint.')); });
      });
      worker.kill('SIGKILL'); await exited; // No JS finally blocks or graceful cancellation.
      const beforeReload = await fs.readdir(root);
      const index = new RepositoryIndex(root, storage);
      const hooks = { mode: () => 'Full access', isDirty: () => false, confirm: async () => true, preview: async () => {} };
      const task = await EditTask.load(index, storage, checkpoint.id, hooks);
      assert.deepEqual(await fs.readdir(root), beforeReload, 'loading cannot replay or clean up mutations');
      assert.equal(task.changes().length, scenario === 'move-linked' || scenario === 'move-unlinked' ? 2 : 1);
      const applied = scenario === 'create-recorded';
      assert.ok(task.changes().every(change => change.state === (applied ? 'applied' : 'prepared')));
      if (!applied) {
        assert.match(task.summary(), /need inspection/);
        await assert.rejects(task.undo(new AbortController().signal), /Unconfirmed edits/);
      }
      await assert.rejects(task.execute({ version: 1, tool: 'create_file', args: { path: 'replayed.txt', content: 'never' } }, new AbortController().signal), /closed/);
      if (['delete-after','move-unlinked'].includes(scenario)) await assert.rejects(fs.stat(main));
      else assert.deepEqual(await fs.readFile(main), scenario === 'replace-after' || scenario === 'replace-again' ? encode(`function Get-Value { return ${scenario === 'replace-again' ? 3 : 2} }\n# developer comment\n`, format) : baseline);
      if (scenario === 'move-linked' || scenario === 'move-unlinked') assert.deepEqual(await fs.readFile(target), baseline);
      else if (scenario.startsWith('create')) assert.match(await fs.readFile(target, 'utf8'), /return 7/);
      else await assert.rejects(fs.stat(target));
      if (scenario === 'move-linked') {
        assert.equal((await fs.stat(main)).ino, (await fs.stat(target)).ino);
        assert.equal((await fs.stat(main)).nlink, 2);
      }
      const temporaries = beforeReload.filter(file => file.startsWith('.codeeko-'));
      if (scenario === 'partial-write') assert.equal((await fs.stat(path.join(root, temporaries[0]))).size, 16);
      if (scenario === 'create-linked') assert.equal((await fs.stat(target)).nlink, 2);
      if (applied) {
        assert.equal(temporaries.length, 0); assert.equal((await fs.stat(target)).nlink, 1);
        await task.undo(new AbortController().signal); await assert.rejects(fs.stat(target));
      }
      for (const change of task.changes()) {
        if (change.before) {
          assert.equal(await task.snapshot(change.before), 'function Get-Value { return 1 }\n# developer comment\n');
          assert.deepEqual(await fs.readFile(path.join(task.directory, 'blobs', change.before)), baseline);
        }
        if (change.after) assert.ok((await task.snapshot(change.after)).includes('function'));
      }
      await index.refresh();
      for (const file of temporaries) {
        assert.equal(index.entries.has(file), false);
        await assert.rejects(index.readDocument(file), /outside/);
      }
      assert.equal(await git(root, ['diff','--cached','--no-ext-diff','--no-textconv']), staged);
      assert.equal(await git(root, ['rev-parse','HEAD']), head);
      assert.equal(await fs.readFile(path.join(root, 'Notes.txt'), 'utf8'), 'staged developer work\n');
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
      await exited; await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
