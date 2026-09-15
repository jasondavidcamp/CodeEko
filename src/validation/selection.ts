import * as path from 'node:path';
import { z } from 'zod';
import { PowerShellRunner } from './powershell';

const excluded = /(^|[/.\-_])(integration|e2e|acceptance|deployment|system)([/.\-_]|$)/i;
export const unitCandidates = (files: { path: string }[]) => files.map(f => f.path).filter(p => /\.Tests\.ps1$/i.test(p) && !excluded.test(p));
const inspection = z.object({ files: z.array(z.object({ path: z.string(), blocked: z.array(z.string()), functions: z.array(z.string()), commands: z.array(z.object({ name: z.string().nullable(), dot: z.boolean(), target: z.string() })) })) });
const allowed = new Set(('describe context it beforeall beforeeach afterall aftereach should ' +
  'join-path split-path where-object foreach-object select-object sort-object measure-object group-object write-output').split(' '));

// Conservative eligibility, not an OS sandbox. Inspect every reachable function body
// and setup block; unknown commands/dependencies reduce coverage rather than execute.
export async function selectUnitTests(files: { path: string; text: string }[], runner: PowerShellRunner, signal: AbortSignal) {
  const selected: string[] = []; const skipped: { path: string; reason: string }[] = [];
  const inspected = inspection.parse(await runner('inspectTests', { files }, signal));
  const byName = new Map(inspected.files.map(f => [f.path.toLowerCase(), f]));
  for (const candidate of files.filter(f => /\.Tests\.ps1$/i.test(f.path)).map(f => f.path)) {
    let reason = excluded.test(candidate) ? 'Integration or operational test filename.' : '';
    const visited = new Set<string>(); const commands: string[] = []; const functions = new Set<string>();
    const visit = (name: string): void => {
      if (reason || visited.has(name.toLowerCase())) return;
      visited.add(name.toLowerCase());
      const file = byName.get(name.toLowerCase());
      if (!file || visited.size > 50) { reason = 'Dependency is unavailable or exceeds inspection limits.'; return; }
      if (file.blocked.length) { reason = `${file.path}: ${file.blocked[0]}`; return; }
      for (const fn of file.functions) {
        if (allowed.has(fn.toLowerCase()) || fn.includes(':')) { reason = 'Command shadowing or scoped function definitions.'; return; }
        functions.add(fn.toLowerCase());
      }
      for (const command of file.commands) {
        if (!command.dot) { commands.push(command.name?.toLowerCase() ?? '<dynamic invocation>'); continue; }
        // Only literal paths rooted at the inspected script's directory. No evaluation.
        const target = command.target.trim();
        const joined = /^\(\s*Join-Path\s+\$PSScriptRoot\s+(['"])([^'"$`]+)\1\s*\)$/i.exec(target);
        const expanded = /^"\$PSScriptRoot[\\/]([^"$`]+)"$/i.exec(target);
        const relative = joined?.[2] ?? expanded?.[1];
        if (!relative || path.win32.isAbsolute(relative) || /[:*?\[\]]/.test(relative)) { reason = 'Dynamic or unsupported dot-source dependency.'; return; }
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), relative.replaceAll('\\', '/')));
        if (dependency.startsWith('../') || !/\.ps1$/i.test(dependency) || excluded.test(dependency)) { reason = 'Dependency is outside the unit-test scope.'; return; }
        visit(dependency);
      }
    };
    visit(candidate);
    const unknown = commands.find(c => !allowed.has(c) && !functions.has(c));
    if (!reason && unknown) reason = `Unsupported command: ${unknown}.`;
    if (/[\[\]*?]/.test(candidate)) reason = 'Wildcard characters in test path.';
    if (reason) skipped.push({ path: candidate, reason }); else selected.push(candidate);
  }
  return { selected, skipped };
}
