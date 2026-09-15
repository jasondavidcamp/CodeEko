import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { git } from '../../src/repository/git';

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, error => { if (error) child.kill(); resolve(); }));
}
async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('This recovery test requires Windows.');
  const executable = process.env.EKOD_VSCODE_EXECUTABLE ?? await downloadAndUnzipVSCode({ version: process.env.EKOD_VSCODE_VERSION ?? 'stable', cachePath: path.join(os.tmpdir(), 'ekod-vscode-cache') });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ekod-recovery-'));
  const workspace = path.join(temp, 'workspace'); const profile = path.join(temp, 'profile'); const marker = path.join(temp, 'ready.json'); const report = path.join(temp, 'report.json');
  const childMarker = path.join(temp, 'validator.pid');
  const project = path.resolve(__dirname, '../../..');
  await fs.mkdir(workspace); await git(workspace, ['init']);
  await fs.writeFile(path.join(workspace, 'main.ps1'), 'function Get-Value { return 1 }\n');
  await fs.mkdir(path.join(workspace, 'tests'));
  const sleeper = Buffer.from('Start-Sleep -Seconds 120', 'utf16le').toString('base64');
  await fs.writeFile(path.join(workspace, 'tests/Slow.Tests.ps1'), `Describe 'controlled interruption' { It 'waits for the launcher' {
    $child = Start-Process -FilePath "$PSHOME/powershell.exe" -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${sleeper}' -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText('${childMarker.replaceAll("'", "''")}', (@{ validatorPid = $PID; descendantPid = $child.Id } | ConvertTo-Json -Compress))
    Start-Sleep -Seconds 60; 1 | Should -Be 1
  } }`);
  await git(workspace, ['add','.']); await git(workspace, ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
  await fs.appendFile(path.join(workspace, 'main.ps1'), '# developer note\n');
  await fs.writeFile(path.join(workspace, 'Notes.txt'), 'staged developer work\n'); await git(workspace, ['add','Notes.txt']);
  await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'update.mode': 'none' }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|ELECTRON_RUN_AS_NODE/i.test(name)) delete env[name];
  Object.assign(env, { EKOD_RECOVERY_STORAGE: path.join(profile, 'User/globalStorage/jasondavidcamp.ekod'), EKOD_RECOVERY_MARKER: marker, EKOD_RECOVERY_REPORT: report, EKOD_RECOVERY_CHILD: childMarker });
  let hostCrashCleanupVerified = false;
  const launch = async (phase: 'seed' | 'verify') => {
    const child = spawn(executable, [`--extensionDevelopmentPath=${project}`, `--extensionTestsPath=${path.join(__dirname, 'recoveryHost.js')}`, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(temp, 'extensions')}`, '--disable-extensions','--disable-updates','--skip-welcome','--skip-release-notes','--log','error','--new-window', workspace], { env: { ...env, EKOD_RECOVERY_PHASE: phase }, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    child.stdout?.on('data', data => process.stdout.write(data)); child.stderr?.on('data', data => process.stderr.write(data));
    let launchError: Error | undefined;
    const exited = new Promise<number | null>(resolve => { child.once('error', error => { launchError = error; resolve(null); }); child.once('exit', code => resolve(code)); });
    const timer = setTimeout(() => { launchError = new Error('Recovery host exceeded its two-minute limit.'); void terminate(child); }, 120000);
    try {
      if (phase === 'seed') {
        const deadline = Date.now() + 60000;
        while (!await fs.stat(marker).then(() => true, () => false)) {
          if (launchError || child.exitCode !== null || Date.now() > deadline) throw new Error('Seed host did not reach its interruption checkpoint.');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const checkpoint = JSON.parse(await fs.readFile(marker, 'utf8'));
        console.log('Recovery checkpoint reached; terminating the extension host alone (no tree kill).');
        // process.kill on Windows terminates this PID only. The UI remains alive
        // while production lifetime enforcement must stop both owned processes.
        process.kill(checkpoint.hostPid);
        const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
        const stoppedBy = Date.now() + 10000;
        while ([checkpoint.validatorPid, checkpoint.descendantPid].some(alive) && Date.now() < stoppedBy) await new Promise(resolve => setTimeout(resolve, 50));
        if ([checkpoint.validatorPid, checkpoint.descendantPid].some(alive)) throw new Error('Validation or its descendant survived extension-host-only termination.');
        hostCrashCleanupVerified = true;
        console.log('Host-crash cleanup verified for validator and descendant before closing the isolated UI.');
        await terminate(child); await exited;
      } else {
        const code = await exited; if (launchError) throw launchError; if (code !== 0) throw new Error(`Recovery verification exited with ${code}.`);
      }
    } finally { clearTimeout(timer); await terminate(child); }
  };
  try {
    await launch('seed'); await launch('verify');
    const result = JSON.parse(await fs.readFile(report, 'utf8'));
    if (!result.undoAfterRestart || !result.noAutomaticReplay || !result.threadsRecovered || !result.validationInterrupted || !hostCrashCleanupVerified) throw new Error('Recovery report is incomplete.');
    console.log('VERIFIED RESTART RECOVERY: ' + JSON.stringify({ ...result, hostCrashCleanupVerified }));
  } finally { await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Recovery test failed.'); process.exitCode = 1; });
