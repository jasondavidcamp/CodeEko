import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EditTask } from '../state/editTask';

export class NativeReview implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private documents = new Map<string, string>();
  private registration: vscode.Disposable;
  constructor(private scheme = 'ekod-snapshot') { this.registration = vscode.workspace.registerTextDocumentContentProvider(scheme, this); }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const text = this.documents.get(uri.toString());
    if (text === undefined) throw new Error('Review snapshot expired. Open the task review again.');
    return text;
  }
  private resource(file: string, text: string): vscode.Uri {
    const uri = vscode.Uri.parse(`${this.scheme}:/${randomUUID()}/${encodeURIComponent(path.basename(file))}`);
    this.documents.set(uri.toString(), text);
    while (this.documents.size > 256) this.documents.delete(this.documents.keys().next().value!);
    return uri;
  }
  async preview(file: string, before: string, after: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', this.resource(file, before), this.resource(file, after), `Proposed change · ${file}`, { preview: false });
  }
  async open(task: EditTask, file?: string): Promise<void> {
    const changes = task.changes().filter(change => !file || change.path === file);
    if (file && !changes.length) throw new Error('That file has no changes recorded for this task.');
    for (const change of changes) {
      const before = await task.snapshot(change.before); const after = await task.snapshot(change.after);
      const label = change.state === 'prepared' ? 'Unconfirmed operation—inspect working tree' : task.undoState() === 'complete' ? 'Historical task changes (undone)' : task.undoState() === 'running' ? 'Historical task changes (undo incomplete)' : 'Agent task changes';
      await vscode.commands.executeCommand('vscode.diff', this.resource(change.path, before), this.resource(change.path, after), `${label} · ${change.path}`, { preview: false, preserveFocus: true });
    }
  }
  dispose(): void { this.registration.dispose(); this.documents.clear(); }
}
