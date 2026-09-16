import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { latestRejectedLog } from '../src/state/rejectedLogs';

test('capture locator finds the newest log and ignores unrelated files and linked directories', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeeko-log-location-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = path.join(root, 'storage');
  assert.equal(await latestRejectedLog(storage), undefined);
  const task = '12345678-1234-1234-1234-123456789abc';
  const first = path.join(storage, 'a'.repeat(64), 'tasks', task, 'rejected-responses.jsonl');
  const second = path.join(storage, 'b'.repeat(64), 'tasks', task, 'rejected-responses.jsonl');
  for (const file of [first, second]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'not parsed'); }
  await fs.utimes(first, 1, 1); await fs.utimes(second, 2, 2);
  assert.equal(await latestRejectedLog(storage), second);
  await fs.writeFile(path.join(storage, 'rejected-responses.jsonl'), 'unrelated');
  const outside = path.join(root, 'outside'); await fs.mkdir(path.join(outside, task), { recursive: true });
  await fs.writeFile(path.join(outside, task, 'rejected-responses.jsonl'), 'linked capture');
  const third = path.join(storage, 'c'.repeat(64)); await fs.mkdir(third);
  await fs.symlink(outside, path.join(third, 'tasks'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await latestRejectedLog(storage), second);
});
