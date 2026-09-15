import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Locate captures without reading their potentially sensitive contents or following links.
export async function latestRejectedLog(storage: string): Promise<string | undefined> {
  async function directories(directory: string, pattern: RegExp) {
    try { return (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && pattern.test(entry.name)).map(entry => path.join(directory, entry.name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  let latest: { file: string; modified: number } | undefined;
  for (const repository of await directories(storage, /^[a-f0-9]{64}$/)) {
    const tasks = path.join(repository, 'tasks');
    try { if (!(await fs.lstat(tasks)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const task of await directories(tasks, /^[a-f0-9-]{36}$/)) {
      const file = path.join(task, 'rejected-responses.jsonl');
      try {
        const stat = await fs.lstat(file);
        if (stat.isFile() && (!latest || stat.mtimeMs > latest.modified)) latest = { file, modified: stat.mtimeMs };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return latest?.file;
}
