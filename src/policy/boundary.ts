import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export function contained(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
export async function safePath(root: string, relative: string, allowMissing = false): Promise<string> {
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Repository root became a linked path.');
  if (!relative || path.isAbsolute(relative) || /[<>:"\\|?*\x00-\x1f]/.test(relative) || relative.split('/').some(p => !p || p === '..' || /^\.git$/i.test(p) || /[ .]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Path denied.');
  const target = path.resolve(root, relative);
  if (!contained(root, target)) throw new Error('Path outside repository.');
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Linked paths are excluded.'); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!contained(await fs.realpath(root), await fs.realpath(current))) throw new Error('Resolved path outside repository.');
  }
  return target;
}
const allowed = new Set(['list_files','search_text','find_symbol','read_file','read_files','git_status','ask_user','complete_task','git_diff_summary','open_diff']);
export const mutations = new Set(['apply_patch','create_file','delete_file','move_file']);
export function authorize(tool: string, mode: string): void {
  if (!['Review','Workspace','Full access','Custom'].includes(mode) || (!allowed.has(tool) && !((mutations.has(tool) || tool === 'run_validation') && ['Workspace','Full access'].includes(mode)))) throw new Error(`Tool denied in ${mode} mode.`);
}
export class TaskConflict extends Error {}
export class ReadRequired extends TaskConflict {
  constructor(readonly file: string) { super(`Read ${file} again before editing; its task/read hash is stale or missing. No edit was applied.`); }
}
export class PatchTargetRequired extends ReadRequired {
  constructor(file: string) { super(file); this.message = `Patch text is missing or ambiguous in ${file}. Use a smaller, unique replacement after reading the file.`; }
}
export function check(signal?: AbortSignal): void { signal?.throwIfAborted(); }
