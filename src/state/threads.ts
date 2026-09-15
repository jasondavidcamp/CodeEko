import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
const turn = z.object({ role: z.enum(['user','assistant']), content: z.string().max(16000) });
const thread = z.object({ id: z.string().uuid(), name: z.string().min(1).max(100), messages: z.array(turn).max(100), activity: z.array(z.object({ at: z.string(), event: z.string().max(1000) })).max(500).default([]), taskId: z.string().uuid().optional(), reviewTaskId: z.string().uuid().optional(), undoTaskId: z.string().uuid().optional(), status: z.enum(['idle','running','complete','cancelled','failed','interrupted','blocked']) });
const state = z.object({ version: z.literal(1), threads: z.array(thread).max(100) });
export type Thread = z.infer<typeof thread>;
export function repositoryStorage(storage: string, root: string): string { return path.join(storage, createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex')); }
export class ThreadStore {
  threads: Thread[] = [];
  constructor(private directory: string) {}
  async load(): Promise<void> {
    try {
      const file = path.join(this.directory, 'threads.json');
      if ((await fs.stat(file)).size > 20000000) throw new Error('Thread store exceeds size limit.');
      this.threads = state.parse(JSON.parse(await fs.readFile(file, 'utf8'))).threads;
      this.threads.forEach(t => { if (t.status === 'running') { t.status = 'interrupted'; t.reviewTaskId = t.taskId ?? t.reviewTaskId; t.undoTaskId = t.taskId ?? t.undoTaskId; } });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Thread history could not be loaded; existing data was preserved.'); }
  }
  create(name: string): Thread {
    if (this.threads.length >= 100) throw new Error('Thread limit reached (100).');
    const t: Thread = { id: randomUUID(), name: name.trim().slice(0, 100) || 'New conversation', messages: [], activity: [], status: 'idle' }; this.threads.push(t); return t;
  }
  async save(): Promise<void> {
    this.threads.forEach(t => { t.messages = t.messages.slice(-100); t.activity = t.activity.slice(-500); });
    const serialized = JSON.stringify(state.parse({ version: 1, threads: this.threads }));
    if (Buffer.byteLength(serialized, 'utf8') > 20000000) throw new Error('Thread store reached the 20 MB limit. Existing on-disk history was preserved.');
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, 'threads.' + randomUUID() + '.tmp');
    await fs.writeFile(temporary, serialized, { mode: 0o600 });
    await fs.rename(temporary, path.join(this.directory, 'threads.json'));
  }
}
