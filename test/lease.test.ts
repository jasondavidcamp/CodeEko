import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { acquireRepositoryLease } from '../src/state/lease';

test('lease retries a closing owner without admitting concurrent owners', async t => {
  const root = randomUUID();
  const owner = await acquireRepositoryLease(root);
  t.after(owner);
  let retries = 0;
  const next = acquireRepositoryLease(root, { onRetry: () => { retries++; if (retries === 2) void owner(); } });
  const release = await next;
  t.after(release);
  assert.ok(retries >= 2);
  await assert.rejects(acquireRepositoryLease(root, { timeoutMs: 150 }), error =>
    ['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''));
  await Promise.all([release(), release()]);
  await (await acquireRepositoryLease(root))();
});

test('cancelled acquisition never takes the lease from its owner or leaks a listener', async t => {
  const root = randomUUID();
  const owner = await acquireRepositoryLease(root);
  t.after(owner);
  const controller = new AbortController();
  await assert.rejects(acquireRepositoryLease(root, {
    signal: controller.signal, onRetry: () => controller.abort()
  }), { name: 'AbortError' });
  await assert.rejects(acquireRepositoryLease(root, { timeoutMs: 0 }));
  await owner();
  await assert.rejects(acquireRepositoryLease(root, { signal: controller.signal }), { name: 'AbortError' });
  await (await acquireRepositoryLease(root))();
});

test('a reload waits for a separate Windows host to terminate', { skip: process.platform !== 'win32' }, async t => {
  const root = randomUUID();
  const child = fork(require.resolve('./fixtures/leaseOwner'), [root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { child.kill(); });
  await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => { throw new Error('Lease owner exited before becoming ready'); })
  ]);
  let retries = 0;
  const release = await acquireRepositoryLease(root, { onRetry: () => { if (++retries === 2) child.kill(); } });
  t.after(release);
  assert.ok(retries >= 2);
  await assert.rejects(acquireRepositoryLease(root, { timeoutMs: 0 }));
});
