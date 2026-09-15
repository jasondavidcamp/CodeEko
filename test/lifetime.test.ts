import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createPowerShellRunner } from '../src/validation/powershell';
import { lifetimeBootstrap } from '../src/validation/lifetime';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = () => new Promise(resolve => setTimeout(resolve, 50));

test('native guard enforces its own deadline, rejects lost owners and fails closed under language restrictions', { skip: process.platform !== 'win32' }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-guard-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  for (const mode of ['deadline', 'owner gone', 'restricted']) await t.test(mode, async () => {
    const marker = path.join(temp, mode);
    const script = "$ErrorActionPreference = 'Stop'\n" +
      (mode === 'restricted' ? "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n" : '') + lifetimeBootstrap +
      `\n$null = [ValidationLifetime]::Start(1000)\n` +
      (mode === 'deadline' ? `[IO.File]::WriteAllText('${(marker + '.ready').replaceAll("'", "''")}', 'guard started')\nStart-Sleep -Seconds 30\n` : '') +
      `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'must not reach')`;
    const child = spawn(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe','ignore','ignore'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
    child.stdin.on('error', () => {});
    const closed = new Promise(resolve => child.once('close', resolve));
    if (mode === 'owner gone') child.stdin.end(); else child.stdin.write('{}\n');
    try {
      const code = await closed;
      assert.equal(timedOut, false, 'the native guard must exit without a Node timeout');
      assert.notEqual(code, 0); await assert.rejects(fs.stat(marker));
      if (mode === 'deadline') assert.equal(await fs.readFile(marker + '.ready', 'utf8'), 'guard started');
    } finally { clearTimeout(timer); child.kill(); }
  });
});

test('Windows validation owns descendant lifetime on completion, cancellation and validator death', { skip: process.platform !== 'win32' }, async t => {
  const run = createPowerShellRunner('RemoteSigned');
  const installed = await run('inspect', {}, new AbortController().signal) as any;
  if (!installed.modules.Pester) { t.skip('Supported Pester is required for native process-lifetime fixtures.'); return; }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-lifetime-'));
  // A separately launched sibling must survive every owned-job cleanup.
  const executable = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const sleeper = Buffer.from('Start-Sleep -Seconds 120', 'utf16le').toString('base64');
  const sibling = spawn(executable, ['-NoProfile','-NonInteractive','-EncodedCommand',sleeper], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => { sibling.kill(); await fs.rm(temp, { recursive: true, force: true }); });
  for (const mode of ['completion', 'cancellation', 'validator death']) await t.test(mode, async () => {
    const marker = path.join(temp, mode + '.json'); const file = path.join(temp, mode + '.Tests.ps1');
    await fs.writeFile(file, `Describe 'owned lifetime' { It 'launches a synthetic sleeper' {
      $child = Start-Process -FilePath "$PSHOME/powershell.exe" -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${sleeper}' -WindowStyle Hidden -PassThru
      [IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', (@{ validator = $PID; descendant = $child.Id } | ConvertTo-Json -Compress))
      ${mode === 'completion' ? '' : 'Start-Sleep -Seconds 60'}
      1 | Should -Be 1
    } }`);
    const abort = new AbortController();
    const result = run('pester', { version: installed.modules.Pester, paths: [file] }, abort.signal);
    void result.catch(() => {});
    let pids: { validator: number; descendant: number } | undefined;
    try {
      const readyBy = Date.now() + 15000;
      while (!pids && Date.now() < readyBy) {
        try { pids = JSON.parse(await fs.readFile(marker, 'utf8')); } catch { await pause(); }
      }
      assert.ok(pids, 'validator must reach the descendant checkpoint');
      if (mode !== 'completion') assert.ok(alive(pids.validator) && alive(pids.descendant));
      if (mode === 'cancellation') abort.abort();
      if (mode === 'validator death') process.kill(pids.validator);
      if (mode === 'completion') assert.equal((await result as any).passed, 1);
      else await assert.rejects(result, mode === 'cancellation' ? /cancelled/ : /failed/);
      const stoppedBy = Date.now() + 5000;
      while ((alive(pids.validator) || alive(pids.descendant)) && Date.now() < stoppedBy) await pause();
      assert.equal(alive(pids.validator), false); assert.equal(alive(pids.descendant), false);
      assert.ok(sibling.pid && alive(sibling.pid), 'unrelated sibling must be preserved');
    } finally {
      abort.abort(); await result.catch(() => {});
      if (pids) for (const pid of [pids.validator, pids.descendant]) if (alive(pid)) process.kill(pid);
    }
  });
});
