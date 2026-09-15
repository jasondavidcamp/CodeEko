import * as fs from 'node:fs';
import * as path from 'node:path';

// Reuse an existing private installation's data rather than copying live journals.
// Repository leases continue to protect concurrent access by either identity.
export function compatibleStorage(current: string): string {
  if (path.basename(current).toLowerCase() !== 'jasondavidcamp.ekod') return current;
  const legacy = path.join(path.dirname(current), 'internal-pilot.llm-coding-agent-runtime');
  try {
    const stat = fs.lstatSync(legacy);
    if (stat.isDirectory() && !stat.isSymbolicLink()) return legacy;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return current;
}
