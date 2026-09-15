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
  await git(root, ['add','.']); await git(root, ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
  const commands = new Map<string, () => Promise<void>>();
  const settings: Record<string, unknown> = { endpoint: 'https://api.example.test', model: 'saved-model', requestTimeout: 1000, permissionMode: 'Full access' };
  const secrets = new Map<string, string>(); const sent: any[] = []; const errors: string[] = [];
  let receive: (message: any) => Promise<void> = async () => {};
  const disposeListeners: (() => void)[] = []; let input = 'test-key'; let fallbackPrompt: any;
  const disposable = { dispose() {} };
  let viewProvider: any; let viewResolved = false;
  let provider: any; let approveUndo = false; const nativeDiffs: { before: string; after: string }[] = [];
  const panel = { webview: { html: '', postMessage: (message: any) => { sent.push(structuredClone(message)); return Promise.resolve(true); }, onDidReceiveMessage: (fn: typeof receive) => { receive = fn; return disposable; } }, onDidDispose: (fn: () => void) => { disposeListeners.push(fn); return disposable; }, dispose: () => disposeListeners.forEach(fn => fn()) };
  const mock = {
    commands: { registerCommand: (name: string, fn: () => Promise<void>) => { commands.set(name, fn); return disposable; }, executeCommand: async (name: string, ...args: any[]) => { if (name === 'llmRuntime.conversation.focus' && !viewResolved) { viewResolved = true; await viewProvider.resolveWebviewView(panel); } if (name === 'vscode.diff') nativeDiffs.push({ before: provider.provideTextDocumentContent(args[0]), after: provider.provideTextDocumentContent(args[1]) }); } },
    workspace: { isTrusted: true, textDocuments: [], registerTextDocumentContentProvider: (_scheme: string, value: unknown) => { provider = value; return disposable; }, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], getConfiguration: () => ({ get: (name: string, fallback: unknown) => settings[name] ?? fallback, update: async (name: string, value: unknown) => { settings[name] = value; } }), onDidChangeConfiguration: () => disposable, createFileSystemWatcher: () => ({ onDidCreate: () => disposable, onDidChange: () => disposable, onDidDelete: () => disposable, dispose() {} }) },
    window: { showErrorMessage: (text: string) => { errors.push(text); }, showInformationMessage() {}, showInputBox: async (options: any) => { if (options.title === 'Model discovery unavailable') fallbackPrompt = options; return input; }, showQuickPick: async (items: string[]) => approveUndo && items.includes('Approve this operation') ? 'Approve this operation' : items[0], registerWebviewViewProvider: (id: string, value: any, options: any) => { assert.equal(id, 'llmRuntime.conversation'); assert.equal(options.webviewOptions.retainContextWhenHidden, true); viewProvider = value; return disposable; } },
    ViewColumn: { Beside: 2 }, ConfigurationTarget: { Global: 1 }, RelativePattern: class {},
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    CancellationTokenSource: class { token = {}; cancel() {} dispose() {} }
  };
  const Module = require('node:module') as { _load: (...args: any[]) => any };
  const originalLoad = Module._load;
  Module._load = function(request: string, ...args: any[]) { return request === 'vscode' ? mock : originalLoad.call(this, request, ...args); };
  let extension: typeof import('../src/ui/extension');
  try { extension = require('../src/ui/extension'); } finally { Module._load = originalLoad; }
  const context = { subscriptions: [], globalStorageUri: { fsPath: storage }, secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); } } };
  extension.activate(context as any);
  const originalFetch = global.fetch; t.after(() => { global.fetch = originalFetch; panel.dispose(); extension.deactivate(); });
  await commands.get('llmRuntime.setKey')!(); assert.equal(secrets.size, 1); assert.ok(!JSON.stringify(settings).includes('test-key'));
  global.fetch = async () => new Response('failure', { status: 503 }); input = 'manual-model';
  await commands.get('llmRuntime.selectModel')!(); assert.equal(fallbackPrompt.value, 'saved-model'); assert.equal(settings.model, 'manual-model');
  await commands.get('llmRuntime.open')!(); assert.equal(errors.length, 0);
  const originalHtml = panel.webview.html; await commands.get('llmRuntime.open')!(); assert.equal(panel.webview.html, originalHtml, 'Refocusing the sidebar must reuse its repository session.');
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
  let step = 0;
  let afterEdit!: () => void; const editDone = new Promise<void>(resolve => { afterEdit = resolve; });
  global.fetch = async (_url, init) => {
    step++;
    if (step === 3) return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); afterEdit(); });
    const messages = JSON.parse(init?.body as string).messages;
    const action = step === 1 ? { version: 1, tool: 'read_file', args: { path: 'pilot.ps1' } } : { version: 1, tool: 'apply_patch', args: { path: 'pilot.ps1', expectedHash: JSON.parse(messages.at(-1).content).result.hash, edits: [{ oldText: 'Get-Pilot', newText: 'Get-UpdatedPilot' }] } };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(action) } }] }));
  };
  const editRun = receive({ type: 'send', text: 'Rename the function to Get-UpdatedPilot' }); await editDone;
  await receive({ type: 'cancel' }); await editRun;
  assert.equal(sent.at(-1).thread.status, 'cancelled');
  assert.match(sent.at(-1).thread.messages.at(-1).content, /1 file change/);
  assert.ok(!sent.at(-1).thread.messages.at(-1).content.includes('No repository files were changed'));
  assert.equal(await fs.readFile(path.join(root, 'pilot.ps1'), 'utf8'), 'function Get-UpdatedPilot {}');
  assert.deepEqual(nativeDiffs.at(-1), { before: 'function Get-Pilot {}', after: 'function Get-UpdatedPilot {}' });
  const reviewId = sent.at(-1).thread.reviewTaskId; assert.ok(reviewId);
  await receive({ type: 'review' }); assert.equal(nativeDiffs.length, 2);
  assert.equal(sent.at(-1).thread.undoTaskId, reviewId);
  approveUndo = true; await receive({ type: 'undo' });
  assert.equal(await fs.readFile(path.join(root, 'pilot.ps1'), 'utf8'), 'function Get-Pilot {}');
  assert.equal(sent.at(-1).thread.undoTaskId, undefined); assert.match(sent.at(-1).thread.messages.at(-1).content, /Undo complete/);
  await receive({ type: 'permissions' }); assert.equal(settings.permissionMode, 'Review');
  const firstId = sent.at(-1).thread.id;
  global.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"version":1,"tool":"complete_task","args":{"summary":"New chat response"}}' } }] }));
  await receive({ type: 'send', text: 'Second topic', newConversation: true });
  assert.notEqual(sent.at(-1).thread.id, firstId); assert.equal(sent.at(-1).thread.name, 'Second topic');
  assert.equal(sent.at(-1).threads.length, 2); assert.equal(sent.at(-1).thread.messages.filter((m: any) => m.role === 'user').length, 1);
  await receive({ type: 'rename', id: sent.at(-1).thread.id, name: 'Renamed topic' }); assert.equal(sent.at(-1).thread.name, 'Renamed topic');
  await receive({ type: 'archive' }); assert.equal(sent.at(-1).thread.archived, true);
  const archivedStore = new ThreadStore(repositoryStorage(storage, await fs.realpath(root))); await archivedStore.load();
  assert.equal(archivedStore.threads.at(-1)?.archived, true); assert.equal(archivedStore.threads.at(-1)?.name, 'Renamed topic');
  assert.equal(archivedStore.threads.at(-1)?.messages.length, 2);
  await receive({ type: 'restore' }); assert.equal(sent.at(-1).thread.archived, false);
  const persisted = new ThreadStore(repositoryStorage(storage, await fs.realpath(root))); await persisted.load(); assert.equal(persisted.threads.length, 2);
  const text = await fs.readFile(path.join(repositoryStorage(storage, await fs.realpath(root)), 'threads.json'), 'utf8'); assert.ok(!text.includes('test-key'));
  panel.dispose(); await new Promise(resolve => setImmediate(resolve));
});
