import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { git } from '../../src/repository/git';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

async function main(): Promise<void> {
  const uiOnly = process.argv.includes('--ui-only');
  const launches = process.argv.includes('--repeat-startup') ? 6 : 1;
  const executable = process.env.EKOD_VSCODE_EXECUTABLE ?? await downloadAndUnzipVSCode({
    version: process.env.EKOD_VSCODE_VERSION ?? 'stable',
    cachePath: path.join(os.tmpdir(), 'ekod-vscode-cache')
  });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ekod-host-'));
  const workspace = path.join(temp, 'workspace'); const userData = path.join(temp, 'profile');
  const project = path.resolve(__dirname, '../../..');
  await fs.mkdir(workspace); await git(workspace, ['init']);
  await fs.writeFile(path.join(workspace, 'Example.ps1'), 'function Get-Example { 42 }\n');
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  await fs.writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'update.mode': 'none' }));
  const report = path.join(temp, 'result.json');
  const env = { ...process.env, EKOD_HOST_REPORT: report, EKOD_HOST_UI_ONLY: uiOnly ? '1' : '0' }; delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  try {
    for (let launch = 1; launch <= launches; launch++) {
      await fs.rm(report, { force: true });
      console.log(`STARTUP LAUNCH ${launch}/${launches} using the same isolated profile`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, [
          `--extensionDevelopmentPath=${project}`, `--extensionTestsPath=${path.join(__dirname, 'extensionHost.js')}`,
          `--user-data-dir=${userData}`, `--extensions-dir=${path.join(temp, 'extensions')}`,
          '--disable-extensions', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--log', 'error', '--new-window', workspace
        ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const timeout = setTimeout(() => {
          if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          else child.kill();
          reject(new Error('VS Code extension tests exceeded the five-minute limit.'));
        }, 300000);
        child.stdout.on('data', data => process.stdout.write(data)); child.stderr.on('data', data => process.stderr.write(data));
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`VS Code extension tests exited with code ${code}.`)); });
      });
      const result = JSON.parse(await fs.readFile(report, 'utf8'));
      if (!result.sidebarInitializedAndRefocused || !result.extensionActivation || !result.dirtyBufferPreserved) throw new Error('Extension host did not report completed UI checks.');
      if (!uiOnly && (!result.live?.repositoryUnchanged || !result.editing?.preexistingWorkPreserved || !result.editing?.undoRestoredBaseline || !result.nativeDiffsOpened || !result.validation?.repaired || !result.validation?.readCorrection)) throw new Error('Extension host did not report completed live checks.');
      console.log('VERIFIED EXTENSION HOST RESULT: ' + JSON.stringify(result, null, 2));
    }
  } finally {
    // Remove only the isolated profile and workspace created by this invocation.
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Extension host test failed.'); process.exitCode = 1; });
