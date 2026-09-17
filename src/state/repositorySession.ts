import { ToolExecutor } from '../agent/loop';
import { RepositoryIndex } from '../indexing';
import { authorize, check, mutations, TaskConflict } from '../policy/boundary';
import { Action } from '../protocol/actions';
import { git } from '../repository/git';
import { EditingTools } from '../tools/editing';
import { ReadOnlyTools } from '../tools/readOnly';
import { TaskValidation } from '../validation/task';
import { CaptureEvidence, EditHooks, EditTask } from './editTask';
import { performanceDiagnostics } from './performanceDiagnostics';

interface SessionOptions {
  index: RepositoryIndex;
  storage: string;
  hooks: EditHooks;
  previousTaskId?: string;
  undoTaskId?: string;
  ask(question: string, signal: AbortSignal): Promise<string>;
  review(task: EditTask, file?: string): Promise<void>;
  createValidation(task: EditTask): TaskValidation;
  ready(task: EditTask, validation: TaskValidation, signal: AbortSignal): Promise<void>;
  progress(text: string): void;
  commitRequested: boolean;
}

/** One turn, bound to one repository. Construction performs no repository I/O.
 * Failed initialization is memoized: subsequent actions cannot retry/replay it.
 * The edit baseline starts at the first stateful tool, not at the user's message.
 * Earlier file reads and checkout identity remain constraints on that baseline.
 */
export class RepositorySession implements ToolExecutor {
  private resources?: Promise<void>;
  private edits?: Promise<EditingTools>;
  private previous?: EditTask;
  private evidence?: CaptureEvidence;
  private readonly observed = new Map<string, string>();
  private readonly editReads = new Map<string, string>();
  private readonly reads: ReadOnlyTools;
  private editing?: EditingTools;
  private inventoryFresh = false;
  constructor(private options: SessionOptions) {
    this.reads = new ReadOnlyTools(options.index, options.ask, signal => this.refresh(signal), (file, hash, explicitRead) => {
      // Do not rebase an earlier observation if another read sees external edits.
      if (!this.observed.has(file)) this.observed.set(file, hash);
      if (explicitRead) { this.editReads.set(file, hash); this.editing?.task.observe(file, hash); }
    });
  }
  private async initialize(signal: AbortSignal): Promise<void> {
    check(signal);
    const { index, storage, hooks, previousTaskId, undoTaskId } = this.options;
    try {
      for (const id of new Set([previousTaskId, undoTaskId].filter((id): id is string => !!id))) {
        const prior = await performanceDiagnostics.measure('history', () => EditTask.load(index, storage, id, hooks));
        check(signal); prior.assertUndoComplete();
        if (id === previousTaskId) this.previous = prior;
      }
      this.evidence = { head: (await git(index.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal, true)).trim() || null, reads: this.observed, editReads: this.editReads };
      check(signal);
    } catch (error) { check(signal); if (error instanceof TaskConflict) throw error; throw new TaskConflict('Repository history could not be initialized safely. Inspect task storage before retrying.'); }
  }
  private async prepare(signal: AbortSignal): Promise<void> {
    check(signal); await (this.resources ??= this.initialize(signal)); check(signal);
  }
  private async refresh(signal: AbortSignal): Promise<void> {
    this.inventoryFresh = false;
    this.options.progress('Refreshing repository index.');
    await performanceDiagnostics.measure('index', () => this.options.index.refresh(signal));
    check(signal); this.inventoryFresh = true;
  }
  private async initializeEdits(signal: AbortSignal): Promise<EditingTools> {
    await this.prepare(signal);
    const o = this.options;
    let task: EditTask | undefined;
    try {
      o.progress('Capturing task baseline and preexisting changes.');
      task = await performanceDiagnostics.measure('baseline', () => EditTask.capture(o.index, o.storage, o.hooks, signal, this.previous, this.evidence, () => this.refresh(signal)));
      check(signal);
      const validation = o.createValidation(task);
      const editing = new EditingTools(this.reads, task, o.hooks.mode, o.review, validation, o.commitRequested);
      check(signal); await o.ready(task, validation, signal);
      // ready must finish publishing the task reference before any side effects.
      this.editing = editing; return editing;
    } catch (error) {
      if (task) await task.discardInitialization();
      check(signal);
      if (error instanceof TaskConflict) throw error;
      throw new TaskConflict('Repository edit state could not be initialized safely. No action was executed.');
    }
  }
  async initialContext(signal: AbortSignal): Promise<unknown> {
    await this.prepare(signal);
    // Called immediately after a repository action by runAgent. Reuse that
    // action's refresh; after a mutation, membership must be refreshed again.
    if (!this.inventoryFresh) await this.refresh(signal);
    return this.reads.inventory();
  }
  async beforeComplete(signal: AbortSignal): Promise<unknown | undefined> {
    check(signal); return this.editing?.beforeComplete(signal);
  }
  async execute(action: Action, signal: AbortSignal): Promise<unknown> {
    authorize(action.tool, this.options.hooks.mode()); check(signal);
    if (action.tool === 'ask_user' || action.tool === 'complete_task') return this.reads.execute(action, signal);
    if (action.tool === 'git_commit' && !this.options.commitRequested) throw new TaskConflict('Ask explicitly to commit in your latest message before using local commits.');
    this.inventoryFresh = false;
    const stateful = mutations.has(action.tool) || ['run_validation', 'git_diff_summary', 'open_diff', 'git_commit'].includes(action.tool);
    if (stateful) {
      const editing = await (this.edits ??= this.initializeEdits(signal));
      check(signal);
      try { return await editing.execute(action, signal); }
      finally { if (mutations.has(action.tool) || action.tool === 'git_commit') this.inventoryFresh = false; }
    }
    await this.prepare(signal);
    return this.reads.execute(action, signal);
  }
}
