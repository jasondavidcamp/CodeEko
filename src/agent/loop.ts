import { Message } from '../api/client';
import { authorize, check } from '../policy/boundary';
import { parseAction, protocol, Action } from '../protocol/actions';
export interface Model { complete(model: string, messages: Message[], signal?: AbortSignal): Promise<string> }
export interface ToolExecutor { execute(action: Action, signal: AbortSignal): Promise<unknown> }
export const limits = { turns: 20, contextCharacters: 60000, resultCharacters: 14000, totalReadFiles: 30 };
export async function runAgent(model: Model, selectedModel: string, history: Message[], tools: ToolExecutor, mode: () => string, signal: AbortSignal, progress: (text: string) => void): Promise<string> {
  const messages: Message[] = [{ role: 'system', content: protocol }, ...history.slice(-20)]; let readCount = 0; let protocolCorrections = 0;
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
    if (action.tool === 'complete_task') return (action.args as { summary: string }).summary;
    readCount += action.tool === 'read_files' ? (action.args as { paths: string[] }).paths.length : action.tool === 'read_file' ? 1 : 0;
    if (readCount > limits.totalReadFiles) throw new Error('Task file-read limit reached.');
    progress(`Running ${action.tool.replaceAll('_', ' ')}.`);
    let result: unknown;
    try { result = await tools.execute(action, signal); } catch { check(signal); result = { error: 'Tool could not complete within the read-only repository policy. Try another readable path or narrower query.' }; }
    check(signal);
    const serialized = JSON.stringify(result);
    messages.push({ role: 'assistant', content: raw }, { role: 'user', content: JSON.stringify({ version: 1, tool: action.tool, result: serialized.length <= limits.resultCharacters ? result : { truncated: true, text: serialized.slice(0, limits.resultCharacters) } }) });
  }
  throw new Error('Task reached the 20-action limit. Narrow the request and try again.');
}
