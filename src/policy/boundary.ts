import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export function contained(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
export async function safePath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes(':') || relative.includes('\\') || relative.split('/').some(p => !p || p === '..' || /^\.git$/i.test(p) || /[ .]$/.test(p))) throw new Error('Path denied.');
  const target = path.resolve(root, relative);
  if (!contained(root, target)) throw new Error('Path outside repository.');
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Linked paths are excluded.');
  }
  if (!contained(await fs.realpath(root), await fs.realpath(target))) throw new Error('Resolved path outside repository.');
  return target;
}
const allowed = new Set(['list_files','search_text','find_symbol','read_file','read_files','git_status','ask_user','complete_task']);
export function authorize(tool: string, mode: string): void {
  if (!['Review','Workspace','Full access','Custom'].includes(mode) || !allowed.has(tool)) throw new Error('Tool denied by read-only policy.');
}
export function check(signal?: AbortSignal): void { signal?.throwIfAborted(); }
