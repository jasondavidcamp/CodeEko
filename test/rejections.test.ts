import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { rejectionRecorder, replayRejections } from '../src/agent/rejections';
import { runAgent } from '../src/agent/loop';

test('diagnostics redact before truncation, cap records and replay schema without executing actions', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-rejections-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const secret = 'synthetic-key-do-not-store';
  const record = rejectionRecorder(directory, 'test-version', 'mock', () => 'Full access', text => text.replaceAll(secret, '[REDACTED]'));
  await record({ raw: ' '.repeat(19990) + secret, hint: secret, attempt: 1, requestKind: 'task' });
  await record({ raw: '{"version":1,"tool":"delete_file","args":{"path":"victim.ps1","expectedHash":"' + '0'.repeat(64) + '"}}', hint: 'Replay only', attempt: 2, requestKind: 'format-repair' });
  await record({ raw: '{bad json' + 'x'.repeat(25000), hint: 'JSON invalid', attempt: 3, requestKind: 'format-repair' });
  await record({ raw: 'must not be stored', hint: '', attempt: 3, requestKind: 'task' });
  const file = path.join(directory, 'rejected-responses.jsonl');
  const content = await fs.readFile(file, 'utf8');
  assert.ok(!content.includes(secret)); assert.ok(!content.includes('synthetic')); assert.ok(!content.includes('must not be stored'));
  assert.equal(content.trim().split('\n').length, 3);
  await fs.writeFile(path.join(directory, 'victim.ps1'), 'preserve');
  const result = await replayRejections(file);
  assert.equal(result[0].truncated, false); // redacted placeholder fits the bound
  assert.equal(result[1].schemaValid, true); assert.equal(result[1].tool, 'delete_file');
  assert.equal(result[2].truncated, true);
  assert.ok(result.every(item => item.executed === false));
  assert.equal(await fs.readFile(path.join(directory, 'victim.ps1'), 'utf8'), 'preserve');
});

test('all rejected attempts are captured and a diagnostic write failure does not prevent recovery', async () => {
  const kinds: string[] = []; let attempts = 0;
  await assert.rejects(runAgent({ complete: async () => '{bad' }, 'mock', [], { execute: async () => { throw new Error('Must not execute'); } }, () => 'Review', new AbortController().signal, () => {}, async record => { kinds.push(record.requestKind); attempts = record.attempt; }), /unusable response/);
  assert.deepEqual(kinds, ['task', 'format-repair', 'format-repair']); assert.equal(attempts, 3);
  let calls = 0; const progress: string[] = [];
  const result = await runAgent({ complete: async () => ++calls === 1 ? '{bad' : '{"version":1,"tool":"complete_task","args":{"summary":"Recovered"}}' }, 'mock', [], { execute: async () => ({}) }, () => 'Review', new AbortController().signal, text => progress.push(text), async () => { throw new Error('private storage error'); });
  assert.equal(result, 'Recovered'); assert.ok(progress.some(text => text.includes('Could not save'))); assert.ok(!progress.join('').includes('private storage error'));
});

test('rejected response capture is opt-in and cannot be enabled by repository settings', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '../../package.json'), 'utf8'));
  const setting = manifest.contributes.configuration.properties['codeeko.debugRejectedResponses'];
  assert.equal(setting.default, false); assert.equal(setting.scope, 'application');
});
