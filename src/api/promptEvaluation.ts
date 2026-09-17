import { createHash } from 'node:crypto';
import { GeminiClient, Message } from './client';
import { fullProtocolBaseline } from './fullProtocolBaseline';
import { runAgent, ToolExecutor } from '../agent/loop';
import { AgentPrompt, ProgressivePrompt } from '../protocol/prompt';
import { ReadRequired, TaskConflict, check } from '../policy/boundary';
import { RequestTiming } from '../state/performanceDiagnostics';

type Scenario = 'greeting' | 'question' | 'read' | 'follow-up-edit' | 'conversation-after-edit';
type Variant = 'full' | 'progressive';
export const workflowScenarios: readonly Scenario[] = ['greeting', 'question', 'read', 'follow-up-edit', 'conversation-after-edit'];
const original = '# Keep this developer comment.\nfunction Get-Value { return 41 }\n';
const expected = original.replace('return 41', 'return 42');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function historyFor(scenario: Scenario): Message[] {
  switch (scenario) {
    case 'greeting': return [{ role: 'user', content: 'hey' }];
    case 'question': return [{ role: 'user', content: 'Before we start, ask me whether I want a brief or detailed explanation, then acknowledge my choice. Do not inspect the repository.' }];
    case 'read': return [{ role: 'user', content: 'Read main.ps1 and tell me the number Get-Value returns. Do not edit anything.' }];
    case 'follow-up-edit': return [
      { role: 'user', content: 'Change Get-Value in main.ps1 to return 42. Preserve its name and the developer comment. Do not create files or commit.' },
      { role: 'assistant', content: 'I will read the current file and update that return value, preserving the name and comment.' },
      { role: 'user', content: 'What does a return value mean?' },
      { role: 'assistant', content: 'It is the value a function sends back to its caller.' },
      { role: 'user', content: 'Go ahead.' }
    ];
    case 'conversation-after-edit': return [
      { role: 'user', content: 'Change Get-Value to return 42 and preserve the developer comment.' },
      { role: 'assistant', content: 'Updated main.ps1; validation passed. The change is available for review and task undo.' },
      { role: 'user', content: 'Thanks! Just explain what a return value means. No more repository work.' }
    ];
  }
}

/** Deliberately narrow fixture, not a production executor or a PowerShell validation sandbox. */
function fixture(scenario: Scenario) {
  let source = scenario === 'conversation-after-edit' ? expected : original;
  const starting = source;
  let readHash: string | undefined;
  let reads = 0, edits = 0, validations = 0, questions = 0, violations = 0;
  const actions: string[] = [];
  const deny = (): never => { violations++; throw new TaskConflict('Action outside the synthetic scenario.'); };
  const validate = () => {
    if (++validations > 3) throw new TaskConflict('Synthetic validation round limit.');
    return { status: source === expected ? 'passed' : 'failed', steps: [{ command: 'fixture-content-check', status: source === expected ? 'passed' : 'failed', detail: { failures: source === expected ? [] : [{ message: 'Get-Value must return 42 and preserve the original function name and developer comment.' }] } }] };
  };
  const tools: ToolExecutor = {
    execute: async (action, signal) => {
      check(signal); actions.push(action.tool);
      if (action.tool === 'ask_user' && scenario === 'question') { questions++; return { answer: 'Brief, please.' }; }
      if (scenario !== 'read' && scenario !== 'follow-up-edit') return deny();
      switch (action.tool) {
        case 'list_files': return { files: ['main.ps1'], truncated: false };
        case 'git_status': return { entries: [] };
        case 'read_file': case 'read_files': {
          const paths = action.tool === 'read_file' ? [action.args.path] : action.args.paths;
          if (paths.some(path => path !== 'main.ps1')) return deny();
          reads++; readHash = hash(source);
          const result = { path: 'main.ps1', text: source, hash: readHash, startLine: 1, endLine: 2, totalLines: 2, truncated: false };
          return action.tool === 'read_file' ? result : [result];
        }
        case 'apply_patch': {
          if (scenario !== 'follow-up-edit' || action.args.path !== 'main.ps1') return deny();
          if (!readHash || action.args.expectedHash && action.args.expectedHash !== readHash) throw new ReadRequired('main.ps1');
          if (hash(source) !== readHash) return deny();
          // Reject ambiguous/overlapping targets before changing this in-memory fixture.
          const ranges = action.args.edits.map(edit => {
            const at = edit.oldText ? source.indexOf(edit.oldText) : -1;
            if (at < 0 || source.indexOf(edit.oldText, at + 1) >= 0) return deny();
            return { at, end: at + edit.oldText.length, text: edit.newText };
          }).sort((a, b) => a.at - b.at);
          if (ranges.some((range, i) => i > 0 && range.at < ranges[i - 1].end)) return deny();
          for (const range of ranges.reverse()) source = source.slice(0, range.at) + range.text + source.slice(range.end);
          edits++; readHash = undefined;
          return { applied: true, hash: hash(source) };
        }
        case 'run_validation': if (scenario === 'follow-up-edit') return validate(); else return deny();
        default: return deny();
      }
    },
    beforeComplete: async signal => {
      check(signal);
      if (scenario !== 'follow-up-edit' || !edits) return undefined;
      const report = validate(); return report.status === 'failed' ? report : undefined;
    }
  };
  return { tools, results: (answer: string) => {
    const checks = {
      nonemptyAnswer: !!answer.trim(),
      allowedActions: violations === 0,
      expectedInteraction: scenario === 'question' ? questions === 1 && /brief/i.test(answer)
        : scenario === 'read' ? reads > 0 && /\b41\b/.test(answer)
        : scenario === 'follow-up-edit' ? reads > 0 && edits > 0 && validations > 0
        : actions.length === 0,
      expectedContents: source === (scenario === 'follow-up-edit' ? expected : starting)
    };
    return { checks, checksPassed: Object.values(checks).every(Boolean), actions, reads, edits, validations, questions };
  } };
}

