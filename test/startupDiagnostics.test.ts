import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { StartupDiagnostics, startupError } from '../src/state/startupDiagnostics';

async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-startup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}
test('startup evidence survives subsequent launches and excludes arbitrary errors and fields', async t => {
  const directory = await fixture(t); const first = new StartupDiagnostics(directory); const view = randomUUID();
  first.log('activate', { extensionVersion: '0.1.0' });
  await assert.rejects(first.stage('lease.acquire', view, async () => { throw new Error('This repository is already open in another panel: private-source-secret'); }));
  first.log('focus.failed', { code: startupError(new Error('private-source-secret')), path: 'private-source-secret', source: 'private-source-secret' } as any);
  await first.flush();
  const second = new StartupDiagnostics(directory); second.log('activate'); second.log('ready', { view }); await second.flush();
  const report = JSON.stringify(await second.export());
  assert.ok(report.includes(first.session)); assert.ok(report.includes(second.session));
  assert.match(report, /lease-unavailable/); assert.ok(!report.includes('private-source-secret'));
  assert.ok(!report.includes(directory));
});
test('startup retention and per-launch event counts are bounded', async t => {
  const directory = await fixture(t);
  let last!: StartupDiagnostics;
  for (let i = 0; i < 23; i++) { last = new StartupDiagnostics(directory); last.log('activate'); await last.flush(); }
  for (let i = 0; i < 300; i++) last.log('ready');
  await last.flush();
  assert.equal((await fs.readdir(last.directory)).length, 20);
  const report = await last.export(); assert.ok(report.launches.every(launch => launch.length <= 200));
});
test('export reads relevant VS Code signatures without copying log text or paths', async t => {
  const directory = await fixture(t), session = path.join(directory, 'logs', '20260915T120000');
  const logUri = path.join(session, 'window1', 'exthost', 'internal-pilot.llm-coding-agent-runtime');
  await fs.mkdir(logUri, { recursive: true });
  await fs.writeFile(path.join(session, 'window1', 'renderer.log'), '2026-09-15 12:00:01.000 [error] Could not register service worker private-secret endpoint.example\n');
  await fs.writeFile(path.join(session, 'window1', 'exthost', 'exthost.log'), "2026-09-15 12:00:02.000 _doActivateExtension internal-pilot.llm-coding-agent-runtime activationEvent: 'onView:llmRuntime.conversation' private-secret\n");
  const diagnostics = new StartupDiagnostics(path.join(directory, 'storage')); diagnostics.log('activate');
  const report = await diagnostics.export(logUri);
  assert.equal(report.host.entries.length, 2); assert.ok(report.host.available);
  const text = JSON.stringify(report); assert.match(text, /service-worker/); assert.match(text, /activate-on-view/);
  assert.ok(!text.includes('private-secret')); assert.ok(!text.includes('endpoint.example')); assert.ok(!text.includes(directory));
});
