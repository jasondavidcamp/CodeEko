import { execFile } from 'node:child_process';
import { realpath, readdir } from 'node:fs/promises';
import * as path from 'node:path';
export function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toUpperCase().startsWith('GIT_')) delete env[name];
  env.GIT_TERMINAL_PROMPT = '0';
  return new Promise((resolve, reject) => execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd, env, signal, timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => error ? reject(new Error(signal?.aborted ? 'Cancelled.' : 'Git failed; verify Git installation and repository access.')) : resolve(stdout)));
}
export async function resolveRepository(folders: string[], pick: (folders: string[]) => Promise<string | undefined>): Promise<string> {
  if (!folders.length) throw new Error('Open a local Git repository folder first.');
  // Select before invoking Git or inspecting any workspace contents.
  const selected = folders.length === 1 ? folders[0] : await pick(folders);
  if (!selected || !folders.includes(selected)) throw new Error('Repository selection cancelled.');
  const candidates = await discoverRepositories(selected);
  const repository = candidates.length > 1 ? await pick(candidates) : candidates[0] ?? selected;
  if (!repository || (candidates.length > 1 && !candidates.includes(repository))) throw new Error('Repository selection cancelled.');
  return realpath((await git(repository, ['rev-parse', '--show-toplevel'])).trim());
}
// Directory metadata only: never open source files or run Git before an ambiguous
// folder's repositories have been selected. Linked directories are not followed.
async function discoverRepositories(folder: string): Promise<string[]> {
  const pending = [folder]; const roots: string[] = []; let scanned = 0;
  while (pending.length) {
    if (++scanned > 10000) throw new Error('Workspace is too broad. Open the intended repository folder.');
    const directory = pending.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { if (directory === folder) throw new Error('Workspace folder is inaccessible.'); else continue; }
    if (entries.some(e => e.name === '.git' && !e.isSymbolicLink())) roots.push(directory);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !/^(\.git|\.venv|\.cache|node_modules|dist|build|out|coverage|bin|obj|vendor)$/i.test(entry.name)) pending.push(path.join(directory, entry.name));
    }
  }
  return roots.sort();
}
