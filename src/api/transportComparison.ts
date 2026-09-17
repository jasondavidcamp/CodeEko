import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GeminiClient } from './client';
import { parseAction, taskProtocol } from '../protocol/actions';
import { performanceDiagnostics, RequestTiming } from '../state/performanceDiagnostics';
import { PowerShellTransport, PowerShellMeasurement } from './powerShellTransport';

const optionalBoolean = z.boolean().optional();
const version = z.string().regex(/^[0-9v][a-zA-Z0-9.+-]{0,39}$/).optional();
const environmentSchema = z.object({
  vscodeVersion: version, nodeVersion: version, electronVersion: version,
  host: z.enum(['local','remote']), platform: z.enum(['win32','linux','darwin','other']),
  electronFetch: optionalBoolean, fetchAdditionalSupport: optionalBoolean,
  proxySupport: z.enum(['off','on','fallback','override','unknown']), proxyConfigured: z.boolean(),
  proxyStrictSSL: optionalBoolean, systemCertificates: optionalBoolean,
  httpProxyEnvironment: z.boolean(), httpsProxyEnvironment: z.boolean(), noProxyEnvironment: z.boolean()
});
export type TransportEnvironment = z.infer<typeof environmentSchema>;
export function transportEnvironment(values: unknown): TransportEnvironment { return environmentSchema.parse(values); }
type Variant = 'vscode-default' | 'powershell-default' | 'vscode-identity' | 'powershell-identity';
type Result = { round: number; variant: Variant; at: string; reply: 'valid' | 'empty' | 'unexpected' | 'request-failed' | 'unavailable';
  requestDigest?: string; timing?: RequestTiming; workerTiming?: PowerShellMeasurement; headersToFirstBodyMs?: number };
export type ProbeWorker = Pick<PowerShellTransport, 'start' | 'fetch' | 'settled' | 'close' | 'metadata' | 'measurement' | 'usable'>;
const variants: Variant[] = ['vscode-default','powershell-default','vscode-identity','powershell-identity'];
const median = (items: number[]) => { const sorted = [...items].sort((a,b) => a-b), middle = Math.floor(sorted.length / 2); return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null; };

