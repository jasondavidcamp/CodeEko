import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EditTask } from '../state/editTask';
import { authorize, check, safePath, TaskConflict } from '../policy/boundary';
import { PowerShellRunner, runPowerShell } from './powershell';
import { git } from '../repository/git';

const diagnostic = z.object({ path: z.string(), line: z.number().nullable(), message: z.string(), rule: z.string(), severity: z.string() });
const diagnostics = z.object({ diagnostics: z.array(diagnostic).max(50), count: z.number().int().nonnegative() });
const inventory = z.object({ version: z.string(), modules: z.object({ Pester: z.string().nullable(), PSScriptAnalyzer: z.string().nullable() }) });
const tests = z.object({ total: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), result: z.string(), failures: z.array(z.object({ name: z.string().nullable(), message: z.string().nullable() })).max(20), containerErrors: z.array(z.string()).max(10) });
export interface ValidationReport {
  round: number; fingerprint: string; status: 'passed' | 'failed' | 'partial';
  steps: { command: string; status: 'passed' | 'failed' | 'skipped'; detail: unknown }[];
}
export interface ValidationHooks {
  mode(): string;
  isDirty(file: string): boolean;
  selectTests(candidates: string[], signal: AbortSignal): Promise<string[]>;
  installMissing(): boolean;
  progress(message: string): void;
  redact(text: string): string;
}
export class TaskValidation {
  private reports: ValidationReport[] = [];
  private selected?: string[];
  private installationAttempted = false;
  private invalidated = false;
  constructor(private task: EditTask, private hooks: ValidationHooks, private runner: PowerShellRunner = runPowerShell) {}
  assertCanEdit(): void { if (this.reports.length >= 3) throw new TaskConflict('Three validation rounds have finished. Review the remaining results before starting another task.'); }
  invalidate(): void { this.invalidated = true; }
  summary(): string {
    const latest = this.reports.at(-1);
    if (!latest) return 'Validation has not run.';
    if (this.invalidated) return `Validation round ${latest.round}/3 is no longer current; files changed afterward.`;
    return `Validation round ${latest.round}/3: ${latest.status}. ` + latest.steps.map(step => `${step.command}: ${step.status}${step.status === 'skipped' ? ` (${String(step.detail)})` : ''}.`).join(' ');
  }
  private async snapshot(signal: AbortSignal) {
    await this.task.index.refresh(signal);
    const fingerprint = createHash('sha256');
    fingerprint.update(await git(this.task.index.root, ['rev-parse','--verify','--quiet','HEAD'], signal, true));
    fingerprint.update(await git(this.task.index.root, ['diff','--cached','--no-ext-diff','--no-textconv','--no-color'], signal));
    const files: { path: string; text: string }[] = [];
    for (const name of [...this.task.index.entries.keys()].sort()) {
      const full = await safePath(this.task.index.root, name);
      if (this.hooks.isDirty(full)) throw new TaskConflict(`Save or discard unsaved changes to ${name} before validation.`);
      const document = await this.task.index.readDocument(name, signal, false);
      fingerprint.update(name).update('\0').update(document.hash);
      if (/\.ps[md]?1$/i.test(name)) files.push({ path: name, text: document.text });
    }
    return { fingerprint: fingerprint.digest('hex'), files };
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
    if (latest?.fingerprint === snapshot.fingerprint) { this.invalidated = false; return latest; }
    this.assertCanEdit();
    const report: ValidationReport = { round: this.reports.length + 1, fingerprint: snapshot.fingerprint, status: 'partial', steps: [] };
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
      await step('Detect Windows PowerShell 5.1 and modules', async () => { available = inventory.parse(await this.runner('inspect', {}, signal)); return { failed: false, detail: available }; }, true);
      if (!available) return report;
      const missing = Object.entries(available.modules).filter(([, version]) => !version).map(([name]) => name);
      if (missing.length && this.hooks.installMissing() && !this.installationAttempted) {
        this.installationAttempted = true;
        await step('Install missing modules from PSGallery (CurrentUser)', async () => {
          const result = await this.runner('install', { names: missing }, signal);
          available = inventory.parse(await this.runner('inspect', {}, signal));
          return { failed: false, detail: result };
        }, true);
      }
      const changed = new Set(this.task.changes().map(change => change.path));
      const files = snapshot.files.filter(file => !changed.size || changed.has(file.path));
      if (files.length) {
        await step('PowerShell 5.1 Parser.ParseInput', async () => { const result = diagnostics.parse(await this.runner('parse', { files }, signal)); return { failed: result.count > 0, detail: result }; });
        // Module-qualified type resolution can import code; do not analyze those files automatically.
        const analyzable = files.filter(file => !/^\s*using\s+module\b|^\s*#requires\s+-modules?\b/im.test(file.text));
        if (analyzable.length !== files.length) report.steps.push({ command: 'PSScriptAnalyzer module-dependent files', status: 'skipped', detail: 'Module-loading directives require manual analysis.' });
        if (available.modules.PSScriptAnalyzer && analyzable.length) {
          await step('Invoke-ScriptAnalyzer (built-in rules)', async () => { const result = diagnostics.parse(await this.runner('analyze', { files: analyzable, version: available!.modules.PSScriptAnalyzer }, signal)); return { failed: result.count > 0, detail: result }; });
        } else report.steps.push({ command: 'Invoke-ScriptAnalyzer', status: 'skipped', detail: 'Module unavailable or no eligible files.' });
      } else report.steps.push({ command: 'PowerShell parser and analyzer', status: 'skipped', detail: 'No changed PowerShell files.' });
      if (report.steps.some(item => item.status === 'failed')) {
        report.steps.push({ command: 'Invoke-Pester', status: 'skipped', detail: 'Repair parser/analyzer findings first.' });
      } else if (!available.modules.Pester) {
        report.steps.push({ command: 'Invoke-Pester', status: 'skipped', detail: 'Supported Pester 4 or 5 is unavailable.' });
      } else {
        const candidates = snapshot.files.map(file => file.path).filter(name => /\.Tests\.ps1$/i.test(name) && !/(^|[/.\-_])(integration|e2e|acceptance|deployment|system)([/.\-_]|$)/i.test(name));
        if (this.selected === undefined) this.selected = candidates.length ? await this.hooks.selectTests(candidates, signal) : [];
        check(signal);
        if (this.selected.some(name => !candidates.includes(name) || /[\[\]]/.test(name))) throw new TaskConflict('Approved test files changed eligibility or contain unsupported wildcard characters. Start a new task to select tests again.');
        if (this.selected.length) {
          if ((await this.snapshot(signal)).fingerprint !== snapshot.fingerprint) throw new TaskConflict('Repository changed while selecting validation. Retry with the current files.');
          await step('Invoke-Pester (developer-selected files)', async () => {
            const paths = await Promise.all(this.selected!.map(name => safePath(this.task.index.root, name)));
            const result = tests.parse(await this.runner('pester', { paths, version: available!.modules.Pester }, signal));
            return { failed: result.failed > 0 || result.total === 0 || result.containerErrors.length > 0 || result.result === 'Failed', detail: result };
          });
        } else report.steps.push({ command: 'Invoke-Pester', status: 'skipped', detail: candidates.length ? 'No test files approved for execution.' : 'No eligible unit-test candidates discovered.' });
      }
      if ((await this.snapshot(signal)).fingerprint !== snapshot.fingerprint) throw new TaskConflict('Repository content changed during validation. Results are stale; inspect test side effects or external edits.');
      report.status = report.steps.some(item => item.status === 'failed') ? 'failed' : report.steps.some(item => item.status === 'skipped') ? 'partial' : 'passed';
      this.invalidated = false;
      return report;
    } catch (error) {
      this.invalidated = true; report.status = 'failed';
      report.steps.push({ command: 'Validation completion', status: 'failed', detail: signal.aborted ? 'Interrupted; no current validation result.' : 'Results invalidated by a repository or permission change.' });
      throw error;
    } finally { await this.save(); }
  }
  private async save(): Promise<void> {
    const target = path.join(this.task.directory, 'validation.json');
    const data = this.hooks.redact(JSON.stringify({ version: 1, reports: this.reports }));
    await fs.writeFile(target + '.tmp', data, { mode: 0o600 }); await fs.rename(target + '.tmp', target);
  }
}
