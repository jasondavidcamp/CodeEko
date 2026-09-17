import { GeminiClient } from './client';
import { taskProtocol } from '../protocol/actions';
import { performanceDiagnostics, RequestTiming } from '../state/performanceDiagnostics';

/** Synthetic fresh-chat requests only. Responses are discarded; no agent loop or tools run. */
export async function compareRequestTiming(client: GeminiClient, model: string, mode: string, signal: AbortSignal, progress: (message: string) => void) {
  await performanceDiagnostics.ready;
  const results: { pair: number; variant: 'minimal' | 'full'; timing?: RequestTiming }[] = [];
  for (let pair = 1; pair <= 3 && !signal.aborted; pair++) {
    const variants: ('minimal' | 'full')[] = pair % 2 ? ['minimal', 'full'] : ['full', 'minimal'];
    for (const variant of variants) {
      if (signal.aborted) break;
      progress(`Request ${results.length + 1}/6: ${variant === 'minimal' ? 'Minimal hello' : 'Full CodeEko hello'}`);
      let taskId: string | undefined;
      let succeeded = false;
      await performanceDiagnostics.task(async () => {
        taskId = performanceDiagnostics.snapshot().tasks.at(-1)?.taskId;
        try {
          if (variant === 'minimal') await client.completeMinimal(model, signal);
          else await client.complete(model, [{ role: 'system', content: taskProtocol(mode) }, { role: 'user', content: 'hello' }], signal);
          succeeded = true;
        } catch { /* Request diagnostics contain the sanitized outcome; continue unless cancelled. */ }
      }, () => signal.aborted ? 'cancelled' : succeeded ? 'complete' : 'failed');
      const timing = performanceDiagnostics.snapshot().requests.find(r => r.taskId === taskId);
      results.push({ pair, variant, timing });
    }
  }
  return { comparisonVersion: 1, runtimeVersion: performanceDiagnostics.snapshot().runtimeVersion, cancelled: signal.aborted,
    description: 'Six synthetic fresh-chat hello requests; identical client settings; only message content differs. No repository context or tools. Response bodies are discarded.', results };
}
