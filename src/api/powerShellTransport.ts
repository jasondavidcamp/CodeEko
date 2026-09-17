import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { powerShellProbeScript } from './powerShellProbeScript';

const count = z.number().finite().nonnegative().max(1e12);
const version = z.string().regex(/^\d+(?:\.\d+){1,3}$/);
const ready = z.object({ type: z.literal('ready'), version, clrVersion: version, useProxy: z.boolean(), checkCertificateRevocationList: z.boolean() });
const done = z.object({ type: z.literal('done'), headersMs: count, firstBodyByteMs: count.nullable(), elapsedMs: count, bodyBytes: count });
const failure = z.object({ type: z.literal('failure'), stage: z.enum(['request','body-read']), reason: z.enum(['transport','body-limit','unsupported-encoding']), timeout: z.boolean(), socketCodes: z.array(count).max(8), elapsedMs: count });
export type PowerShellMeasurement = Partial<z.infer<typeof done>> & { httpVersion?: '1.0' | '1.1' | '2.0' | '3.0'; failure?: z.infer<typeof failure> };

/** A single owned HttpClient reused for the comparison; no command or process tool is exposed. */
export class PowerShellTransport {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (response: Response) => void; reject: (error: Error) => void; controller?: ReadableStreamDefaultController<Uint8Array>; cancelled?: boolean; cleanup: () => void };
  private buffer = '';
  private received = 0;
  private stopped = false;
  private startup?: { resolve: () => void; reject: (error: Error) => void };
  private exit: Promise<void> = Promise.resolve();
  private completed: Promise<void> = Promise.resolve();
  private finish?: () => void;
  metadata?: Omit<z.infer<typeof ready>, 'type'>;
  measurement: PowerShellMeasurement = {};
  get usable(): boolean { return !this.stopped && !!this.metadata; }
  async settled(): Promise<void> { await this.completed; }
  constructor(private executable: string, private timeoutMs: number, private script = powerShellProbeScript) {}
  static async available(): Promise<string | undefined> {
    if (process.platform !== 'win32') return undefined;
    const candidates = [path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'PowerShell/7/pwsh.exe'),
      path.join(process.env.SystemRoot ?? 'C:/Windows', process.arch === 'ia32' ? 'Sysnative' : 'System32', 'WindowsPowerShell/v1.0/powershell.exe')];
    for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
    return undefined;
  }
  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.child || this.stopped) throw new Error('Diagnostic worker cannot be restarted.');
    const waiting = new Promise<void>((resolve, reject) => { this.startup = { resolve, reject }; });
    const abort = () => this.stop();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const child = this.child = spawn(this.executable, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand', Buffer.from(this.script, 'utf16le').toString('base64')],
        { windowsHide: true, cwd: os.tmpdir(), stdio: ['pipe','pipe','pipe'] });
      this.exit = new Promise(resolve => child.once('close', () => { this.stop(); resolve(); }));
      child.on('error', () => this.stop());
      child.stdin.on('error', () => this.stop());
      child.stderr.on('data', () => { /* Never forward stderr: shell errors can contain request data. */ });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        this.buffer += data;
        if (this.buffer.length > 2000000) { this.stop(); return; }
        let end: number;
        while ((end = this.buffer.indexOf('\n')) >= 0 && !this.stopped) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          try { this.record(JSON.parse(line)); } catch { this.stop(); }
        }
      });
      await waiting;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  private record(value: any): void {
    if (value?.type === 'ready' && this.startup) {
      const { type, ...metadata } = ready.parse(value); this.metadata = metadata;
      this.startup.resolve(); this.startup = undefined; return;
    }
    const pending = this.pending;
    if (!pending) throw new Error('Unexpected worker record.');
    if (value?.type === 'headers' && !pending.controller) {
      if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599) throw new Error('Invalid status.');
      if (['1.0','1.1','2.0','3.0'].includes(value.httpVersion)) this.measurement.httpVersion = value.httpVersion;
      this.measurement.headersMs = count.parse(value.headersMs);
      const headers = new Headers();
      for (const name of ['Content-Type','Content-Encoding','Content-Length','Transfer-Encoding']) {
        if (typeof value.headers?.[name] === 'string' && value.headers[name].length < 1000) headers.set(name, value.headers[name]);
      }
      // Like fetch, expose decoded bytes while retaining the observed headers.
      const body = new ReadableStream<Uint8Array>({ start(controller) { pending.controller = controller; }, cancel() { pending.cancelled = true; } });
      pending.resolve(new Response([204,205,304].includes(value.status) ? null : body, { status: value.status, headers }));
    } else if (value?.type === 'chunk' && pending.controller) {
      if (typeof value.data !== 'string' || value.data.length > 12000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error('Invalid chunk.');
      const bytes = Buffer.from(value.data, 'base64'); this.received += bytes.length;
      if (this.received > 1000000) throw new Error('Response limit.');
      if (!pending.cancelled) pending.controller.enqueue(bytes);
    } else if (value?.type === 'done') {
      if (!pending.controller) throw new Error('Body completed before headers.');
      const { type, ...timing } = done.parse(value); Object.assign(this.measurement, timing);
      if (!pending.cancelled) pending.controller?.close(); pending.cleanup(); this.pending = undefined; this.finish?.(); this.finish = undefined;
    } else if (value?.type === 'failure') {
      this.measurement.failure = failure.parse(value); this.stop();
    } else throw new Error('Unexpected worker record.');
  }
  readonly fetch: typeof fetch = async (input, init) => {
    if (this.stopped || !this.metadata || this.pending) throw new Error('Diagnostic worker is unavailable.');
    const url = new URL(String(input));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || init?.method !== 'POST' || typeof init.body !== 'string' || init.body.length > 40000) throw new Error('Invalid diagnostic request.');
    init.signal?.throwIfAborted();
    this.measurement = {}; this.received = 0;
    const headers = new Headers(init.headers), authorization = headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) throw new Error('Diagnostic authentication is missing.');
    this.completed = new Promise(resolve => { this.finish = resolve; });
    return new Promise<Response>((resolve, reject) => {
      const abort = () => this.stop();
      const timer = setTimeout(abort, this.timeoutMs + 2000);
      init.signal?.addEventListener('abort', abort, { once: true });
      this.pending = { resolve, reject, cleanup: () => { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); } };
      this.child!.stdin.write(JSON.stringify({ url: url.toString(), body: init.body, key: authorization.slice(7), timeoutMs: this.timeoutMs,
        encoding: headers.get('Accept-Encoding') === 'identity' ? 'identity' : 'default' }) + '\n');
    });
  };
  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const error = new Error('PowerShell diagnostic worker stopped.');
    this.startup?.reject(error); this.startup = undefined;
    const pending = this.pending; this.pending = undefined;
    if (pending) { pending.cleanup(); pending.reject(error); try { pending.controller?.error(error); } catch {} }
    this.finish?.(); this.finish = undefined;
    this.child?.stdin.destroy(); this.child?.kill(); this.buffer = '';
  }
  async close(): Promise<void> { this.stop(); await this.exit; }
}
