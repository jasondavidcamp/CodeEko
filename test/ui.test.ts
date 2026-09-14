import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vm from 'node:vm';
import { git } from '../src/repository/git';
import { ThreadStore, repositoryStorage } from '../src/state/threads';

test('extension commands, secure webview, discovery fallback, busy guard, cancellation and thread lifecycle', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-ui-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); const storage = path.join(temp, 'storage'); await fs.mkdir(root); await git(root, ['init']);
  await fs.writeFile(path.join(root, 'pilot.ps1'), 'function Get-Pilot {}');
  const commands = new Map<string, () => Promise<void>>();
  const settings: Record<string, unknown> = { endpoint: 'https://api.example.test', model: 'saved-model', requestTimeout: 1000, permissionMode: 'Full access' };
  const secrets = new Map<string, string>(); const sent: any[] = []; const errors: string[] = [];
  let receive: (message: any) => Promise<void> = async () => {};
  let disposePanel = () => {}; let input = 'test-key'; let fallbackPrompt: any;
  const disposable = { dispose() {} };
  const panel = { webview: { html: '', postMessage: (message: any) => { sent.push(structuredClone(message)); return Promise.resolve(true); }, onDidReceiveMessage: (fn: typeof receive) => { receive = fn; return disposable; } }, reveal() {}, onDidDispose: (fn: () => void) => { disposePanel = fn; return disposable; }, dispose: () => disposePanel() };
  const mock = {
    commands: { registerCommand: (name: string, fn: () => Promise<void>) => { commands.set(name, fn); return disposable; } },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], getConfiguration: () => ({ get: (name: string, fallback: unknown) => settings[name] ?? fallback, update: async (name: string, value: unknown) => { settings[name] = value; } }), onDidChangeConfiguration: () => disposable, createFileSystemWatcher: () => ({ onDidCreate: () => disposable, onDidChange: () => disposable, onDidDelete: () => disposable, dispose() {} }) },
    window: { showErrorMessage: (text: string) => { errors.push(text); }, showInformationMessage() {}, showInputBox: async (options: any) => { if (options.title === 'Model discovery unavailable') fallbackPrompt = options; return input; }, showQuickPick: async (items: string[]) => items[0], createWebviewPanel: () => panel },
    ViewColumn: { Beside: 2 }, ConfigurationTarget: { Global: 1 }, RelativePattern: class {},
    CancellationTokenSource: class { token = {}; cancel() {} dispose() {} }
  };
  const Module = require('node:module') as { _load: (...args: any[]) => any };
  const originalLoad = Module._load;
  Module._load = function(request: string, ...args: any[]) { return request === 'vscode' ? mock : originalLoad.call(this, request, ...args); };
  let extension: typeof import('../src/ui/extension');
  try { extension = require('../src/ui/extension'); } finally { Module._load = originalLoad; }
  const context = { subscriptions: [], globalStorageUri: { fsPath: storage }, secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); } } };
  extension.activate(context as any);
  const originalFetch = global.fetch; t.after(() => { global.fetch = originalFetch; extension.deactivate(); });
  await commands.get('llmRuntime.setKey')!(); assert.equal(secrets.size, 1); assert.ok(!JSON.stringify(settings).includes('test-key'));
  global.fetch = async () => new Response('failure', { status: 503 }); input = 'manual-model';
  await commands.get('llmRuntime.selectModel')!(); assert.equal(fallbackPrompt.value, 'saved-model'); assert.equal(settings.model, 'manual-model');
  await commands.get('llmRuntime.open')!(); assert.equal(errors.length, 0);
  assert.ok(panel.webview.html.includes("default-src 'none'")); assert.ok(panel.webview.html.includes('textContent'));
  const script = /<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(panel.webview.html)![1];
  assert.doesNotThrow(() => new vm.Script(script)); // Catches template-string/newline quoting regressions.
  await receive({ type: 'ready' });
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  global.fetch = async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); began(); });
  const running = receive({ type: 'send', text: 'Explain pilot.ps1' }); await started;
  await receive({ type: 'ready' }); assert.equal(sent.at(-1).busy, true);
  await receive({ type: 'send', text: 'Must not overlap' });
  await receive({ type: 'cancel' }); await running;
  assert.equal(sent.at(-1).thread.status, 'cancelled'); assert.equal(sent.at(-1).thread.messages.filter((m: any) => m.role === 'user').length, 1);
  global.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"version":1,"tool":"complete_task","args":{"summary":"See pilot.ps1:1"}}' } }] }));
  await receive({ type: 'send', text: 'Follow up' }); assert.equal(sent.at(-1).thread.status, 'complete');
  input = 'Second topic'; await receive({ type: 'new' }); assert.equal(sent.at(-1).threads.length, 2);
  const persisted = new ThreadStore(repositoryStorage(storage, await fs.realpath(root))); await persisted.load(); assert.equal(persisted.threads.length, 2);
  const text = await fs.readFile(path.join(repositoryStorage(storage, await fs.realpath(root)), 'threads.json'), 'utf8'); assert.ok(!text.includes('test-key'));
  panel.dispose(); await new Promise(resolve => setImmediate(resolve));
});