/** Opt-in, synthetic requests only. No repository access or returned action execution. */
export async function compareTransportTiming(client: GeminiClient, model: string, mode: string, environment: TransportEnvironment,
  signal: AbortSignal, progress: (message: string) => void,
  createWorker: () => Promise<ProbeWorker | undefined> = async () => {
    const executable = await PowerShellTransport.available();
    return executable ? new PowerShellTransport(executable, client.transportProbeSettings().timeoutMs) : undefined;
  }) {
  await performanceDiagnostics.ready;
  const startedAtUtc = new Date().toISOString();
  const messages = client.formatMessages([{ role: 'system', content: taskProtocol(mode) }, { role: 'user', content: 'hello' }]);
  const results: Result[] = [];
  let worker: ProbeWorker | undefined;
  let workerStatus: 'ready' | 'unavailable' | 'startup-failed' | 'stopped' | 'cancelled' = 'unavailable';
  let digest: string | undefined;
  let payloadMismatch = false;
  const abortWorker = () => { void worker?.close(); };
  signal.addEventListener('abort', abortWorker, { once: true });
  try {
    if (!signal.aborted) {
      try {
        worker = await createWorker();
        if (worker) { progress('Starting the PowerShell HTTP comparison worker'); await worker.start(signal); workerStatus = 'ready'; }
      } catch { workerStatus = signal.aborted ? 'cancelled' : 'startup-failed'; await worker?.close(); }
    }
    for (let round = 0; round < 5 && !signal.aborted && !payloadMismatch; round++) {
      // Rotate and reverse order: each client/compression combination runs both early and late.
      const rotated = [...variants.slice(round % 4), ...variants.slice(0, round % 4)];
      const order = round % 2 ? rotated.reverse() : rotated;
      for (const variant of order) {
        if (signal.aborted || payloadMismatch) break;
        const result: Result = { round: round + 1, variant, at: new Date().toISOString(), reply: 'request-failed' };
        const isPowerShell = variant.startsWith('powershell');
        if (isPowerShell && !worker?.usable) { result.reply = 'unavailable'; results.push(result); continue; }
        progress(`Transport request ${results.length + 1}/20: ${variant}`);
        const probe = client.forTransportProbe(variant.endsWith('identity') ? 'identity' : 'default', body => {
          result.requestDigest = createHash('sha256').update(body).digest('hex');
          digest ??= result.requestDigest;
          if (digest !== result.requestDigest) { payloadMismatch = true; throw new Error('Diagnostic request payload changed.'); }
        }, isPowerShell ? worker!.fetch : undefined);
        try {
          const text = await probe.probe(model, messages, 4096, signal, timing => { result.timing = timing; });
          result.reply = text.trim() ? 'unexpected' : 'empty';
          try { const action = parseAction(text); if (action.tool === 'complete_task' && action.args.summary.trim()) result.reply = 'valid'; } catch {}
        } catch { /* Only sanitized timing, never exceptions or response text, enters the report. */ }
        if (isPowerShell) { await worker!.settled(); result.workerTiming = structuredClone(worker!.measurement); }
        if (result.timing?.headersMs !== undefined && result.timing.firstBodyByteMs !== undefined) {
          result.headersToFirstBodyMs = Math.max(0, result.timing.firstBodyByteMs - result.timing.headersMs);
        }
        results.push(result);
        // Do not burn quota after authentication, policy or rate-limit rejection.
        if (result.timing?.status && [401,403,429].includes(result.timing.status)) break;
      }
      if (results.at(-1)?.timing?.status && [401,403,429].includes(results.at(-1)!.timing!.status!)) break;
    }
  } finally {
    signal.removeEventListener('abort', abortWorker);
    if (signal.aborted && worker) workerStatus = 'cancelled';
    else if (workerStatus === 'ready' && !worker?.usable) workerStatus = 'stopped';
    await worker?.close();
  }
  const summary = variants.map(variant => {
    const rows = results.filter(r => r.variant === variant), valid = rows.filter(r => r.reply === 'valid' && r.timing?.outcome === 'success');
    const numbers = (field: keyof RequestTiming) => valid.flatMap(r => typeof r.timing?.[field] === 'number' ? [r.timing[field] as number] : []);
    return { variant, scheduled: rows.length, attempted: rows.filter(r => r.reply !== 'unavailable').length, validReplies: valid.length,
      medianElapsedMs: median(numbers('elapsedMs')), medianHeadersMs: median(numbers('headersMs')), medianFirstBodyMs: median(numbers('firstBodyByteMs')),
      medianFirstContentMs: median(numbers('firstContentMs')), medianHeadersToFirstBodyMs: median(valid.flatMap(r => r.headersToFirstBodyMs === undefined ? [] : [r.headersToFirstBodyMs])) };
  });
  return { transportComparisonVersion: 1, runtimeVersion: performanceDiagnostics.snapshot().runtimeVersion, startedAtUtc, finishedAtUtc: new Date().toISOString(),
    cancelled: signal.aborted, completed: results.length === 20 && !signal.aborted && !payloadMismatch,
    description: 'Twenty fresh-chat hello requests, five per transport/compression variant. Same serialized request body, configured model/compatibility/permission prompt, temperature 0 and max_tokens 4096. Streaming is forced only for these probes; default and identity refer to Accept-Encoding. No retries, repository access or action execution. PowerShell uses an owned reused HttpClient and the shared action decoder; extension timings include IPC, workerTiming records native header/body timing. Startup is excluded. No claim of a cold connection/provider, identical HTTP stacks, or equivalent security policy. Medians include only valid complete_task replies. First body means data exposed to the reader, potentially after decompression; it is not packet arrival. DNS/TCP/TLS/certificate-check phases are not measured separately. No certificate or proxy settings are changed.',
    environment: transportEnvironment(environment), settings: { ...client.transportProbeSettings(), streamingRequested: true, rounds: 5, maxOutputTokens: 4096, temperature: 0 },
    powerShell: { status: workerStatus, ...worker?.metadata }, identicalSerializedBodies: !!digest && !payloadMismatch,
    allRepliesValid: results.length === 20 && summary.every(s => s.validReplies === 5), summary, results };
}
