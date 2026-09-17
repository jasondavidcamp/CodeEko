import { commitRevision } from '../repository/history';
import { z } from 'zod';
const path = z.string().min(1).max(500);
const query = z.string().min(1).max(200);
const action = <N extends string, T extends z.ZodRawShape>(tool: N, args: T) => z.object({ version: z.literal(1), tool: z.literal(tool), args: z.object(args).strict() }).strict();
const expectedHash = z.string().regex(/^[a-f0-9]{64}$/);
export const actionSchema = z.union([
  action('list_files', { query: query.optional() }), action('search_text', { query }),
  action('find_symbol', { query }), action('read_file', { path, startLine: z.number().int().min(1).max(100000).optional(), endLine: z.number().int().min(1).max(100000).optional() }),
  action('read_files', { paths: z.array(path).min(1).max(5) }), action('git_status', {}), action('git_show_commit', { revision: z.string().regex(commitRevision).optional() }),
  action('ask_user', { question: z.string().min(1).max(1000) }), action('complete_task', { summary: z.string().min(1).max(12000) }),
  action('apply_patch', { path, expectedHash: expectedHash.optional(), edits: z.array(z.object({ oldText: z.string().max(12000), newText: z.string().max(12000), replaceAll: z.boolean().optional() }).strict()).min(1).max(10) }),
  action('create_file', { path, content: z.string().max(16000) }),
  action('delete_file', { path, expectedHash }), action('move_file', { path, destination: path, expectedHash }),
  action('git_commit', { message: z.string().trim().min(1).max(2000), paths: z.array(path).min(1).max(24) }),
  action('git_diff_summary', {}), action('open_diff', { path: path.optional() }), action('run_validation', {})
]);
export type Action = z.infer<typeof actionSchema>;
export class ActionFormatError extends Error {
  constructor(readonly hint: string) { super('The model sent a response the extension could not use. The rejected response made no changes.'); }
}
const escapedActionHint = 'The action is JSON-escaped instead of a JSON object. Encode the action exactly once: start with {"version":1,"tool": and use ordinary double quotes around object keys. Do not escape the entire object or wrap it in a string. Escape quotes, backslashes and newlines only inside string values such as args.content. Regenerate the action from the original task and current file evidence; do not change the intended source text.';
export function parseAction(raw: string): Action {
  if (raw.length > 20000) throw new Error('Action exceeds response limit.');
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch {
    if (/^\s*\{\s*\\+"/.test(raw)) throw new ActionFormatError(escapedActionHint);
    throw new ActionFormatError('Return a single valid JSON object without markdown or surrounding text.');
  }
  if (typeof value === 'string') throw new ActionFormatError(escapedActionHint);
  const candidate = value as { tool?: unknown } | null;
  const schema = actionSchema.options.find(option => option.shape.tool.value === candidate?.tool);
  if (!schema) throw new ActionFormatError('Use a supported tool with version: 1 and args; use complete_task with args.summary for a final answer.');
  const result = schema.safeParse(value);
  if (!result.success) throw new ActionFormatError('Correct these action fields: ' + result.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'action'} (${issue.code})`).join(', ') + '. Follow the tool schema exactly; do not add extra fields.');
  return result.data;
}
export { taskProtocol } from './prompt';
