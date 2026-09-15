import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export type StartupEvent = 'webview.bootstrap' | 'webview.main' | 'activate' | 'resolve' | 'visible' | 'dispose' | 'stage.begin' | 'stage.end' | 'stage.failed' | 'focus.begin' | 'focus.end' | 'focus.failed' | 'html' | 'ready' | 'state.sent' | 'state.delivered' | 'state.ack' | 'handshake.timeout' | 'webview.error' | 'deactivate' | 'activation.timeout';
type Fields = { view?: string; stage?: string; code?: string; source?: string; visible?: boolean; delivered?: boolean; elapsedMs?: number; folders?: number; trusted?: boolean; extensionVersion?: string; vscodeVersion?: string; pid?: number };
const events: StartupEvent[] = ['webview.bootstrap','webview.main','activate','resolve','visible','dispose','stage.begin','stage.end','stage.failed','focus.begin','focus.end','focus.failed','html','ready','state.sent','state.delivered','state.ack','handshake.timeout','webview.error','deactivate','activation.timeout'];
const stages = ['repository','lease.acquire','history','lease.release'];
const codes = ['service-worker','invalid-state','lease-unavailable','workspace-trust','history-unavailable','git-unavailable','cancelled','ENOENT','EACCES','EPERM','EADDRINUSE','unknown'];
const sources = ['automatic','command','script','promise','resource','csp','ready-missing','ack-missing'];
export function startupError(error: unknown): string {
  const value = error as { message?: unknown; code?: unknown };
  if (typeof value?.code === 'string' && codes.includes(value.code)) return value.code;
  const message = typeof value?.message === 'string' ? value.message : '';
  if (/service.?worker/i.test(message)) return 'service-worker';
  if (/invalid.?state/i.test(message)) return 'invalid-state';
  if (/lease|already open in another/i.test(message)) return 'lease-unavailable';
  if (/trust the workspace/i.test(message)) return 'workspace-trust';
  if (/history could not be loaded/i.test(message)) return 'history-unavailable';
  if (/Git failed/i.test(message)) return 'git-unavailable';
  if (/cancel/i.test(message)) return 'cancelled';
  return 'unknown';
}
// Only enumerated fields are persisted, never raw errors, stacks, paths or content.
function fields(input: Fields): Fields {
  const result: Fields = {};
  if (typeof input.view === 'string' && /^[a-f0-9-]{36}$/.test(input.view)) result.view = input.view;
  if (stages.includes(input.stage ?? '')) result.stage = input.stage;
  if (codes.includes(input.code ?? '')) result.code = input.code;
  if (sources.includes(input.source ?? '')) result.source = input.source;
  for (const key of ['visible','delivered','trusted'] as const) if (typeof input[key] === 'boolean') result[key] = input[key];
  for (const key of ['elapsedMs','folders','pid'] as const) if (Number.isFinite(input[key]) && input[key]! >= 0) result[key] = input[key];
  for (const key of ['extensionVersion','vscodeVersion'] as const) if (typeof input[key] === 'string' && /^[\w.+-]{1,64}$/.test(input[key]!)) result[key] = input[key];
  return result;
}
export class StartupDiagnostics {
  readonly session = randomUUID();
  readonly directory: string;
  private started = Date.now();
  private count = 0;
  private pending = Promise.resolve();
  private writeFailed = false;
  private filename: string;
  constructor(storage: string) {
    this.directory = path.join(storage, 'startup-diagnostics');
    this.filename = path.join(this.directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${this.session}.jsonl`);
    this.pending = this.prepare().catch(() => { this.writeFailed = true; });
  }
  private async prepare() {
    await fs.mkdir(this.directory, { recursive: true });
    const files = (await fs.readdir(this.directory)).filter(name => /^\d{4}-[\dTZ-]+-[a-f0-9-]{36}\.jsonl$/.test(name)).sort().reverse();
    for (const name of files.slice(19)) await fs.unlink(path.join(this.directory, name)).catch(() => {});
  }
  log(event: StartupEvent, detail: Fields = {}): void {
    if (!events.includes(event) || this.count++ >= 200) return;
    const line = JSON.stringify({ at: new Date().toISOString(), session: this.session, sinceMs: Date.now() - this.started, event, ...fields(detail) }) + '\n';
    this.pending = this.pending.then(() => fs.appendFile(this.filename, line, { mode: 0o600 })).catch(() => { this.writeFailed = true; });
  }
  async stage<T>(stage: string, view: string, work: () => Promise<T>): Promise<T> {
    const start = Date.now(); this.log('stage.begin', { stage, view });
    try { const result = await work(); this.log('stage.end', { stage, view, elapsedMs: Date.now() - start }); return result; }
    catch (error) { this.log('stage.failed', { stage, view, code: startupError(error), elapsedMs: Date.now() - start }); throw error; }
  }
  async flush(): Promise<void> { await this.pending; }
  async export(logUri?: string) {
    await this.flush();
    const names = (await fs.readdir(this.directory)).filter(name => /^\d{4}-[\dTZ-]+-[a-f0-9-]{36}\.jsonl$/.test(name)).sort().reverse().slice(0, 20);
    const launches: unknown[][] = [];
    for (const name of names) {
      const file = path.join(this.directory, name);
      if ((await fs.stat(file)).size > 128000) continue;
      const records: unknown[] = [];
      for (const line of (await fs.readFile(file, 'utf8')).split('\n').slice(0, 200)) {
        try {
          const entry = JSON.parse(line);
          if (events.includes(entry.event) && /^[a-f0-9-]{36}$/.test(entry.session) && /^\d{4}-[\dT:Z.-]+$/.test(entry.at)) records.push({ at: entry.at, session: entry.session, sinceMs: Number.isFinite(entry.sinceMs) ? entry.sinceMs : 0, event: entry.event, ...fields(entry) });
        } catch { /* Ignore an incomplete final line after a crash. */ }
      }
      launches.push(records);
    }
    return { version: 1, writeFailed: this.writeFailed, activationReason: 'VS Code does not expose the precise activation reason to activate(). Correlate resolve/focus events and host activation signatures.', launches, host: await hostSignatures(logUri) };
  }
}

// Export categories and timestamps only. Raw VS Code logs may contain private data.
async function hostSignatures(logUri?: string) {
  if (!logUri) return { available: false, entries: [] };
  const exthost = path.dirname(logUri), window = path.dirname(exthost), session = path.dirname(window);
  if (path.basename(exthost) !== 'exthost' || !/^window\d+$/.test(path.basename(window)) || !/^\d{8}T\d{6}$/.test(path.basename(session))) return { available: false, entries: [] };
  const entries: { at: string; category: string; source: string; launch: string }[] = [];
  try {
    const root = path.dirname(session);
    const sessions = (await fs.readdir(root)).filter(name => /^\d{8}T\d{6}$/.test(name)).sort().reverse().slice(0, 40);
    let windowedSessions = 0;
    for (const launch of sessions) {
      const windows = (await fs.readdir(path.join(root, launch))).filter(name => /^window\d+$/.test(name)).slice(0, 4);
      if (windows.length && ++windowedSessions > 3) break;
      for (const window of windows) for (const source of ['renderer.log','exthost/exthost.log']) {
        let handle;
        try {
          handle = await fs.open(path.join(root, launch, window, source), 'r');
          const size = (await handle.stat()).size, bytes = Buffer.alloc(Math.min(size, 65536));
          const read = await handle.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
          for (const line of bytes.subarray(0, read.bytesRead).toString('utf8').split('\n')) {
            const category = /service.?worker/i.test(line) ? 'service-worker' : /error.*webview|webview.*error/i.test(line) ? 'webview-error' : /_doActivateExtension internal-pilot\.llm-coding-agent-runtime/.test(line) ? (/onView/.test(line) ? 'activate-on-view' : /onStartupFinished/.test(line) ? 'activate-on-startup' : 'activate-other') : /error.*llm-coding-agent-runtime/i.test(line) ? 'extension-error' : undefined;
            if (category && entries.length < 200) entries.push({ at: /^\d{4}-\d{2}-\d{2} [\d:.]+/.exec(line)?.[0] ?? 'unknown', category, source, launch });
          }
        } catch { /* A source log may be unavailable or locked. */ }
        finally { await handle?.close(); }
      }
    }
    return { available: true, entries };
  } catch { return { available: false, entries }; }
}
