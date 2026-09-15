import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { git } from '../../src/repository/git';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

async function main(): Promise<void> {
  const executable = process.env.LLM_RUNTIME_VSCODE_EXECUTABLE ?? await downloadAndUnzipVSCode({
    version: process.env.LLM_RUNTIME_VSCODE_VERSION ?? 'stable',
    cachePath: path.join(os.tmpdir(), 'llm-runtime-vscode-cache')
  });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-runtime-host-'));
  const workspace = path.join(temp, 'workspace'); const userData = path.join(temp, 'profile');
  const project = path.resolve(__dirname, '../../..');
  await fs.mkdir(workspace); await git(workspace, ['init']);
  await fs.writeFile(path.join(workspace, 'Example.ps1'), 'function Get-Example { 42 }\n');
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  await fs.writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'update.mode': 'none' }));
  const report = path.join(temp, 'result.json');
  const env = { ...process.env, LLM_RUNTIME_HOST_REPORT: report }; delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  try {
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
    if (!result.extensionActivation || !result.dirtyBufferPreserved || !result.live?.repositoryUnchanged || !result.editing?.preexistingWorkPreserved || !result.editing?.undoRestoredBaseline || !result.nativeDiffsOpened || !result.validation?.repaired || !result.validation?.readCorrection) throw new Error('Extension host did not report completed checks.');
    console.log('VERIFIED EXTENSION HOST RESULT: ' + JSON.stringify(result, null, 2));
  } finally {
    // Remove only the isolated profile and workspace created by this invocation.
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Extension host test failed.'); process.exitCode = 1; });
