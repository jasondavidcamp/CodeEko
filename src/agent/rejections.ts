import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { parseAction, ActionFormatError } from '../protocol/actions';

export interface RejectedResponse { raw: string; hint: string; attempt: number; requestKind: 'task' | 'format-repair' }
const recordSchema = z.object({
  version: z.literal(1), at: z.string(), runtimeVersion: z.string().max(100), model: z.string().max(200), permissionMode: z.string().max(30),
  raw: z.string().max(20000), hint: z.string().max(2000), attempt: z.number().int().min(1).max(3),
  requestKind: z.enum(['task', 'format-repair']), truncated: z.boolean()
}).strict();

/** Construct only when the developer enables diagnostics. No request headers or endpoints. */
export function rejectionRecorder(directory: string, runtimeVersion: string, model: string, permissionMode: () => string, redact: (text: string) => string) {
  let recorded = 0;
  return async (response: RejectedResponse): Promise<void> => {
    if (recorded++ >= 3) return;
    // Redact before truncating so a key cannot be cut into an unrecognized prefix.
    const raw = redact(response.raw);
    const record = recordSchema.parse({ version: 1, at: new Date().toISOString(), runtimeVersion: redact(runtimeVersion).slice(0, 100),
      model: redact(model).slice(0, 200), permissionMode: redact(permissionMode()).slice(0, 30), ...response,
      raw: raw.slice(0, 20000), hint: redact(response.hint).slice(0, 2000), truncated: raw.length > 20000 });
    await fs.mkdir(directory, { recursive: true });
    await fs.appendFile(path.join(directory, 'rejected-responses.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  };
}

/** Schema replay only: never runs actions, contacts a provider or accesses a repository. */
export async function replayRejections(file: string) {
  if ((await fs.stat(file)).size > 1000000) throw new Error('Rejected-response log exceeds replay limit.');
  const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
  if (lines.length > 3) throw new Error('Rejected-response log exceeds record limit.');
  return lines.map((line, index) => {
    const record = recordSchema.parse(JSON.parse(line));
    try {
      const action = parseAction(record.raw);
      return { record: index + 1, truncated: record.truncated, schemaValid: true, tool: action.tool, executed: false };
    } catch (error) {
      return { record: index + 1, truncated: record.truncated, schemaValid: false, reason: error instanceof ActionFormatError ? error.hint : 'Response exceeds schema limits.', executed: false };
    }
  });
}
