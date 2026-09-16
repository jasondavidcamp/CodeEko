import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

test('source installer handles paths, build-only and failed native commands on PowerShell 5.1', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeeko install '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts'), bin = path.join(root, 'bin'), log = path.join(root, 'calls.txt');
  await fs.mkdir(scripts); await fs.mkdir(bin);
  const script = path.join(scripts, 'Install-CodeEko.ps1');
  await fs.copyFile(path.join(__dirname, '../../scripts/Install-CodeEko.ps1'), script);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ publisher: 'test-publisher', name: 'codeeko', version: '1.2.3' }));
  await fs.writeFile(path.join(bin, 'npm.cmd'), '@echo off\r\necho npm %*>>"%CODEEKO_INSTALL_TEST_LOG%"\r\nif "%CODEEKO_INSTALL_TEST_FAIL%"=="%1" exit /b 7\r\nif "%1"=="run" echo fixture>"%~dp0..\\codeeko.vsix"\r\nexit /b 0\r\n');
  await fs.writeFile(path.join(bin, 'code.cmd'), '@echo off\r\necho code %*>>"%CODEEKO_INSTALL_TEST_LOG%"\r\nif "%CODEEKO_INSTALL_TEST_FAIL%"=="%1" exit /b 9\r\nif "%1"=="--list-extensions" echo test-publisher.codeeko@1.2.3\r\nexit /b 0\r\n');
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  async function run(extra: string[], fail = '') {
    await fs.writeFile(log, '');
    const result = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', script, ...extra], {
      cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true,
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, PSModulePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules'), CODEEKO_INSTALL_TEST_LOG: log, CODEEKO_INSTALL_TEST_FAIL: fail }
    });
    return { ...result, calls: await fs.readFile(log, 'utf8') };
  }
  const built = await run(['-BuildOnly']);
  assert.equal(built.status, 0, built.stderr); assert.match(built.calls, /npm ci --include=dev --no-audit --no-fund --registry=https:\/\/registry\.npmjs\.org\//); assert.match(built.calls, /npm run package/); assert.doesNotMatch(built.calls, /code /);
  const installed = await run(['-RunTests', '-CodeCommand', path.join(bin, 'code.cmd')]);
  assert.equal(installed.status, 0, installed.stderr); assert.match(installed.calls, /npm test/); assert.match(installed.calls, /code --install-extension/); assert.match(installed.stdout, /Installed test-publisher.codeeko@1.2.3/);
  for (const failure of ['ci', 'run', '--install-extension']) {
    const result = await run(['-CodeCommand', path.join(bin, 'code.cmd')], failure);
    assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout, /Installed test-publisher/);
    if (failure === 'ci') assert.doesNotMatch(result.calls, /npm run package/);
    if (failure === 'run') assert.doesNotMatch(result.calls, /code --install-extension/);
    if (failure === '--install-extension') assert.doesNotMatch(result.calls, /--list-extensions/);
  }
});
