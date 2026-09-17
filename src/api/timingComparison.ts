import { createHash } from 'node:crypto';
import { GeminiClient, Message } from './client';
import { parseAction, taskProtocol } from '../protocol/actions';
import { performanceDiagnostics, RequestTiming } from '../state/performanceDiagnostics';
import { fullProtocolBaseline } from './fullProtocolBaseline';
import { comparePromptWorkflows } from './promptEvaluation';

export const comparisonInstruction = 'Reply with exactly this JSON object, with no other text: {"version":1,"tool":"complete_task","args":{"summary":"Hello"}}';
type Variant = 'compact' | 'compact-wrapped' | 'full' | 'full-provider-limit' | 'progressive';
type Result = { round: number; variant: Variant; messageDigest: string; outputLimit: 4096 | 'provider-default';
  reply: 'expected' | 'empty' | 'unexpected' | 'request-failed'; timing?: RequestTiming };
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null;
};

/** Synthetic timing controls followed by agent-loop checks using in-memory tools only. */
export async function compareRequestTiming(client: GeminiClient, model: string, mode: string, signal: AbortSignal, progress: (message: string) => void) {
  await performanceDiagnostics.ready;
  const compact: Message[] = [{ role: 'user', content: comparisonInstruction }];
  const full = client.formatMessages([{ role: 'system', content: fullProtocolBaseline(mode) }, ...compact]);
  const messages: Record<Variant, Message[]> = {
    compact, 'compact-wrapped': client.formatMessages(compact), full, 'full-provider-limit': full,
    progressive: client.formatMessages([{ role: 'system', content: taskProtocol(mode) }, ...compact])
  };
  const orders: Variant[][] = [
    ['compact', 'compact-wrapped', 'full', 'progressive', 'full-provider-limit'],
    ['full-provider-limit', 'progressive', 'full', 'compact-wrapped', 'compact'],
    ['compact-wrapped', 'full-provider-limit', 'compact', 'full', 'progressive']
  ];
  const results: Result[] = [];
  for (let round = 0; round < orders.length && !signal.aborted; round++) {
    for (const variant of orders[round]) {
      if (signal.aborted) break;
      progress(`Timing control ${results.length + 1}/15: ${variant}`);
      const cap = variant === 'full-provider-limit' ? null : 4096;
      const result: Result = { round: round + 1, variant, outputLimit: cap ?? 'provider-default',
        messageDigest: createHash('sha256').update(JSON.stringify(messages[variant])).digest('hex'), reply: 'request-failed' };
      try {
        const text = await client.probe(model, messages[variant], cap, signal, timing => { result.timing = timing; });
        result.reply = text.trim() ? 'unexpected' : 'empty';
        if (text.trim()) {
          try {
            const action = parseAction(text);
            if (action.tool === 'complete_task' && action.args.summary === 'Hello') result.reply = 'expected';
          } catch { /* Record invalid output without exporting it or requesting a repair. */ }
        }
      } catch { /* Timing retains sanitized failure evidence; failed requests are never retried. */ }
      results.push(result);
    }
  }
  const summary = (Object.keys(messages) as Variant[]).map(variant => {
    const rows = results.filter(r => r.variant === variant);
    const valid = rows.filter(r => r.reply === 'expected' && r.timing?.outcome === 'success');
    return { variant, attempted: rows.length, validReplies: valid.length,
      emptyReplies: rows.filter(r => r.reply === 'empty').length,
      unexpectedReplies: rows.filter(r => r.reply === 'unexpected').length,
      failedRequests: rows.filter(r => r.reply === 'request-failed').length,
      medianRequestBytes: median(rows.flatMap(r => r.timing?.requestBytes === undefined ? [] : [r.timing.requestBytes])),
      medianPromptCharacters: median(rows.flatMap(r => r.timing?.promptCharacters === undefined ? [] : [r.timing.promptCharacters])),
      medianFirstContentMs: median(valid.flatMap(r => r.timing?.firstContentMs === undefined ? [] : [r.timing.firstContentMs])),
      medianElapsedMs: median(valid.flatMap(r => r.timing?.elapsedMs === undefined ? [] : [r.timing.elapsedMs])) };
  });
  const workflows = await comparePromptWorkflows(client, model, mode, signal, progress);
  return { comparisonVersion: 3, baseline: 'full-protocol-0.4.57', candidate: 'progressive-v1', runtimeVersion: performanceDiagnostics.snapshot().runtimeVersion, cancelled: signal.aborted,
    description: 'Fifteen controls ask for identical complete_task Hello JSON. Full is the frozen pre-reduction protocol; progressive is the current first-request prompt. Compare these for prompt effects; other controls isolate wrapping/output limits. Same client/model/temperature/streaming. Workflow checks then compare both prompts with synthetic in-memory tools and bounded real agent loops, including repairs. No repository access, processes or user questions. Checks verify fixture outcomes, not general response quality. Only valid controls enter latency medians.',
    allRepliesValid: results.length === 15 && summary.every(r => r.validReplies === 3), summary, results, workflows };
}
