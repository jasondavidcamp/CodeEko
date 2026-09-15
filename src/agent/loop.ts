import { Message } from '../api/client';
import { authorize, check, TaskConflict, ReadRequired } from '../policy/boundary';
import { parseAction, taskProtocol, Action } from '../protocol/actions';
export interface Model { complete(model: string, messages: Message[], signal?: AbortSignal): Promise<string> }
export interface ToolExecutor { execute(action: Action, signal: AbortSignal): Promise<unknown>; beforeComplete?(signal: AbortSignal): Promise<unknown | undefined> }
export const limits = { turns: 20, contextCharacters: 60000, resultCharacters: 14000, totalReadFiles: 30 };
export async function runAgent(model: Model, selectedModel: string, history: Message[], tools: ToolExecutor, mode: () => string, signal: AbortSignal, progress: (text: string) => void): Promise<string> {
  const messages: Message[] = [{ role: 'system', content: taskProtocol(mode()) }, ...history.slice(-20)]; let readCount = 0; let protocolCorrections = 0; let readCorrections = 0;
  for (let turn = 0; turn < limits.turns; turn++) {
    check(signal);
    const characters = messages.reduce((sum, m) => sum + m.content.length, 0);
    if (characters > limits.contextCharacters) throw new Error('Context limit reached. Start a narrower follow-up.');
    progress(`Considering next step (${turn + 1}/${limits.turns}; ${characters} context characters).`);
    const raw = await model.complete(selectedModel, messages, signal); check(signal);
    let action: Action;
    try { action = parseAction(raw); }
    catch (error) {
      // Retry once inside the existing turn/context budgets; never execute or coerce invalid JSON.
      if (protocolCorrections++ >= 1 || raw.length > 20000) throw error;
      progress('Requesting one protocol correction; no tool was executed.');
      messages.push({ role: 'assistant', content: raw }, { role: 'user', content: 'The previous response failed the strict action schema. No tool was executed. Return one valid action with exactly these top-level keys: "version":1 (required numeric value), "tool", and "args". For example: {"version":1,"tool":"list_files","args":{}}. Use only the permitted tools and arguments from the system instructions.' });
      continue;
    }
    authorize(action.tool, mode());
    if (action.tool === 'complete_task') {
      const validation = await tools.beforeComplete?.(signal); check(signal);
      if (validation === undefined) return action.args.summary;
      progress('Validation found failures. Requesting a bounded repair.');
      messages.push({ role: 'assistant', content: raw }, { role: 'user', content: JSON.stringify({ version: 1, tool: 'run_validation', result: validation }).slice(0, limits.resultCharacters) + '\nCompletion is blocked by validation failures. Read the relevant files and make a focused repair. Do not weaken tests to conceal incorrect behavior. At most three validation rounds are allowed.' });
      continue;
    }
    readCount += action.tool === 'read_files' ? (action.args as { paths: string[] }).paths.length : action.tool === 'read_file' ? 1 : 0;
    if (readCount > limits.totalReadFiles) throw new Error('Task file-read limit reached.');
    progress(`Running ${action.tool.replaceAll('_', ' ')}.`);
    let result: unknown;
    try { result = await tools.execute(action, signal); } catch (error) {
      check(signal);
      if (error instanceof ReadRequired) {
        if (++readCorrections > 2) throw new TaskConflict('Stopped after two read/hash corrections. No edit was applied for the rejected attempts.');
        progress(`A fresh read of ${error.file} is required before retrying the edit (${readCorrections}/2).`);
        result = { error: 'read_required', path: error.file, instruction: 'No edit was applied. Call read_file for this path now, then copy its exact returned hash into expectedHash. Earlier conversation summaries and validation results do not count as a file read.' };
      } else {
        if (error instanceof TaskConflict) throw error;
        result = { error: 'Tool could not complete within repository policy. Re-read the file and check the exact arguments. No successful mutation is implied by this error.' };
      }
    }
    check(signal);
    const serialized = JSON.stringify(result);
    messages.push({ role: 'assistant', content: raw }, { role: 'user', content: JSON.stringify({ version: 1, tool: action.tool, result: serialized.length <= limits.resultCharacters ? result : { truncated: true, text: serialized.slice(0, limits.resultCharacters) } }) });
  }
  throw new Error('Task reached the 20-action limit. Narrow the request and try again.');
}
