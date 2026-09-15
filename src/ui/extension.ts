import * as vscode from 'vscode';
import { randomBytes, createHash } from 'node:crypto';
import { GeminiClient, apiBase } from '../api/client';
import { resolveRepository } from '../repository/git';
import { RepositoryIndex } from '../indexing';
import { ThreadStore, Thread, repositoryStorage } from '../state/threads';
import { ReadOnlyTools } from '../tools/readOnly';
import { runAgent } from '../agent/loop';
import { acquireRepositoryLease } from '../state/lease';
import { contained, TaskConflict } from '../policy/boundary';
import { EditTask, EditHooks } from '../state/editTask';
import { EditingTools } from '../tools/editing';
import { NativeReview } from './review';
import * as path from 'node:path';
const active = new Map<string, AbortController>();
const panels = new Map<string, vscode.WebviewPanel>();
const config = () => vscode.workspace.getConfiguration('llmRuntime');
const mode = () => config().get<string>('permissionMode', 'Full access');
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
export function activate(context: vscode.ExtensionContext): void {
  const review = new NativeReview(); context.subscriptions.push(review);
  const command = (name: string, fn: () => Promise<void>) => context.subscriptions.push(vscode.commands.registerCommand(name, () => fn().catch(e => vscode.window.showErrorMessage(e instanceof Error ? e.message : 'Operation failed.'))));
  command('llmRuntime.setKey', async () => {
    const endpoint = config().get<string>('endpoint', '');
    if (!endpoint) throw new Error('Configure an HTTPS API endpoint first.');
    const name = keyName(endpoint);
    const key = await vscode.window.showInputBox({ title: 'API key for ' + new URL(endpoint).host, password: true, ignoreFocusOut: true });
    if (key?.trim()) { await context.secrets.store(name, key.trim()); vscode.window.showInformationMessage('API key stored securely for this endpoint.'); }
  });
  command('llmRuntime.selectModel', () => selectModel(context));
  command('llmRuntime.open', () => open(context, review));
}
async function open(context: vscode.ExtensionContext, review: NativeReview): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before opening repository tools.');
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.some(f => f.uri.scheme !== 'file')) throw new Error('Only local filesystem workspaces are supported.');
  const root = await resolveRepository(folders.map(f => f.uri.fsPath), choices => Promise.resolve(vscode.window.showQuickPick(choices, { title: 'Select the repository boundary' })));
  const existing = panels.get(root); if (existing) { existing.reveal(); return; }
  const storage = repositoryStorage(context.globalStorageUri.fsPath, root);
  if (contained(root, storage)) throw new Error('Extension storage must be outside the repository. Open a narrower repository folder.');
  const release = await acquireRepositoryLease(root);
  const store = new ThreadStore(storage);
  try { await store.load(); } catch (error) { await release(); throw error; }
  let thread = store.threads.at(-1) ?? store.create('New conversation');
  const index = new RepositoryIndex(root, storage);
  const panel = vscode.window.createWebviewPanel('llmRuntime', 'LLM Coding Agent Runtime', vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
  panels.set(root, panel); panel.webview.html = html();
  let busy = false; let disposed = false;
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
  const invalidate = (uri: vscode.Uri) => index.invalidate(path.relative(root, uri.fsPath).replaceAll('\\', '/'));
  const invalidations = [watcher.onDidCreate(invalidate), watcher.onDidChange(invalidate), watcher.onDidDelete(invalidate)];
  const send = (data: unknown) => { if (!disposed) void panel.webview.postMessage(data); };
  const update = () => send({ type: 'state', root, mode: mode(), threads: store.threads.map(t => ({ id: t.id, name: t.name })), thread, busy });
  const ask = async (question: string, signal: AbortSignal): Promise<string> => {
    const token = new vscode.CancellationTokenSource(); const abort = () => token.cancel(); signal.addEventListener('abort', abort, { once: true });
    try { signal.throwIfAborted(); const answer = await vscode.window.showInputBox({ title: 'Agent question', prompt: question, ignoreFocusOut: true }, token.token); if (answer === undefined) { active.get(root)?.abort(); throw new Error('Cancelled.'); } return answer.slice(0, 8000); }
    finally { signal.removeEventListener('abort', abort); token.dispose(); }
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
    if (busy) return;
    busy = true;
    try {
      if (message.type === 'review' && thread.reviewTaskId) {
        await review.open(await EditTask.load(index, storage, thread.reviewTaskId, hooks));
      } else if (message.type === 'sourceControl') {
        await vscode.commands.executeCommand('workbench.view.scm');
      } else if (message.type === 'new') {
        const name = await vscode.window.showInputBox({ title: 'Name this conversation', value: 'New conversation' });
        if (name) { thread = store.create(name); await store.save(); }
      } else if (message.type === 'switch' && typeof message.id === 'string') {
        thread = store.threads.find(t => t.id === message.id) ?? thread;
      } else if (message.type === 'send' && typeof message.text === 'string' && message.text.trim() && message.text.length <= 8000) {
        if (active.has(root)) throw new Error('A task is already running for this repository.');
        const controller = new AbortController(); active.set(root, controller);
        let task: EditTask | undefined;
        thread.messages.push({ role: 'user', content: message.text }); thread.status = 'running'; update();
        try {
          await store.save();
          const api = await client(context); if (!config().get<string>('model')) await selectModel(context, controller.signal);
          const model = config().get<string>('model'); if (!model) throw new Error('Select or configure a model first.');
          send({ type: 'progress', text: 'Refreshing repository index.' }); await index.refresh(controller.signal);
          const previous = thread.taskId ? await EditTask.load(index, storage, thread.taskId, hooks) : undefined;
          send({ type: 'progress', text: 'Capturing task baseline and preexisting changes.' });
          task = await EditTask.capture(index, storage, hooks, controller.signal, previous);
          thread.taskId = task.id; await store.save();
          const tools = new EditingTools(new ReadOnlyTools(index, ask), task, mode, (task, file) => review.open(task, file));
          const summary = await runAgent(api, model, thread.messages, tools, mode, controller.signal, text => {
            thread.activity.push({ at: new Date().toISOString(), event: text });
            thread.activity = thread.activity.slice(-500);
            send({ type: 'progress', text });
          });
          thread.messages.push({ role: 'assistant', content: (summary + (task.changes().length ? '\n\n' + task.summary() : '')).slice(0, 16000) }); thread.status = 'complete';
        } catch (e) {
          thread.status = controller.signal.aborted ? 'cancelled' : e instanceof TaskConflict ? 'blocked' : 'failed';
          const reason = controller.signal.aborted ? 'Task cancelled.' : e instanceof Error ? e.message : 'Task failed.';
          thread.messages.push({ role: 'assistant', content: `${reason}\n\n${task?.summary() ?? 'No repository files were changed.'}` });
        } finally {
          try {
            if (task) {
              if (task.changes().length) thread.reviewTaskId = task.id;
              await task.finish(thread.status === 'complete' ? 'complete' : thread.status === 'cancelled' ? 'cancelled' : thread.status === 'blocked' ? 'blocked' : 'failed');
              if (task.changes().length && !disposed) await review.open(task);
            }
          } finally { active.delete(root); await store.save(); }
        }
      }
    } catch (e) { send({ type: 'progress', text: e instanceof Error ? e.message : 'Operation failed.' }); }
    finally { busy = false; update(); if (disposed) await release(); }
  });
  const settings = vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('llmRuntime')) update(); });
  panel.onDidDispose(() => { disposed = true; active.get(root)?.abort(); panels.delete(root); listener.dispose(); settings.dispose(); watcher.dispose(); invalidations.forEach(d => d.dispose()); if (!busy) void release(); });
  context.subscriptions.push(panel);
}
export function deactivate(): void { for (const controller of active.values()) controller.abort(); }
function html(): string {
  const nonce = randomBytes(16).toString('hex');
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;max-width:900px;margin:auto}textarea{width:100%;min-height:90px;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground)}button,select{margin:8px 8px 8px 0;padding:6px}article{white-space:pre-wrap;overflow-wrap:anywhere;border-bottom:1px solid var(--vscode-panel-border);padding:12px 0}#status,#boundary{opacity:.8}label{display:block;margin-top:16px}</style></head><body>
<h2>LLM Coding Agent Runtime</h2><p id="boundary"></p><label for="threads">Conversation</label><select id="threads"></select><button id="new">New conversation</button><button id="review">Review task changes</button><button id="sourceControl">Source Control</button><main id="messages" aria-live="polite"></main><p id="status" role="status"></p><label for="input">Message</label><textarea id="input" maxlength="8000" placeholder="Ask about or change this repository…"></textarea><button id="send">Send</button><button id="cancel">Cancel task</button>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();const el=id=>document.getElementById(id);let busy=false;
el('send').onclick=()=>{if(!busy&&el('input').value.trim()){vscode.postMessage({type:'send',text:el('input').value});el('input').value='';}};
el('cancel').onclick=()=>vscode.postMessage({type:'cancel'});el('new').onclick=()=>vscode.postMessage({type:'new'});el('threads').onchange=()=>vscode.postMessage({type:'switch',id:el('threads').value});
el('review').onclick=()=>vscode.postMessage({type:'review'});el('sourceControl').onclick=()=>vscode.postMessage({type:'sourceControl'});
window.addEventListener('message',event=>{const m=event.data;if(m.type==='progress'){el('status').textContent=m.text;return;}if(m.type!=='state')return;busy=m.busy;el('boundary').textContent=m.root+' • '+m.mode+' • '+(['Workspace','Full access'].includes(m.mode)?'Editing enabled':'Read-only');el('threads').replaceChildren();for(const t of m.threads){const o=document.createElement('option');o.value=t.id;o.textContent=t.name;o.selected=t.id===m.thread.id;el('threads').append(o);}el('messages').replaceChildren();for(const msg of m.thread.messages){const a=document.createElement('article');a.textContent=(msg.role==='user'?'You':'Agent')+'\\n'+msg.content;el('messages').append(a);}for(const id of ['send','new','threads','sourceControl'])el(id).disabled=busy;el('review').disabled=busy||!m.thread.reviewTaskId;el('cancel').disabled=!busy;if(!busy)el('status').textContent=m.thread.status;});vscode.postMessage({type:'ready'});</script></body></html>`;
}
