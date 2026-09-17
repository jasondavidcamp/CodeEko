import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { failureCodes } from '../api/failure';

const count = z.number().finite().nonnegative().max(1e12);
const outcome = z.enum(['pending', 'success', 'failed', 'cancelled', 'timeout', 'empty', 'missing-content', 'interrupted', 'blocked', 'complete']);
const version = z.string().regex(/^[a-zA-Z0-9.+-]{1,40}$/);
const model = z.string().regex(/^(?:models\/)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/);
const usageSchema = z.object({ promptTokens: count.optional(), completionTokens: count.optional(), totalTokens: count.optional() });
const rateSchema = z.object({ retryAfterSeconds: count.optional(), tokensMinuteLimit: count.optional(), tokensMinuteRemaining: count.optional(), tokensMinuteResetSeconds: count.optional(), requestsMinuteLimit: count.optional(), requestsMinuteRemaining: count.optional(), requestsMinuteResetSeconds: count.optional() });
const common = { sessionId: z.string().uuid(), runtimeVersion: version, at: z.string().datetime(), taskId: z.string().uuid().optional(), turn: count.optional() };
const requestSchema = z.object({
  ...common, id: count, operation: z.enum(['models', 'completion']), mode: z.enum(['Standard', 'User message']), timeoutMs: count, repair: z.boolean(), outcome,
  model: model.optional(), promptCharacters: count.optional(), messageCount: count.optional(), maxOutputTokens: count.optional(),
  firstContentMs: count.optional(), contentChunks: count.optional(), streamed: z.boolean().optional(), streamingRequested: z.boolean().optional(),
  firstBodyByteMs: count.optional(), firstSseEventMs: count.optional(), sseEvents: count.optional(),
  bodyBytes: count.optional(), bodyChunks: count.optional(), lastBodyByteMs: count.optional(), maxBodyGapMs: count.optional(),
  bodyChunkSamples: z.array(z.object({ atMs: count, bytes: count })).max(32).optional(),
  eventLoopDelayMaxMs: count.optional(), eventLoopDelayMeanMs: count.optional(), eventLoopSamples: count.optional(),
  responseShape: z.object({ selectedChoices: count, otherChoices: count, deltaTextCharacters: count, messageTextCharacters: count,
    alternateTextCharacters: count, reasoningCharacters: count, refusalCharacters: count, nonStringContentValues: count, toolCallEntries: count }).optional(),
  failureStage: z.enum(['request', 'body-read', 'body-parse']).optional(), failureCodes: z.array(z.enum(failureCodes)).max(8).optional(),
  elapsedMs: count.optional(), headersMs: count.optional(), status: count.optional(), usage: usageSchema.optional(), rateLimit: rateSchema.optional(),
  finishReason: z.enum(['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'MALFORMED_FUNCTION_CALL', 'function_call_filter: MALFORMED_FUNCTION_CALL', 'other']).optional()
});
const phases = ['index', 'baseline', 'history', 'inventory', 'tool', 'validation', 'completion-check', 'finalize'] as const;
const toolNames = ['list_files', 'read_file', 'read_files', 'search_text', 'find_symbol', 'git_status', 'git_diff_summary', 'git_show_commit', 'apply_patch', 'create_file', 'delete_file', 'move_file', 'open_diff', 'run_validation', 'git_commit', 'ask_user'] as const;
const phaseSchema = z.object({ ...common, id: z.string().uuid(), phase: z.enum(phases), tool: z.enum(toolNames).optional(), validationStatus: z.enum(['passed', 'failed', 'partial']).optional(), elapsedMs: count.optional(), outcome });
const taskSchema = z.object({ ...common, taskId: z.string().uuid(), elapsedMs: count.optional(), outcome });
export type RequestTiming = z.infer<typeof requestSchema>;
export type RequestMetadata = Partial<Pick<RequestTiming, 'model' | 'promptCharacters' | 'messageCount' | 'maxOutputTokens' | 'usage' | 'rateLimit' | 'finishReason'>>;
type Task = z.infer<typeof taskSchema>;
type Phase = z.infer<typeof phaseSchema>;
type Context = { taskId: string; turn?: number };
type StorageOperation = 'mkdir' | 'list' | 'stat' | 'read' | 'decode' | 'prune' | 'write' | 'rename' | 'clear';
type StorageError = { operation: StorageOperation; code: string; firstAt: string; lastAt: string; occurrences: number };

// Only explicitly allowed metadata is persisted, including when reading older local files.
export class PerformanceDiagnostics {
  private records: RequestTiming[] = [];
  private tasks: Task[] = [];
  private phases: Phase[] = [];
  private nextId = 0;
  private context = new AsyncLocalStorage<Context>();
  readonly sessionId = randomUUID();
  private runtimeVersion = 'unknown';
  private directory?: string;
  private pending: Promise<void> = Promise.resolve();
  private writeFailed = false;
  private storageErrors: StorageError[] = [];
  private storageFailure(operation: StorageOperation, error: unknown): void {
    this.writeFailed = true;
    const raw = (error as NodeJS.ErrnoException)?.code;
    const code = operation === 'decode' ? 'invalid-json' : ['EACCES','EPERM','ENOENT','ENOTDIR','EISDIR','ENOSPC','EDQUOT','EBUSY','EMFILE','ENFILE','EIO','EROFS','EEXIST'].includes(raw ?? '') ? raw! : 'unknown';
    const at = new Date().toISOString();
    const previous = this.storageErrors.find(item => item.operation === operation && item.code === code);
    if (previous) { previous.lastAt = at; previous.occurrences++; }
    else { this.storageErrors.push({ operation, code, firstAt: at, lastAt: at, occurrences: 1 }); this.storageErrors = this.storageErrors.slice(-20); }
  }
  private async io<T>(operation: StorageOperation, work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) { this.storageFailure(operation, error); throw error; }
  }
  ready: Promise<void> = Promise.resolve();
  configure(storage: string, runtimeVersion: string): Promise<void> {
    this.runtimeVersion = version.safeParse(runtimeVersion).success ? runtimeVersion : 'unknown';
    this.directory = path.join(storage, 'performance');
    this.ready = this.load(); return this.ready;
  }
  private async load(): Promise<void> {
    try {
      await this.io('mkdir', () => fs.mkdir(this.directory!, { recursive: true }));
      const names = (await this.io('list', () => fs.readdir(this.directory!))).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).sort();
      const files: { name: string; mtime: number }[] = [];
      for (const name of names.slice(-100)) {
        const stat = await this.io('stat', () => fs.lstat(path.join(this.directory!, name)));
        if (stat.isFile() && !stat.isSymbolicLink()) files.push({ name, mtime: stat.mtimeMs });
      }
      files.sort((a, b) => b.mtime - a.mtime);
      for (const [i, file] of files.entries()) {
        const filename = path.join(this.directory!, file.name);
        if (i >= 4 || Date.now() - file.mtime > 7 * 86400000) { await this.io('prune', () => fs.unlink(filename)); continue; }
        try {
          if ((await this.io('stat', () => fs.stat(filename))).size > 2000000) continue;
          const data = JSON.parse(await this.io('read', () => fs.readFile(filename, 'utf8')));
          if (data.version !== 2) continue;
          const load = <T extends { outcome: string }>(items: unknown, schema: z.ZodType<T>, max: number): T[] => !Array.isArray(items) ? [] : items.slice(-max).flatMap(item => {
            const result = schema.safeParse(item);
            return result.success ? [{ ...result.data, outcome: result.data.outcome === 'pending' ? 'interrupted' : result.data.outcome }] : [];
          });
          this.records.push(...load(data.requests, requestSchema, 100));
          this.tasks.push(...load(data.tasks, taskSchema, 100));
          this.phases.push(...load(data.phases, phaseSchema, 500));
        } catch (error) { if (error instanceof SyntaxError) this.storageFailure('decode', error); /* Diagnostics must not prevent chat. */ }
      }
      this.trim();
    } catch { this.writeFailed = true; }
  }
  private trim(): void {
    const recent = (item: { at: string }) => Date.parse(item.at) >= Date.now() - 7 * 86400000;
    this.records = this.records.filter(recent).sort((a,b) => a.at.localeCompare(b.at)).slice(-100);
    this.tasks = this.tasks.filter(recent).sort((a,b) => a.at.localeCompare(b.at)).slice(-100);
    this.phases = this.phases.filter(recent).sort((a,b) => a.at.localeCompare(b.at)).slice(-500);
  }
  private persist(): void {
    if (!this.directory) return;
    this.pending = this.pending.then(async () => {
      const report = this.snapshot();
      const current = { ...report, requests: report.requests.filter(x => x.sessionId === this.sessionId), tasks: report.tasks.filter(x => x.sessionId === this.sessionId), phases: report.phases.filter(x => x.sessionId === this.sessionId) };
      const target = path.join(this.directory!, this.sessionId + '.json');
      await this.io('write', () => fs.writeFile(target + '.tmp', JSON.stringify(current)));
      await this.io('rename', () => fs.rename(target + '.tmp', target));
    }).catch(() => { this.writeFailed = true; });
  }
  async flush(): Promise<void> { await this.ready; await this.pending; }
  private base() { return { sessionId: this.sessionId, runtimeVersion: this.runtimeVersion, at: new Date().toISOString(), ...this.context.getStore() }; }
  setTurn(turn: number): void { const context = this.context.getStore(); if (context) context.turn = turn; }
  async task<T>(run: () => Promise<T>, getOutcome: () => string): Promise<T> {
    await this.ready;
    const taskId = randomUUID(), started = performance.now();
    const record = taskSchema.parse({ ...this.base(), taskId, outcome: 'pending' });
    this.tasks.push(record); this.trim(); this.persist();
    return this.context.run({ taskId }, async () => {
      try { return await run(); }
      finally { record.elapsedMs = Math.round(performance.now() - started); record.outcome = outcome.safeParse(getOutcome()).success ? getOutcome() as Task['outcome'] : 'failed'; this.persist(); }
    });
  }
  async measure<T>(phase: Phase['phase'], run: () => Promise<T>, tool?: string): Promise<T> {
    const record = phaseSchema.parse({ ...this.base(), id: randomUUID(), phase, tool: toolNames.includes(tool as any) ? tool : undefined, outcome: 'pending' });
    const started = performance.now(); this.phases.push(record); this.trim(); this.persist();
    try { const result = await run(); record.outcome = 'success'; const status = (result as any)?.status; if (phase === 'validation' && ['passed', 'failed', 'partial'].includes(status)) record.validationStatus = status; return result; }
    catch (error) { record.outcome = 'failed'; throw error; }
    finally { record.elapsedMs = Math.round(performance.now() - started); this.persist(); }
  }
  begin(operation: RequestTiming['operation'], mode: string, timeoutMs: number, repair = false, metadata: RequestMetadata = {}): number {
    const id = ++this.nextId;
    this.records.push(requestSchema.parse({ ...metadata, ...this.base(), id, operation, mode, timeoutMs, repair, outcome: 'pending' }));
    this.trim(); this.persist(); return id;
  }
  finish(id: number, result: Partial<RequestTiming>): void {
    const record = this.records.find(record => record.id === id && record.sessionId === this.sessionId);
    if (record) { const safe = requestSchema.safeParse({ ...record, ...result }); if (safe.success) Object.assign(record, safe.data); }
    this.persist();
  }
  clear(): void {
    this.records = []; this.tasks = []; this.phases = [];
    if (this.directory) this.pending = this.pending.then(async () => {
      for (const name of await this.io('list', () => fs.readdir(this.directory!))) if (/^[a-f0-9-]{36}\.json(?:\.tmp)?$/.test(name)) await this.io('clear', () => fs.unlink(path.join(this.directory!, name)));
    }).catch(() => { this.writeFailed = true; });
  }
  snapshot(runtimeVersion = this.runtimeVersion) {
    this.trim();
    return structuredClone({ version: 2, runtimeVersion, sessionId: this.sessionId, writeFailed: this.writeFailed, storageErrors: this.storageErrors, scope: 'Latest 100 requests, 100 tasks and 500 phases; up to five sessions, seven days', requests: this.records, tasks: this.tasks, phases: this.phases });
  }
}
export const performanceDiagnostics = new PerformanceDiagnostics();

