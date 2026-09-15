import { SettingsPage } from './settings';
import { conversationHtml } from './conversation';
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { GeminiClient, apiBase } from '../api/client';
import { resolveRepository } from '../repository/git';
import { RepositoryIndex } from '../indexing';
import { ThreadStore, Thread, repositoryStorage, lastChatActivity } from '../state/threads';
import { ReadOnlyTools } from '../tools/readOnly';
import { runAgent } from '../agent/loop';
import { rejectionRecorder } from '../agent/rejections';
import { acquireRepositoryLease } from '../state/lease';
import { contained, TaskConflict } from '../policy/boundary';
import { EditTask, EditHooks } from '../state/editTask';
import { EditingTools, explicitCommitRequest } from '../tools/editing';
import { NativeReview } from './review';
import { TaskValidation } from '../validation/task';
import { createPowerShellRunner } from '../validation/powershell';
import * as path from 'node:path';
import { StartupDiagnostics, startupError } from '../state/startupDiagnostics';
const active = new Map<string, AbortController>();
let startupDiagnostics: StartupDiagnostics | undefined;
const config = () => vscode.workspace.getConfiguration('llmRuntime');
const mode = () => { const value = config().get<string>('permissionMode', 'Full access'); return value === 'Custom' ? 'Review' : value; };
function outcome(task?: EditTask, validation?: TaskValidation): string {
  if (!task?.changes().length && !validation?.hasRun()) return '';
  return '\n\n' + [task?.summary(), validation?.summary()].filter(Boolean).join('\n');
}
const keyName = (endpoint: string) => 'apiKey.' + createHash('sha256').update(apiBase(endpoint)).digest('hex');
async function client(context: vscode.ExtensionContext): Promise<GeminiClient> {
  const endpoint = config().get<string>('endpoint', '');
  if (!endpoint) throw new Error('Set llmRuntime.endpoint to your HTTPS API URL first.');
  const key = await context.secrets.get(keyName(endpoint));
  if (!key) throw new Error('Use LLM Runtime: Set API Key before connecting.');
  return new GeminiClient(endpoint, key, config().get<number>('requestTimeout', 60000));
}
async function selectModel(context: vscode.ExtensionContext, signal?: AbortSignal): Promise<void> {
  const token = new vscode.CancellationTokenSource(); const abort = () => token.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
  let chosen: string | undefined;
  try { signal?.throwIfAborted(); chosen = await vscode.window.showQuickPick(await (await client(context)).models(signal), { title: 'Select an endpoint model' }, token.token); }
  catch {
    signal?.throwIfAborted();
    chosen = await vscode.window.showInputBox({ title: 'Model discovery unavailable', prompt: 'Enter a model ID manually, or retain the configured fallback.', value: config().get<string>('model', '') }, token.token);
  }
  signal?.throwIfAborted();
  if (chosen?.trim()) await config().update('model', chosen.trim(), vscode.ConfigurationTarget.Global);
  } finally { signal?.removeEventListener('abort', abort); token.dispose(); }
}
export function activate(context: vscode.ExtensionContext): { isConversationVisible(): boolean } {
  const diagnostics = startupDiagnostics = new StartupDiagnostics(context.globalStorageUri.fsPath);
  diagnostics.log('activate', { extensionVersion: context.extension?.packageJSON?.version, vscodeVersion: vscode.version, pid: process.pid, trusted: vscode.workspace.isTrusted, folders: vscode.workspace.workspaceFolders?.length ?? 0 });
  const settingsPage = new SettingsPage(() => active.size > 0); context.subscriptions.push(settingsPage);
  context.subscriptions.push(vscode.commands.registerCommand('llmRuntime.openSettings', () => settingsPage.open()));
  const review = new NativeReview(); context.subscriptions.push(review);
  const command = (name: string, fn: () => Promise<unknown>) => context.subscriptions.push(vscode.commands.registerCommand(name, () => fn().catch(e => vscode.window.showErrorMessage(e instanceof Error ? e.message : 'Operation failed.'))));
  command('llmRuntime.setKey', async () => {
    const endpoint = config().get<string>('endpoint', '');
    if (!endpoint) throw new Error('Configure an HTTPS API endpoint first.');
    const name = keyName(endpoint);
    const key = await vscode.window.showInputBox({ title: 'API key for ' + new URL(endpoint).host, password: true, ignoreFocusOut: true });
    if (key?.trim()) { await context.secrets.store(name, key.trim()); vscode.window.showInformationMessage('API key stored securely for this endpoint.'); }
  });
  command('llmRuntime.selectModel', () => selectModel(context));
  command('llmRuntime.exportStartupDiagnostics', async () => {
    const report = await diagnostics.export(context.logUri?.fsPath);
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) });
    await vscode.window.showTextDocument(document, { preview: false });
    return report;
  });
  let initialization: Promise<void> | undefined;
  let sidebar: vscode.WebviewView | undefined;
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('llmRuntime.conversation', {
    resolveWebviewView: view => {
      const viewId = randomUUID(); diagnostics.log('resolve', { view: viewId, visible: view.visible });
      sidebar = view;
      context.subscriptions.push(view.onDidDispose(() => { diagnostics.log('dispose', { view: viewId }); initialization = undefined; }));
      if (view.onDidChangeVisibility) context.subscriptions.push(view.onDidChangeVisibility(() => diagnostics.log('visible', { view: viewId, visible: view.visible })));
      initialization = open(context, review, view, diagnostics, viewId).catch(error => {
        diagnostics.log('webview.error', { view: viewId, code: startupError(error) });
        const show = () => { void view.webview.postMessage({ type: 'progress', text: error instanceof Error ? error.message : 'Could not open the conversation.' }); };
        context.subscriptions.push(view.webview.onDidReceiveMessage(message => { if (message?.type === 'ready') { diagnostics.log('ready', { view: viewId }); show(); } }));
        diagnostics.log('html', { view: viewId });
        view.webview.options = { enableScripts: true, localResourceRoots: [] }; view.webview.html = conversationHtml(); show();
      });
      return initialization;
    }
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  command('llmRuntime.open', async () => {
    diagnostics.log('focus.begin', { source: 'command' });
    try { await vscode.commands.executeCommand('llmRuntime.conversation.focus'); diagnostics.log('focus.end', { source: 'command' }); }
    catch (error) { diagnostics.log('focus.failed', { source: 'command', code: startupError(error) }); throw error; }
    // View resolution crosses the workbench/extension-host boundary and can arrive
    // after the focus command has returned.
    const deadline = Date.now() + 10000;
    while (!initialization && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!initialization) { diagnostics.log('activation.timeout'); throw new Error('The conversation sidebar did not open. Try LLM Runtime: Open Conversation again.'); }
    await initialization;
    return true;
  });
  // Reveal once per window startup; subsequent user navigation stays untouched.
  // Ambiguous workspaces retain the explicit repository-selection flow.
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (vscode.workspace.isTrusted && folders.length === 1 && folders[0].uri.scheme === 'file') {
    diagnostics.log('focus.begin', { source: 'automatic' });
    void vscode.commands.executeCommand('llmRuntime.conversation.focus', { preserveFocus: true }).then(() => diagnostics.log('focus.end', { source: 'automatic' }), error => diagnostics.log('focus.failed', { source: 'automatic', code: startupError(error) }));
    const timer = setTimeout(() => { if (!initialization) diagnostics.log('activation.timeout'); }, 10000); timer.unref();
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
  return { isConversationVisible: () => sidebar?.visible === true };
}
async function open(context: vscode.ExtensionContext, review: NativeReview, panel: vscode.WebviewView, diagnostics: StartupDiagnostics, viewId: string): Promise<void> {
  let disposed = false;
  const earlyDispose = panel.onDidDispose(() => { disposed = true; });
  context.subscriptions.push(earlyDispose);
  if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before opening repository tools.');
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.some(f => f.uri.scheme !== 'file')) throw new Error('Only local filesystem workspaces are supported.');
  const root = await diagnostics.stage('repository', viewId, () => resolveRepository(folders.map(f => f.uri.fsPath), async choices => { panel.webview.options = { enableScripts: true, localResourceRoots: [] }; const selected = paneChoice(panel, 'Choose the repository for this conversation', choices); panel.webview.html = conversationHtml(); const index = await selected; return index === undefined ? undefined : choices[index]; }));
  const storage = repositoryStorage(context.globalStorageUri.fsPath, root);
  if (contained(root, storage)) throw new Error('Extension storage must be outside the repository. Open a narrower repository folder.');
  const releaseLease = await diagnostics.stage('lease.acquire', viewId, () => acquireRepositoryLease(root));
  let released = false;
  const release = async () => { if (released) return; released = true; await diagnostics.stage('lease.release', viewId, releaseLease); };
  const store = new ThreadStore(storage);
  try { await diagnostics.stage('history', viewId, () => store.load()); } catch (error) { await release(); throw error; }
  if (disposed) { await release(); return; }
  let thread = store.threads.at(-1) ?? store.create('New conversation');
  const index = new RepositoryIndex(root, storage);
  panel.webview.options = { enableScripts: true, localResourceRoots: [] };
  let busy = false;
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
  const invalidate = (uri: vscode.Uri) => index.invalidate(path.relative(root, uri.fsPath).replaceAll('\\', '/'));
  const invalidations = [watcher.onDidCreate(invalidate), watcher.onDidChange(invalidate), watcher.onDidDelete(invalidate)];
  let readyReceived = false, acknowledged = false; let stateToken = randomUUID();
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  const armHandshake = () => { clearTimeout(handshakeTimer); handshakeTimer = setTimeout(() => {
    if (!disposed && !acknowledged) diagnostics.log('handshake.timeout', { view: viewId, source: readyReceived ? 'ack-missing' : 'ready-missing' });
  }, 10000); handshakeTimer.unref(); };
  const send = (data: unknown) => {
    if (disposed) return;
    const initial = (data as { type?: string }).type === 'state' && !acknowledged;
    if (initial) diagnostics.log('state.sent', { view: viewId });
    void panel.webview.postMessage(initial ? { ...(data as object), startupToken: stateToken } : data).then(delivered => {
      if (initial) diagnostics.log('state.delivered', { view: viewId, delivered });
    }, error => diagnostics.log('webview.error', { view: viewId, code: startupError(error) }));
  };
  let discoveredModels: string[] = []; let discoveryEndpoint = ''; let discoveryFailed = false;
  let pendingQuestion: { id: string; resolve(answer: string): void; reject(error: Error): void } | undefined;
  const update = () => send({ type: 'state', questionId: pendingQuestion?.id, root, mode: mode(), model: config().get<string>('model', ''), threads: store.threads.filter(t => t.messages.length > 0).map(t => ({ id: t.id, lastUsedAt: lastChatActivity(t), archived: t.archived === true, name: t.name === 'New conversation' ? (t.messages.find(m => m.role === 'user')?.content.slice(0, 70) ?? t.name) : t.name })), thread, busy });
  const ask = async (question: string, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    thread.messages.push({ role: 'assistant', content: question });
    await store.save();
    return new Promise<string>((resolve, reject) => {
      signal.throwIfAborted();
      const id = randomUUID();
      const cleanup = () => { signal.removeEventListener('abort', abort); if (pendingQuestion?.id === id) pendingQuestion = undefined; };
      const abort = () => { cleanup(); reject(new Error('Cancelled.')); };
      pendingQuestion = { id, resolve: answer => { cleanup(); resolve(answer); }, reject: error => { cleanup(); reject(error); } };
      signal.addEventListener('abort', abort, { once: true });
      update();
    });
  };
  const hooks: EditHooks = {
    mode,
    isDirty: file => vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' && document.uri.fsPath.toLowerCase() === file.toLowerCase() && document.isDirty),
    preview: (file, before, after) => review.preview(file, before, after),
    confirm: async (question, signal) => (await paneChoice(panel, question + ' Inspect the native diff before approving.', ['Approve this operation'], signal)) === 0

  };
  const listener = panel.webview.onDidReceiveMessage(async message => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'choiceReply') return;
    if (message.type === 'ready') { readyReceived = true; acknowledged = false; stateToken = randomUUID(); diagnostics.log('ready', { view: viewId }); armHandshake(); update(); return; }
    if (message.type === 'startupAck') { if (!acknowledged && message.token === stateToken) { acknowledged = true; clearTimeout(handshakeTimer); diagnostics.log('state.ack', { view: viewId }); } return; }
    if (message.type === 'startupPhase') { if (message.phase === 'bootstrap' || message.phase === 'main') diagnostics.log(message.phase === 'bootstrap' ? 'webview.bootstrap' : 'webview.main', { view: viewId }); return; }
    if (message.type === 'startupError') { diagnostics.log('webview.error', { view: viewId, source: ['promise','resource','csp'].includes(message.source) ? message.source : 'script', code: 'unknown' }); return; }
    if (message.type === 'cancel') { active.get(root)?.abort(); return; }
    if (message.type === 'answer') {
      if (!pendingQuestion || message.id !== pendingQuestion.id || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 8000) return;
      const pending = pendingQuestion; pendingQuestion = undefined;
      thread.messages.push({ role: 'user', content: message.text }); thread.lastUsedAt = new Date().toISOString();
      try { await store.save(); pending.resolve(message.text); } catch (error) { pending.reject(error instanceof Error ? error : new Error('Could not save answer.')); }
      update(); return;
    }
    if (busy) return;
    busy = true;
    try {
      if (message.type === 'rename') {
        const previous = thread.name;
        try {
          if (message.id !== thread.id || typeof message.name !== 'string' || !message.name.trim() || message.name.trim().length > 100) throw new Error('Enter a name of 1–100 characters for the current chat.');
          thread.name = message.name.trim(); await store.save();
          send({ type: 'renameResult', id: thread.id, ok: true });
        } catch (error) {
          thread.name = previous;
          send({ type: 'renameResult', id: message.id, ok: false, error: error instanceof Error ? error.message : 'Could not rename chat.' });
        }
      } else if (message.type === 'archive' || message.type === 'restore') {
        const previous = thread.archived; thread.archived = message.type === 'archive';
        try { await store.save(); } catch (error) { thread.archived = previous; throw error; }
        if (thread.archived) send({ type: 'home' });
      } else if (message.type === 'settings') {
        await vscode.commands.executeCommand('llmRuntime.openSettings');
      } else if (message.type === 'selectModel') {
        discoveryEndpoint = config().get<string>('endpoint', ''); discoveredModels = []; discoveryFailed = false;
        try { discoveredModels = await (await client(context)).models(); send({ type: 'models', items: discoveredModels }); }
        catch { discoveryFailed = true; send({ type: 'models', items: [], error: 'Model discovery failed. Check your connection and endpoint settings, or enter a model ID manually.' }); }
      } else if (message.type === 'chooseModel') {
        const selected = message.model;
        if (discoveryEndpoint !== config().get<string>('endpoint', '') || typeof selected !== 'string' || !selected.trim() || selected.length > 200 || (!discoveredModels.includes(selected) && !(discoveryFailed && message.manual === true))) throw new Error('Refresh model selection and choose a returned model or explicitly enter an ID after discovery fails.');
        await config().update('model', selected.trim(), vscode.ConfigurationTarget.Global);
        send({ type: 'modelChosen' });
      } else if (message.type === 'permissions') {
        if (!['Review', 'Workspace', 'Full access'].includes(message.mode)) throw new Error('Unsupported permission mode.');
        await config().update('permissionMode', message.mode, vscode.ConfigurationTarget.Global);
      } else if (message.type === 'undo' && thread.undoTaskId) {
        const controller = new AbortController(); active.set(root, controller); update();
        let undoTask: EditTask | undefined;
        try {
          undoTask = await EditTask.load(index, storage, thread.undoTaskId, hooks);
          await undoTask.undo(controller.signal);
          if (thread.taskId === thread.undoTaskId) delete thread.taskId;
          delete thread.undoTaskId; thread.status = 'idle';
          thread.messages.push({ role: 'assistant', content: undoTask.undoSummary() });
        } catch (error) {
          thread.status = controller.signal.aborted ? 'cancelled' : 'blocked';
          thread.messages.push({ role: 'assistant', content: `${controller.signal.aborted ? 'Undo cancelled.' : error instanceof Error ? error.message : 'Undo failed.'}\n${undoTask?.undoSummary() ?? 'No undo was performed.'}` });
        } finally { active.delete(root); thread.lastUsedAt = new Date().toISOString(); await store.save(); }
      } else if (message.type === 'review' && thread.reviewTaskId) {
        await review.open(await EditTask.load(index, storage, thread.reviewTaskId, hooks));
      } else if (message.type === 'sourceControl') {
        await vscode.commands.executeCommand('workbench.view.scm');
      } else if (message.type === 'new') {
        if (thread.messages.length) { thread = store.create('New conversation'); await store.save(); }
      } else if (message.type === 'switch' && typeof message.id === 'string') {
        thread = store.threads.find(t => t.id === message.id) ?? thread;
      } else if (message.type === 'send' && typeof message.text === 'string' && message.text.trim() && message.text.length <= 8000) {
        if (thread.archived && message.newConversation !== true) throw new Error('Restore this archived chat before continuing it.');
        if (active.has(root)) throw new Error('A task is already running for this repository.');
        if (message.newConversation === true && thread.messages.length) thread = store.create('New conversation');
        if (!thread.messages.length) thread.name = message.text.trim().replace(/\s+/g, ' ').slice(0, 70);
        const controller = new AbortController(); active.set(root, controller);
        let task: EditTask | undefined;
        let validation: TaskValidation | undefined;
        thread.lastUsedAt = new Date().toISOString(); thread.messages.push({ role: 'user', content: message.text }); thread.status = 'running'; update();
        try {
          await store.save();
          const api = await client(context);
          const model = config().get<string>('model'); if (!model) throw new Error('Choose a model using the model button below the chat, then resend your message.');
          send({ type: 'progress', text: 'Refreshing repository index.' }); await index.refresh(controller.signal);
          if (thread.undoTaskId && (await EditTask.load(index, storage, thread.undoTaskId, hooks)).undoState() === 'running') throw new TaskConflict('Resume the incomplete task undo before continuing this conversation.');
          const previous = thread.taskId ? await EditTask.load(index, storage, thread.taskId, hooks) : undefined;
          send({ type: 'progress', text: 'Capturing task baseline and preexisting changes.' });
          task = await EditTask.capture(index, storage, hooks, controller.signal, previous);
          thread.taskId = task.id; await store.save();
          validation = new TaskValidation(task, {
            mode, isDirty: hooks.isDirty, redact: text => api.redact(text),
            installMissing: () => config().get<boolean>('installValidationModules', false),
            pesterMajor: () => { const selected = config().get<string>('pesterVersion', 'Auto'); return selected === '4' ? 4 : selected === '5' ? 5 : undefined; },
            progress: text => { thread.activity.push({ at: new Date().toISOString(), event: text }); thread.activity = thread.activity.slice(-500); send({ type: 'progress', text }); },
          }, createPowerShellRunner(config().get<'Inherit' | 'RemoteSigned'>('validationExecutionPolicy', 'Inherit')));
          const tools = new EditingTools(new ReadOnlyTools(index, ask), task, mode, (task, file) => review.open(task, file), validation, explicitCommitRequest(message.text));
          let diagnostics: ReturnType<typeof rejectionRecorder> | undefined;
          const summary = await runAgent(api, model, thread.messages, tools, mode, controller.signal, text => {
            thread.activity.push({ at: new Date().toISOString(), event: text });
            thread.activity = thread.activity.slice(-500);
            send({ type: 'progress', text });
          }, async response => {
            if (!config().get<boolean>('debugRejectedResponses', false)) return;
            diagnostics ??= rejectionRecorder(task!.directory, String(context.extension.packageJSON.version), model, mode, text => api.redact(text));
            await diagnostics(response);
          });
          thread.messages.push({ role: 'assistant', content: (summary + outcome(task, validation)).slice(0, 16000) }); thread.status = 'complete';
        } catch (e) {
          thread.status = controller.signal.aborted ? 'cancelled' : e instanceof TaskConflict ? 'blocked' : 'failed';
          const reason = controller.signal.aborted ? 'Task cancelled.' : e instanceof Error ? e.message : 'Task failed.';
          thread.messages.push({ role: 'assistant', content: reason + outcome(task, validation) });
        } finally {
          try {
            if (task) {
              if (task.changes().length) { thread.reviewTaskId = task.id; thread.undoTaskId = task.id; }
              if (task.committed()) thread.undoTaskId = undefined;
              await task.finish(thread.status === 'complete' ? 'complete' : thread.status === 'cancelled' ? 'cancelled' : thread.status === 'blocked' ? 'blocked' : 'failed');
              if (task.changes().length && !disposed) await review.open(task);
            }
          } finally { active.delete(root); thread.lastUsedAt = new Date().toISOString(); await store.save(); }
        }
      }
    } catch (e) { send({ type: 'progress', text: e instanceof Error ? e.message : 'Operation failed.' }); }
    finally { busy = false; update(); if (disposed) await release(); }
  });
  const settings = vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('llmRuntime')) update(); });
  context.subscriptions.push(panel.onDidDispose(() => { disposed = true; clearTimeout(handshakeTimer); active.get(root)?.abort(); listener.dispose(); settings.dispose(); watcher.dispose(); invalidations.forEach(d => d.dispose()); if (!busy) void release(); }));
  // Install the listener before loading HTML so the initial ready message cannot race it.
  diagnostics.log('html', { view: viewId }); armHandshake(); panel.webview.html = conversationHtml();
}
export async function deactivate(): Promise<void> { startupDiagnostics?.log('deactivate'); for (const controller of active.values()) controller.abort(); await startupDiagnostics?.flush(); }


export async function paneChoice(panel: vscode.WebviewView, question: string, choices: string[], signal?: AbortSignal): Promise<number | undefined> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const show = () => { void panel.webview.postMessage({ type: 'choice', id, question, choices }); };
    const cleanup = () => { listener.dispose(); disposal.dispose(); signal?.removeEventListener('abort', abort); void panel.webview.postMessage({ type: 'choiceClosed', id }); };
    const abort = () => { cleanup(); reject(new Error('Cancelled.')); };
    const listener = panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') { show(); return; }
      if (message?.type !== 'choiceReply' || message.id !== id) return;
      if (message.index !== null && (!Number.isInteger(message.index) || message.index < 0 || message.index >= choices.length)) return;
      cleanup(); resolve(message.index === null ? undefined : message.index);
    });
    const disposal = panel.onDidDispose(abort);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else show();
  });
}
