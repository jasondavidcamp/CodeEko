import { conversationHtml } from './conversation';
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { GeminiClient, apiBase } from '../api/client';
import { resolveRepository } from '../repository/git';
import { RepositoryIndex } from '../indexing';
import { ThreadStore, Thread, repositoryStorage, lastChatActivity } from '../state/threads';
import { ReadOnlyTools } from '../tools/readOnly';
import { runAgent } from '../agent/loop';
import { acquireRepositoryLease } from '../state/lease';
import { contained, TaskConflict } from '../policy/boundary';
import { EditTask, EditHooks } from '../state/editTask';
import { EditingTools } from '../tools/editing';
import { NativeReview } from './review';
import { TaskValidation } from '../validation/task';
import { createPowerShellRunner } from '../validation/powershell';
import * as path from 'node:path';
const active = new Map<string, AbortController>();
const config = () => vscode.workspace.getConfiguration('llmRuntime');
const mode = () => config().get<string>('permissionMode', 'Full access');
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
  let initialization: Promise<void> | undefined;
  let sidebar: vscode.WebviewView | undefined;
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('llmRuntime.conversation', {
    resolveWebviewView: view => {
      sidebar = view;
      context.subscriptions.push(view.onDidDispose(() => { initialization = undefined; }));
      initialization = open(context, review, view);
      return initialization;
    }
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  command('llmRuntime.open', async () => {
    await vscode.commands.executeCommand('llmRuntime.conversation.focus');
    // View resolution crosses the workbench/extension-host boundary and can arrive
    // after the focus command has returned.
    const deadline = Date.now() + 10000;
    while (!initialization && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!initialization) throw new Error('The conversation sidebar did not open. Try LLM Runtime: Open Conversation again.');
    await initialization;
    return true;
  });
  // Reveal once per window startup; subsequent user navigation stays untouched.
  // Ambiguous workspaces retain the explicit repository-selection flow.
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (vscode.workspace.isTrusted && folders.length === 1 && folders[0].uri.scheme === 'file') {
    void vscode.commands.executeCommand('llmRuntime.conversation.focus', { preserveFocus: true }).then(undefined, () => {});
  }
  return { isConversationVisible: () => sidebar?.visible === true };
}
async function open(context: vscode.ExtensionContext, review: NativeReview, panel: vscode.WebviewView): Promise<void> {
  let disposed = false;
  const earlyDispose = panel.onDidDispose(() => { disposed = true; });
  context.subscriptions.push(earlyDispose);
  if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before opening repository tools.');
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.some(f => f.uri.scheme !== 'file')) throw new Error('Only local filesystem workspaces are supported.');
  const root = await resolveRepository(folders.map(f => f.uri.fsPath), choices => Promise.resolve(vscode.window.showQuickPick(choices, { title: 'Select the repository boundary' })));
  const storage = repositoryStorage(context.globalStorageUri.fsPath, root);
  if (contained(root, storage)) throw new Error('Extension storage must be outside the repository. Open a narrower repository folder.');
  const release = await acquireRepositoryLease(root);
  const store = new ThreadStore(storage);
  try { await store.load(); } catch (error) { await release(); throw error; }
  if (disposed) { await release(); return; }
  let thread = store.threads.at(-1) ?? store.create('New conversation');
  const index = new RepositoryIndex(root, storage);
  panel.webview.options = { enableScripts: true, localResourceRoots: [] };
  let busy = false;
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
  const invalidate = (uri: vscode.Uri) => index.invalidate(path.relative(root, uri.fsPath).replaceAll('\\', '/'));
  const invalidations = [watcher.onDidCreate(invalidate), watcher.onDidChange(invalidate), watcher.onDidDelete(invalidate)];
  const send = (data: unknown) => { if (!disposed) void panel.webview.postMessage(data); };
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
    confirm: async (question, signal) => {
      const token = new vscode.CancellationTokenSource(); const abort = () => token.cancel(); signal.addEventListener('abort', abort, { once: true });
      try { signal.throwIfAborted(); return await vscode.window.showQuickPick(['Cancel', 'Approve this operation'], { title: question, placeHolder: 'Inspect the native diff, then approve this specific operation.', ignoreFocusOut: true }, token.token) === 'Approve this operation'; }
      finally { signal.removeEventListener('abort', abort); token.dispose(); }
    }
  };
  const listener = panel.webview.onDidReceiveMessage(async message => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'ready') { update(); return; }
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
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:internal-pilot.llm-coding-agent-runtime');
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
        if (!['Review', 'Workspace', 'Full access', 'Custom'].includes(message.mode)) throw new Error('Unsupported permission mode.');
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
            selectTests: async (candidates, signal) => {
              const token = new vscode.CancellationTokenSource(); const abort = () => token.cancel(); signal.addEventListener('abort', abort, { once: true });
              try {
                signal.throwIfAborted();
                const selected = await vscode.window.showQuickPick(candidates, { canPickMany: true, title: 'Select trusted unit tests for up to three validation rounds', placeHolder: 'Selected scripts and their dependencies execute with your account permissions. Select none to skip Pester.', ignoreFocusOut: true }, token.token);
                return selected ?? [];
              } finally { signal.removeEventListener('abort', abort); token.dispose(); }
            }
          }, createPowerShellRunner(config().get<'Inherit' | 'RemoteSigned'>('validationExecutionPolicy', 'Inherit')));
          const tools = new EditingTools(new ReadOnlyTools(index, ask), task, mode, (task, file) => review.open(task, file), validation);
          const summary = await runAgent(api, model, thread.messages, tools, mode, controller.signal, text => {
            thread.activity.push({ at: new Date().toISOString(), event: text });
            thread.activity = thread.activity.slice(-500);
            send({ type: 'progress', text });
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
  context.subscriptions.push(panel.onDidDispose(() => { disposed = true; active.get(root)?.abort(); listener.dispose(); settings.dispose(); watcher.dispose(); invalidations.forEach(d => d.dispose()); if (!busy) void release(); }));
  // Install the listener before loading HTML so the initial ready message cannot race it.
  panel.webview.html = conversationHtml();
}
export function deactivate(): void { for (const controller of active.values()) controller.abort(); }