export async function comparePromptWorkflows(client: GeminiClient, model: string, mode: string, signal: AbortSignal, progress: (message: string) => void) {
  const results = [];
  const scenarios = workflowScenarios.filter(s => s !== 'follow-up-edit' || ['Workspace', 'Full access'].includes(mode));
  for (const [index, scenario] of scenarios.entries()) {
    const order: Variant[] = index % 2 ? ['progressive', 'full'] : ['full', 'progressive'];
    for (const variant of order) {
      if (signal.aborted) break;
      progress(`Workflow ${scenario}: ${variant}`);
      const state = fixture(scenario), timings: RequestTiming[] = [];
      let calls = 0, repairs = 0, answer = '';
      let outcome: 'complete' | 'stopped' | 'cancelled' = 'stopped';
      const started = performance.now();
      const prompt: AgentPrompt = variant === 'full' ? { render: fullProtocolBaseline, observe: () => {} } : new ProgressivePrompt();
      try {
        answer = await runAgent({ complete: async (selected, messages, abort, repair, onContent) => {
          // One scenario cannot spend the entire production turn budget on repairs.
          if (calls >= 8) throw new TaskConflict('Synthetic model-call limit.');
          calls++; if (repair) repairs++;
          return client.complete(selected, messages, abort, repair, onContent, timing => timings.push(timing));
        } }, model, historyFor(scenario), state.tools, () => mode, signal, () => {}, undefined, prompt);
        outcome = 'complete';
      } catch { outcome = signal.aborted ? 'cancelled' : 'stopped'; }
      const evidence = state.results(answer);
      results.push({ scenario, variant, outcome, modelCalls: calls, repairCalls: repairs,
        elapsedMs: Math.round(performance.now() - started), ...evidence, checksPassed: outcome === 'complete' && evidence.checksPassed,
        totalRequestBytes: timings.reduce((sum, timing) => sum + (timing.requestBytes ?? 0), 0),
        totalPromptCharacters: timings.reduce((sum, timing) => sum + (timing.promptCharacters ?? 0), 0), timings });
    }
    if (signal.aborted) break;
  }
  return { description: 'One run per prompt/scenario with alternating order and at most eight model calls each. In-memory fixtures check actions, continuity, preserved source and simulated validation. No real files or commands execute. No response text is exported. Passing checks do not establish general answer quality or real PowerShell compatibility.',
    allChecksPassed: results.length === scenarios.length * 2 && results.every(r => r.checksPassed), results };
}
