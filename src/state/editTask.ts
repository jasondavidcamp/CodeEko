import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RepositoryIndex, excluded, fileDocument } from '../indexing';
import { git } from '../repository/git';
import { decode, encode, hash } from '../repository/document';
import { authorize, check, contained, safePath, TaskConflict } from '../policy/boundary';
import { Action } from '../protocol/actions';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fileState = z.object({ before: digest, current: digest.nullable(), preexisting: z.boolean(), protected: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })) });
const changeSchema = z.object({ path: z.string(), before: digest.nullable(), after: digest.nullable(), preexisting: z.boolean(), operation: z.enum(['patch','create','delete','move']), state: z.enum(['prepared','applied']) });
const journalSchema = z.object({ version: z.literal(1), id: z.string().uuid(), root: z.string(), head: z.string().nullable(), status: z.enum(['running','complete','cancelled','failed','blocked']), files: z.record(fileState), changes: z.array(changeSchema).max(24) });
export type TaskChange = z.infer<typeof changeSchema>;
export interface EditHooks {
  mode(): string;
  isDirty(file: string): boolean;
  confirm(question: string, signal: AbortSignal): Promise<boolean>;
  preview(file: string, before: string, after: string): Promise<void>;
}

async function head(root: string): Promise<string | null> {
  return (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, true)).trim() || null;
}
export class EditTask {
  readonly id: string;
  private journal: z.infer<typeof journalSchema>;
  private observed = new Map<string, string>();
  private operations = 0;
  private reviewOnly = false;
  private constructor(readonly index: RepositoryIndex, readonly directory: string, private hooks: EditHooks, journal: z.infer<typeof journalSchema>) {
    this.journal = journal; this.journal.files = Object.assign(Object.create(null), journal.files); this.id = journal.id;
  }
  static async capture(index: RepositoryIndex, storage: string, hooks: EditHooks, signal: AbortSignal, previous?: EditTask): Promise<EditTask> {
    if (contained(index.root, storage)) throw new Error('Task storage must be outside the repository.');
    await index.refresh(signal);
    const id = randomUUID(); const directory = path.join(storage, 'tasks', id);
    const task = new EditTask(index, directory, hooks, { version: 1, id, root: index.root, head: await head(index.root), status: 'running', files: {}, changes: [] });
    await fs.mkdir(path.join(directory, 'blobs'), { recursive: true });
    const status = (await git(index.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)).split('\0');
    const dirty = new Set<string>();
    for (let i = 0; i < status.length; i++) { if (!status[i]) continue; dirty.add(status[i].slice(3)); if (/[RC]/.test(status[i].slice(0, 2))) i++; }
    for (const file of index.entries.keys()) {
      check(signal); const document = await index.readDocument(file, signal, false);
      await task.saveBlob(document.bytes);
      const protectedRanges: { start: number; end: number }[] = [];
      if (dirty.has(file)) {
        let diff = '';
        if (task.journal.head) diff = await git(index.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=0', task.journal.head, '--', file], signal);
        const offsets = [0]; for (let i = 0; i < document.text.length; i++) if (document.text[i] === '\n') offsets.push(i + 1);
        for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
          const first = Number(match[1]); const count = match[2] === undefined ? 1 : Number(match[2]);
          const start = offsets[Math.max(0, first - 1)] ?? document.text.length;
          const end = offsets[Math.max(0, first - 1) + count] ?? document.text.length;
          protectedRanges.push({ start, end });
        }
        // Untracked files, binary diffs, and uncertain attribution are fully protected.
        if (!protectedRanges.length) protectedRanges.push({ start: 0, end: document.text.length });
      }
      const prior = previous?.journal.files[file];
      const canInherit = prior?.current === document.hash && !previous?.journal.changes.some(c => c.path === file && c.state === 'prepared');
      task.journal.files[file] = { before: document.hash, current: document.hash, preexisting: canInherit ? prior!.preexisting : dirty.has(file), protected: canInherit ? prior!.protected.map(r => ({ ...r })) : protectedRanges };
    }
    check(signal);
    if (await head(index.root) !== task.journal.head) throw new TaskConflict('The Git checkout changed while capturing the task baseline. Please retry.');
    await task.persist(); return task;
  }
  static async load(index: RepositoryIndex, storage: string, id: string, hooks: EditHooks): Promise<EditTask> {
    z.string().uuid().parse(id);
    const directory = path.join(storage, 'tasks', id);
    const data = journalSchema.parse(JSON.parse(await fs.readFile(path.join(directory, 'task.json'), 'utf8')));
    if (data.id !== id || data.root !== index.root) throw new Error('Task does not belong to this repository.');
    const task = new EditTask(index, directory, hooks, data); task.reviewOnly = true; return task;
  }
  observe(file: string, digest: string): void { this.observed.set(file, digest); }
  changes(): TaskChange[] { return this.journal.changes.map(change => ({ ...change })); }
  async snapshot(digest: string | null): Promise<string> {
    if (!digest) return '';
    const bytes = await fs.readFile(path.join(this.directory, 'blobs', z.string().regex(/^[a-f0-9]{64}$/).parse(digest)));
    if (hash(bytes) !== digest) throw new Error('Task snapshot integrity check failed.');
    return decode(bytes).text;
  }
  async finish(status: z.infer<typeof journalSchema>['status']): Promise<void> { this.journal.status = status; await this.persist(); }
  summary(): string {
    const changes = this.changes(); if (!changes.length) return 'No repository files were changed.';
    const applied = changes.filter(c => c.state === 'applied'); const pending = changes.filter(c => c.state === 'prepared');
    return `${applied.length} file change(s) recorded${pending.length ? `; ${pending.length} operation(s) need inspection after interruption` : ''}. Changes remain uncommitted. Review the task diffs.`;
  }
  private async persist(): Promise<void> {
    const temporary = path.join(this.directory, `task.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(journalSchema.parse(this.journal)), { mode: 0o600 });
    await fs.rename(temporary, path.join(this.directory, 'task.json'));
  }
  private async saveBlob(bytes: Buffer): Promise<string> {
    const digest = hash(bytes); await fs.writeFile(path.join(this.directory, 'blobs', digest), bytes, { mode: 0o600 }); return digest;
  }
  private async allowedPath(file: string): Promise<string> {
    if (excluded(file) || /(^|\/)(\.git[^/]*|\.llm-runtime-[^/]*|\.vscode)(\/|$)/i.test(file)) throw new TaskConflict(`Editing protected configuration or excluded content is not allowed: ${file}`);
    const full = await safePath(this.index.root, file, true);
    const ignored = (await git(this.index.root, ['ls-files', '-z', '--cached', '--others', '--ignored', '--exclude-standard', '--', file])).split('\0');
    if (ignored.includes(file)) throw new TaskConflict(`The path is ignored: ${file}`);
    // For a new path Git ls-files cannot see it yet; check-ignore also works on absent paths.
    if ((await git(this.index.root, ['check-ignore','--no-index','--', file], undefined, true)).trim()) throw new TaskConflict(`The path is ignored: ${file}`);
    for (let parent = path.dirname(full); parent !== this.index.root; parent = path.dirname(parent)) {
      try { await fs.lstat(path.join(parent, '.git')); throw new TaskConflict(`Path belongs to a nested repository: ${file}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (this.hooks.isDirty(full)) throw new TaskConflict(`Save or discard the unsaved editor changes to ${file} before retrying. No overlapping edit was applied.`);
    return full;
  }
  private async guard(tool: string, signal: AbortSignal): Promise<void> {
    authorize(tool, this.hooks.mode()); check(signal);
    if (await head(this.index.root) !== this.journal.head) throw new TaskConflict('The Git checkout changed during the task. Review the current changes before continuing.');
    check(signal);
  }
  private async current(file: string, expectedHash: string, signal: AbortSignal) {
    check(signal); const full = await this.allowedPath(file);
    const known = this.journal.files[file];
    if (!known || known.current !== expectedHash || this.observed.get(file) !== expectedHash) throw new TaskConflict(`Read ${file} again before editing; its task/read hash is stale or missing.`);
    const document = await fileDocument(this.index.root, file);
    if (document.hash !== expectedHash) throw new TaskConflict(`${file} changed after it was read. Please review the external changes and retry the task.`);
    const stat = await fs.lstat(full);
    if (stat.nlink > 1) throw new TaskConflict(`Hard-linked files cannot be edited safely: ${file}`);
    return { full, document, known, stat };
  }
  async execute(action: Action, signal: AbortSignal): Promise<unknown> {
    if (this.reviewOnly || this.journal.status !== 'running') throw new TaskConflict('This task is closed. Start a follow-up task before editing.');
    authorize(action.tool, this.hooks.mode()); check(signal);
    if (!['apply_patch','create_file','move_file','delete_file'].includes(action.tool)) throw new Error('Not an editing action.');
    if (++this.operations > 12) throw new TaskConflict('Task reached the 12-operation editing limit. Review the current changes before continuing.');
    if (await head(this.index.root) !== this.journal.head) throw new TaskConflict('The Git checkout changed during the task. Review the current changes before continuing.');
    if (action.tool === 'create_file') {
      const full = await this.allowedPath(action.args.path);
      if (this.journal.files[action.args.path]) throw new TaskConflict('Create cannot replace a task baseline file.');
      try { await fs.lstat(full); throw new TaskConflict(`Destination already exists: ${action.args.path}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const powershell = /\.ps[md]?1$/i.test(action.args.path);
      const bytes = encode(action.args.content, { encoding: powershell ? 'utf8bom' : 'utf8', eol: powershell ? '\r\n' : '\n', mixedEol: false });
      await this.write(action.args.path, null, bytes, 'create', signal);
      return { path: action.args.path, hash: hash(bytes), applied: true };
    }
    if (action.tool !== 'apply_patch' && action.tool !== 'move_file' && action.tool !== 'delete_file') throw new Error('Not an editing action.');
    const file = action.args.path; const expected = action.args.expectedHash;
    const state = await this.current(file, expected, signal);
    if (action.tool === 'apply_patch') {
      const text = state.document.text;
      const edits = action.args.edits.map(edit => {
        const oldText = edit.oldText.replaceAll('\r\n', '\n'); const newText = edit.newText.replaceAll('\r\n', '\n');
        const start = text.indexOf(oldText);
        if (start < 0 || (oldText ? text.indexOf(oldText, start + 1) !== -1 : text.length > 0 || action.args.edits.length !== 1)) throw new TaskConflict(`Patch text is missing or ambiguous in ${file}. Use a smaller, unique replacement after reading the file.`);
        return { start, end: start + oldText.length, newText };
      }).sort((a, b) => a.start - b.start);
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (i && edits[i - 1].end > edit.start) throw new TaskConflict('Patch replacements overlap.');
        if (state.known.protected.some(r => r.start === r.end ? edit.start <= r.start && edit.end >= r.end : edit.start < r.end && edit.end > r.start)) throw new TaskConflict(`The proposed edit overlaps preexisting developer changes in ${file}. What should be preserved? No overlapping edit was applied.`);
      }
      let next = text;
      for (const edit of [...edits].reverse()) next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end);
      if (next === text) return { applied: false, reason: 'No text change.' };
      if (text.trim() && !next.trim()) await this.confirm(`Erase all content in ${file}?`, file, text, next, signal);
      const bytes = encode(next, state.document);
      await this.write(file, expected, bytes, 'patch', signal);
      state.known.protected = state.known.protected.map(range => {
        const delta = edits.filter(edit => edit.end <= range.start).reduce((sum, edit) => sum + edit.newText.length - (edit.end - edit.start), 0);
        return { start: range.start + delta, end: range.end + delta };
      });
      await this.persist(); return { path: file, hash: hash(bytes), applied: true };
    }
    if (action.tool === 'delete_file') {
      await this.confirm(`Delete ${file}${state.known.preexisting ? ', including its preexisting uncommitted changes' : ''}?`, file, state.document.text, '', signal);
      await this.guard(action.tool, signal); await this.current(file, expected, signal); authorize(action.tool, this.hooks.mode()); check(signal);
      await this.prepare(file, null, 'delete');
      await this.guard(action.tool, signal); await this.current(file, expected, signal); authorize(action.tool, this.hooks.mode()); check(signal);
      await fs.unlink(state.full);
      this.applied(file, null); await this.persist(); this.index.invalidate(file);
      return { path: file, applied: true };
    }
    const destination = action.args.destination;
    if (file.toLowerCase() === destination.toLowerCase()) throw new TaskConflict('Same-path and case-only moves are not supported.');
    const target = await this.allowedPath(destination);
    if (this.journal.files[destination]) throw new TaskConflict('Move destination belongs to the task baseline.');
    await this.confirm(`Move ${file} to ${destination}?`, file, state.document.text, state.document.text, signal);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.allowedPath(destination); await this.current(file, expected, signal); authorize(action.tool, this.hooks.mode()); check(signal);
    await this.prepare(file, null, 'move'); await this.prepare(destination, state.document.bytes, 'move');
    await this.allowedPath(destination); await this.guard(action.tool, signal); await this.current(file, expected, signal); authorize(action.tool, this.hooks.mode()); check(signal);
    // Hard-link creation is an atomic, no-overwrite destination operation on the same filesystem.
    await fs.link(state.full, target);
    try {
      if ((await fileDocument(this.index.root, file)).hash !== expected) throw new TaskConflict('Move source changed before completion.');
      await fs.unlink(state.full);
    } catch (error) {
      const source = await fs.stat(state.full).catch(() => undefined); const dest = await fs.stat(target).catch(() => undefined);
      if (source && dest && source.ino === dest.ino && source.dev === dest.dev) await fs.unlink(target);
      throw error;
    }
    const protection = state.known.protected.map(range => ({ ...range })); const preexisting = state.known.preexisting;
    this.applied(file, null); this.applied(destination, expected);
    const destinationState = this.journal.files[destination] as z.infer<typeof fileState>;
    destinationState.protected = protection; destinationState.preexisting = preexisting;
    this.journal.changes.find(change => change.path === destination)!.preexisting = preexisting;
    await this.persist(); this.index.invalidate(file); this.index.invalidate(destination);
    return { path: file, destination, applied: true };
  }
  private async confirm(question: string, file: string, before: string, after: string, signal: AbortSignal): Promise<void> {
    await this.hooks.preview(file, before, after); check(signal);
    if (!await this.hooks.confirm(question, signal)) throw new TaskConflict('Destructive operation was not approved. No requested destructive change was applied.');
    check(signal);
  }
  private async prepare(file: string, bytes: Buffer | null, operation: TaskChange['operation']): Promise<void> {
    const after = bytes ? await this.saveBlob(bytes) : null;
    let change = this.journal.changes.find(c => c.path === file);
    if (!change) {
      change = { path: file, before: this.journal.files[file]?.before ?? null, after, preexisting: this.journal.files[file]?.preexisting ?? false, operation, state: 'prepared' };
      this.journal.changes.push(change);
    } else { change.after = after; change.state = 'prepared'; change.operation = operation; }
    await this.persist();
  }
  private applied(file: string, after: string | null): void {
    const change = this.journal.changes.find(c => c.path === file)!; change.state = 'applied';
    if (this.journal.files[file]) this.journal.files[file].current = after;
    else if (after) this.journal.files[file] = { before: after, current: after, preexisting: false, protected: [] };
    this.observed.delete(file);
  }
  private async write(file: string, expected: string | null, bytes: Buffer, operation: 'patch' | 'create', signal: AbortSignal): Promise<void> {
    const full = await this.allowedPath(file); await fs.mkdir(path.dirname(full), { recursive: true }); await this.allowedPath(file);
    const temporary = path.join(path.dirname(full), `.llm-runtime-${randomUUID()}.tmp`);
    let fileMode = 0o644;
    if (expected) fileMode = (await this.current(file, expected, signal)).stat.mode;
    const handle = await fs.open(temporary, 'wx', fileMode);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await this.prepare(file, bytes, operation);
      await this.guard(operation === 'create' ? 'create_file' : 'apply_patch', signal);
      if (expected) await this.current(file, expected, signal); else await this.allowedPath(file);
      authorize(operation === 'create' ? 'create_file' : 'apply_patch', this.hooks.mode()); check(signal);
      if (expected) await fs.rename(temporary, full);
      else await fs.link(temporary, full); // Fails if any destination appeared; never replaces it.
      this.applied(file, hash(bytes)); await this.persist(); this.index.invalidate(file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
}
