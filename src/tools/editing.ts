import { Action } from '../protocol/actions';
import { authorize, mutations, check, TaskConflict } from '../policy/boundary';
import { EditTask } from '../state/editTask';
import { ReadOnlyTools } from './readOnly';

export class EditingTools {
  constructor(private reads: ReadOnlyTools, readonly task: EditTask, private mode: () => string, private review: (task: EditTask, file?: string) => Promise<void>) {}
  async execute(action: Action, signal: AbortSignal): Promise<unknown> {
    authorize(action.tool, this.mode()); check(signal);
    if (mutations.has(action.tool)) {
      try { return await this.task.execute(action, signal); }
      catch (error) { check(signal); if (error instanceof TaskConflict) throw error; throw new TaskConflict('The edit could not finish safely. Review the recorded task changes before retrying.'); }
    }
    if (action.tool === 'git_diff_summary') return { changes: this.task.changes(), note: 'Task baseline includes preexisting developer edits; no raw Git patch is returned.' };
    if (action.tool === 'open_diff') { await this.review(this.task, action.args.path); return { opened: true }; }
    const result = await this.reads.execute(action, signal);
    if (action.tool === 'read_file' || action.tool === 'read_files') {
      for (const entry of Array.isArray(result) ? result : [result]) {
        const file = entry as { path?: string; hash?: string };
        if (file.path && file.hash) this.task.observe(file.path, file.hash);
      }
    }
    return result;
  }
}