export function responseMetadata(data: any): RequestMetadata {
  const usage: Record<string, number> = {};
  for (const [source, target] of [['prompt_tokens', 'promptTokens'], ['completion_tokens', 'completionTokens'], ['total_tokens', 'totalTokens']]) {
    if (count.safeParse(data?.usage?.[source]).success) usage[target] = data.usage[source];
  }
  const reason = Array.isArray(data?.choices) ? data.choices.find((choice: any) => choice?.index === undefined || choice.index === 0)?.finish_reason : undefined;
  return { ...(Object.keys(usage).length ? { usage } : {}), ...(typeof reason === 'string' ? { finishReason: ['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'MALFORMED_FUNCTION_CALL', 'function_call_filter: MALFORMED_FUNCTION_CALL'].includes(reason) ? reason as RequestTiming['finishReason'] : 'other' } : {}) };
}
export function requestMetadata(modelId: string, key: string, messages: { content: string }[]): RequestMetadata {
  return { ...(model.safeParse(modelId).success && (!key || !modelId.includes(key)) ? { model: modelId } : {}), promptCharacters: messages.reduce((n, m) => n + m.content.length, 0), messageCount: messages.length, maxOutputTokens: 4096 };
}
export function rateMetadata(headers: Headers): RequestMetadata {
  const values: Record<string, number> = {};
  const retry = headers.get('retry-after');
  if (retry) { const seconds = /^\d+(\.\d+)?$/.test(retry) ? Number(retry) : Math.max(0, (Date.parse(retry) - Date.now()) / 1000); if (count.safeParse(seconds).success) values.retryAfterSeconds = Math.ceil(seconds); }
  for (const [header, field] of [['X-RateLimit-Limit-Tokens-Minute','tokensMinuteLimit'], ['X-RateLimit-Remaining-Tokens-Minute','tokensMinuteRemaining'], ['X-RateLimit-Reset-Tokens-Minute','tokensMinuteResetSeconds'], ['X-RateLimit-Limit-Requests-Minute','requestsMinuteLimit'], ['X-RateLimit-Remaining-Requests-Minute','requestsMinuteRemaining'], ['X-RateLimit-Reset-Requests-Minute','requestsMinuteResetSeconds']]) {
    const raw = headers.get(header); if (raw !== null && /^\d+(\.\d+)?$/.test(raw) && count.safeParse(Number(raw)).success) values[field] = Number(raw);
  }
  return Object.keys(values).length ? { rateLimit: values } : {};
}
