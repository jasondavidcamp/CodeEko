import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EditTask } from '../state/editTask';
import { authorize, check, safePath, TaskConflict } from '../policy/boundary';
import { PowerShellRunner, runPowerShell } from './powershell';
import { selectUnitTests, unitCandidates } from './selection';
import { git } from '../repository/git';
import { compareTests, completeObservation, TestObservation, testResults } from './testBaseline';

const diagnostic = z.object({ path: z.string(), line: z.number().nullable(), message: z.string(), rule: z.string(), severity: z.string() });
const diagnostics = z.object({ diagnostics: z.array(diagnostic).max(50), count: z.number().int().nonnegative() });
const inventory = z.object({ version: z.string(), modules: z.object({ Pester: z.string().nullable(), PSScriptAnalyzer: z.string().nullable() }) });
class NoProgress extends TaskConflict {}
export interface ValidationReport {
  round: number; fingerprint: string; status: 'passed' | 'failed' | 'partial';
  steps: { command: string; status: 'passed' | 'failed' | 'skipped'; detail: unknown }[];
}
export interface ValidationHooks {
  mode(): string;
  isDirty(file: string): boolean;
  /** Test harness override; production always uses source inspection. */
  selectTests?(candidates: string[], signal: AbortSignal): Promise<string[]>;
  installMissing(): boolean;
  pesterMajor?(): 4 | 5 | undefined;
  progress(message: string): void;
  redact(text: string): string;
}
export class TaskValidation {
  private reports: ValidationReport[] = [];
  private selected?: string[];
  private installationAttempted = false;
  private invalidated = false;
  private repeatedFailureReads = 0;
  private testBaseline?: TestObservation;
  constructor(private task: EditTask, private hooks: ValidationHooks, private runner: PowerShellRunner = runPowerShell) {}
  assertCanEdit(): void { if (this.reports.length >= 3) throw new TaskConflict('Three validation rounds have finished. Review the remaining results before starting another task.'); }
  invalidate(): void { this.invalidated = true; }
  hasRun(): boolean { return this.reports.length > 0; }
  summary(): string {
    const latest = this.reports.at(-1);
    if (!latest) return 'Validation has not run.';
    if (this.invalidated) return `Validation round ${latest.round}/3 is not current; validation was interrupted or repository state changed.`;
    const findings = latest.steps.flatMap(step => {
      const detail = step.detail as { diagnostics?: (z.infer<typeof diagnostic> & { origin?: string })[]; failures?: { name?: string | null; message?: string | null; origin?: string }[]; containerErrors?: string[]; comparison?: { resolved?: { name: string }[] } };
      if (detail?.diagnostics) return detail.diagnostics.map(item => `${item.path}:${item.line ?? 0} ${item.rule} (${item.origin ?? 'unknown origin'}): ${item.message}`);
      if (detail?.failures) return [...detail.failures.map(item => `${item.name ?? 'Test'} (${item.origin ?? 'unknown'}): ${item.message ?? 'Failed'}`), ...(detail.containerErrors ?? []), ...(detail.comparison?.resolved ?? []).map(item => `${item.name}: passed now; failed before edits.`)];
      return step.status === 'failed' ? [String(step.detail)] : [];
    }).slice(0, 5).map(text => text.slice(0, 500));
    return (`Validation round ${latest.round}/3: ${latest.status}. ` + latest.steps.map(step => `${step.command}: ${step.status}${step.status === 'skipped' ? ` (${String(step.detail)})` : ''}.`).join(' ') + (findings.length ? '\n' + findings.join('\n') : '')).slice(0, 4000);
  }
  private async snapshot(signal: AbortSignal) {
    await this.task.index.refresh(signal);
    const fingerprint = createHash('sha256');
    fingerprint.update(JSON.stringify({ pesterMajor: this.hooks.pesterMajor?.() ?? 'Auto', installMissing: this.hooks.installMissing() }));
    const head = await git(this.task.index.root, ['rev-parse','--verify','--quiet','HEAD'], signal, true);
    fingerprint.update(head);
    fingerprint.update(await git(this.task.index.root, ['diff','--cached','--no-ext-diff','--no-textconv','--no-color'], signal));
    const files: { path: string; text: string }[] = [];
    const hashes = new Map<string, string>();
    for (const name of [...this.task.index.entries.keys()].sort()) {
      const full = await safePath(this.task.index.root, name);
      if (this.hooks.isDirty(full)) throw new TaskConflict(`Save or discard unsaved changes to ${name} before validation.`);
      const document = await this.task.index.readDocument(name, signal, false);
      fingerprint.update(name).update('\0').update(document.hash);
      hashes.set(name, document.hash);
      if (/\.ps[md]?1$/i.test(name)) files.push({ path: name, text: document.text });
    }
    return { fingerprint: fingerprint.digest('hex'), files, hashes, startingState: this.task.matchesStartingState(hashes, head.trim() || null) };
  }
  async beforeComplete(signal: AbortSignal): Promise<ValidationReport | undefined> {
    if (!this.task.changes().length) return;
    const report = await this.run(signal);
    if (report.status === 'failed') {
      if (report.round >= 3) throw new TaskConflict('Validation still fails after three rounds. Changes are uncommitted. ' + this.summary());
      return report;
    }
  }
  async run(signal: AbortSignal): Promise<ValidationReport> {
    authorize('run_validation', this.hooks.mode()); check(signal);
    const snapshot = await this.snapshot(signal);
    const latest = this.reports.at(-1);
    if (latest?.fingerprint === snapshot.fingerprint) {
      this.invalidated = false;
      if (latest.status === 'failed' && ++this.repeatedFailureReads >= 2) throw new TaskConflict('Validation is unchanged and still failing. Stopped because no repair progress was made.');
      return latest;
    }
    this.repeatedFailureReads = 0;
    this.assertCanEdit();
    const report: ValidationReport = { round: this.reports.length + 1, fingerprint: snapshot.fingerprint, status: 'partial', steps: [] };
    let observedTests: TestObservation | undefined;
    this.reports.push(report);
    // Record the attempted round before launching a child process, including interrupted rounds.
    await this.save();
    const step = async (command: string, work: () => Promise<{ failed: boolean; detail: unknown }>, unavailable = false) => {
      authorize('run_validation', this.hooks.mode()); check(signal); this.hooks.progress(`Validation ${report.round}/3: ${command}.`);
      try { const result = await work(); report.steps.push({ command, status: result.failed ? 'failed' : 'passed', detail: JSON.parse(this.hooks.redact(JSON.stringify(result.detail))) }); }
      catch (error) { check(signal); if (error instanceof TaskConflict) throw error; report.steps.push({ command, status: unavailable ? 'skipped' : 'failed', detail: this.hooks.redact(error instanceof Error ? error.message : 'Validator unavailable.') }); }
    };
    try {
      let available: z.infer<typeof inventory> | undefined;
      const selection = { pesterMajor: this.hooks.pesterMajor?.() };
      await step('Detect Windows PowerShell 5.1 and modules', async () => { available = inventory.parse(await this.runner('inspect', selection, signal)); return { failed: false, detail: available }; }, true);
      if (!available) return report;
      const missing = Object.entries(available.modules).filter(([, version]) => !version).map(([name]) => name);
      if (missing.length && this.hooks.installMissing() && !this.installationAttempted) {
        this.installationAttempted = true;
        await step('Install missing modules from PSGallery (CurrentUser)', async () => {
          const result = z.object({ modules: z.array(z.object({ name: z.enum(['Pester','PSScriptAnalyzer']), installed: z.boolean(), reason: z.string().optional() })) }).parse(await this.runner('install', { names: missing, ...selection }, signal));
          available = inventory.parse(await this.runner('inspect', selection, signal));
          const failed = result.modules.filter(module => !module.installed);
          if (failed.length) throw new Error('Module installation incomplete: ' + failed.map(module => `${module.name}: ${module.reason ?? 'Installation failed.'}`).join(' '));
          return { failed: false, detail: result };
        }, true);
      }
      const changed = new Set(this.task.changes().map(change => change.path));
      const files = snapshot.files.filter(file => !changed.size || changed.has(file.path));
      if (files.length) {
        await step('PowerShell 5.1 Parser.ParseInput', async () => { const result = await this.sourceCheck('parse', files, undefined, signal); return { failed: result.count > 0, detail: result }; });
        // Module-qualified type resolution can import code; do not analyze those files automatically.
        const analyzable = files.filter(file => !/^\s*using\s+module\b|^\s*#requires\s+-modules?\b/im.test(file.text));
        if (analyzable.length !== files.length) report.steps.push({ command: 'PSScriptAnalyzer module-dependent files', status: 'skipped', detail: 'Module-loading directives require manual analysis.' });
        if (available.modules.PSScriptAnalyzer && analyzable.length) {
          await step('Invoke-ScriptAnalyzer (built-in rules)', async () => { const result = await this.sourceCheck('analyze', analyzable, available!.modules.PSScriptAnalyzer!, signal); return { failed: result.count > 0, detail: result }; });
        } else report.steps.push({ command: 'Invoke-ScriptAnalyzer', status: 'skipped', detail: 'Module unavailable or no eligible files.' });
      } else report.steps.push({ command: 'PowerShell parser and analyzer', status: 'skipped', detail: 'No changed PowerShell files.' });
      if (report.steps.some(item => item.status === 'failed')) {
        report.steps.push({ command: 'Invoke-Pester', status: 'skipped', detail: 'Repair parser/analyzer findings first.' });
      } else if (!available.modules.Pester) {
        report.steps.push({ command: 'Invoke-Pester', status: 'skipped', detail: 'Supported Pester 4 or 5 is unavailable.' });
      } else {
        const candidates = unitCandidates(snapshot.files);
        if (this.hooks.selectTests) {
          if (this.selected === undefined) this.selected = candidates.length ? await this.hooks.selectTests(candidates, signal) : [];
        } else {
          this.hooks.progress('Inspecting unit tests and local dependencies.');
          try {
            const selection = await selectUnitTests(snapshot.files, this.runner, signal);
            this.selected = selection.selected;
            for (const omitted of selection.skipped) report.steps.push({ command: `Unit test ${omitted.path}`, status: 'skipped', detail: omitted.reason });
            this.hooks.progress(this.selected.length ? `Running ${this.selected.length} automatically selected unit-test file(s): ${this.selected.slice(0, 5).join(', ')}.` : 'No unit tests eligible for automatic execution.');
          } catch (error) {
            check(signal);
            this.selected = [];
            report.steps.push({ command: 'Unit-test inspection', status: 'skipped', detail: this.hooks.redact(error instanceof Error ? error.message : 'Inspection unavailable.') });
          }
        }
        check(signal);
        if (this.selected.some(name => !candidates.includes(name) || /[\[\]]/.test(name))) throw new TaskConflict('Approved test files changed eligibility or contain unsupported wildcard characters. Start a new task to select tests again.');
        if (this.selected.length) {
          if ((await this.snapshot(signal)).fingerprint !== snapshot.fingerprint) throw new TaskConflict('Repository changed while selecting validation. Retry with the current files.');
          await step('Invoke-Pester (selected unit tests)', async () => {
            const paths = await Promise.all(this.selected!.map(name => safePath(this.task.index.root, name)));
            const result = testResults.parse(await this.runner('pester', { paths, version: available!.modules.Pester }, signal));
            // Only identities belonging to the approved files can be compared.
            const relative = (file: string) => this.selected![paths.findIndex(p => path.resolve(p).toLowerCase() === path.resolve(file).toLowerCase())] ?? '';
            result.cases = result.cases?.map(c => ({ ...c, path: relative(c.path) }));
            result.failures = result.failures.map(f => ({ ...f, path: f.path ? relative(f.path) : undefined }));
            observedTests = { round: report.round, version: available!.modules.Pester!, hashes: Object.fromEntries(this.selected!.map(file => [file, snapshot.hashes.get(file)!])), result };
            const detail = compareTests(observedTests, this.testBaseline, snapshot.startingState);
            return { failed: result.failed > 0 || result.total === 0 || result.containerErrors.length > 0 || result.result === 'Failed', detail: { ...detail, version: available!.modules.Pester, paths: this.selected } };
          });
        } else report.steps.push({ command: 'Invoke-Pester', status: 'skipped', detail: candidates.length ? 'No test files eligible for execution.' : 'No eligible unit-test candidates discovered.' });
      }
      if ((await this.snapshot(signal)).fingerprint !== snapshot.fingerprint) throw new TaskConflict('Repository content or validation settings changed during validation. Results are stale; inspect test side effects or external edits.');
      report.status = report.steps.some(item => item.status === 'failed') ? 'failed' : report.steps.some(item => item.status === 'skipped') ? 'partial' : 'passed';
      this.invalidated = false;
      // A stale/interrupted run cannot establish the baseline. Never execute a
      // reconstructed tree or add an extra round solely for attribution.
      if (!this.testBaseline && snapshot.startingState && observedTests && completeObservation(observedTests)) this.testBaseline = observedTests;
      if (report.status === 'failed' && latest?.status === 'failed' && this.failureSignature(latest) === this.failureSignature(report)) throw new NoProgress('The same validation failures remain after repair. Stopped early because no diagnostic progress was made.');
      return report;
    } catch (error) {
      this.invalidated = !(error instanceof NoProgress); report.status = 'failed';
      report.steps.push({ command: 'Validation completion', status: 'failed', detail: signal.aborted ? 'Interrupted; no current validation result.' : this.hooks.redact(error instanceof Error ? error.message : 'Results invalidated by a repository or permission change.') });
      throw error;
    } finally { await this.save(); }
  }
  private failureSignature(report: ValidationReport): string {
    return JSON.stringify(report.steps.filter(step => step.status === 'failed').map(step => {
      const detail = step.detail as { diagnostics?: z.infer<typeof diagnostic>[]; count?: number; failed?: number; total?: number; failures?: { name?: string | null; message?: string | null; path?: string }[]; containerErrors?: string[] };
      const normalized = Array.isArray(detail?.diagnostics) ? { count: detail.count, diagnostics: detail.diagnostics.map(item => ({ path: item.path, rule: item.rule, severity: item.severity, message: item.message })) } : Array.isArray(detail?.failures) ? { failed: detail.failed, total: detail.total, failures: detail.failures.map(f => ({ name: f.name, message: f.message, path: f.path })), containerErrors: detail.containerErrors } : detail;
      return { command: step.command, detail: normalized };
    }));
  }
  private async sourceCheck(operation: 'parse' | 'analyze', files: { path: string; text: string }[], version: string | undefined, signal: AbortSignal) {
    const result = diagnostics.parse(await this.runner(operation, { files, version }, signal));
    const paths = files.map(file => file.path);
    if (!result.count) return { ...result, files: paths };
    const unchanged = new Set<string>(); const added = new Set<string>(); const comparable = new Set<string>();
    const baselineFiles: { path: string; text: string }[] = [];
    for (const file of files) {
      const before = await this.task.startingText(file.path);
      if (before === undefined) added.add(file.path);
      else if (before === file.text) unchanged.add(file.path);
      else if (operation === 'parse' || !/^\s*using\s+module\b|^\s*#requires\s+-modules?\b/im.test(before)) baselineFiles.push({ path: file.path, text: before });
    }
    let baseline: z.infer<typeof diagnostics> = { count: 0, diagnostics: [] };
    let baselineCheck = 'No additional baseline command required.';
    if (baselineFiles.length) {
      authorize('run_validation', this.hooks.mode()); check(signal);
      this.hooks.progress(`Comparing ${operation} findings with task-start source snapshots.`);
      try {
        baseline = diagnostics.parse(await this.runner(operation, { files: baselineFiles, version }, signal));
        // A truncated baseline cannot prove that an unmatched finding is new.
        if (baseline.count === baseline.diagnostics.length) baselineFiles.forEach(file => comparable.add(file.path));
        baselineCheck = `${operation} ran against task-start snapshots (${baselineFiles.length} file(s)).`;
      } catch (error) { check(signal); baselineCheck = 'Baseline comparison unavailable; unmatched findings have unknown origin.'; }
    }
    return { ...result, files: paths, baselineCheck, diagnostics: result.diagnostics.map(item => ({ ...item, origin: unchanged.has(item.path) || baseline.diagnostics.some(old => old.path === item.path && old.rule === item.rule && old.message === item.message && old.severity === item.severity) ? 'preexisting' : added.has(item.path) || comparable.has(item.path) ? 'new since task baseline' : 'unknown' })) };
  }
  private async save(): Promise<void> {
    const target = path.join(this.task.directory, 'validation.json');
    const data = this.hooks.redact(JSON.stringify({ version: 1, reports: this.reports }));
    await fs.writeFile(target + '.tmp', data, { mode: 0o600 }); await fs.rename(target + '.tmp', target);
  }
}
