import * as path from 'node:path';
import { RepositoryIndex } from '../../src/indexing';
import { EditTask } from '../../src/state/editTask';

// Fault injection is confined to this disposable worker. Production code has
// no crash switches, environment hooks or injected filesystem implementation.
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const [root, storage, scenario] = process.argv.slice(2);
process.on('message', () => {}); // Keep IPC alive at a checkpoint until killed.

async function run(): Promise<void> {
  const index = new RepositoryIndex(root, storage);
  const task = await EditTask.capture(index, storage, { mode: () => 'Full access', isDirty: () => false, confirm: async () => true, preview: async () => {} }, new AbortController().signal);
  let document = await index.readDocument('main.ps1'); task.observe('main.ps1', document.hash);
  if (scenario === 'replace-again') {
    await task.execute({ version: 1, tool: 'apply_patch', args: { path: 'main.ps1', expectedHash: document.hash, edits: [{ oldText: 'return 1', newText: 'return 2' }] } }, new AbortController().signal);
    await index.refresh(); document = await index.readDocument('main.ps1'); task.observe('main.ps1', document.hash);
  }
  const checkpoint = async (): Promise<never> => {
    process.send!({ checkpoint: scenario, id: task.id });
    return new Promise<never>(() => {});
  };
  const main = path.join(root, 'main.ps1'); const target = path.join(root, 'created.ps1');
  const original = { open: fs.open, rename: fs.rename, unlink: fs.unlink, link: fs.link };
  if (scenario === 'partial-write') fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original.open(...args);
    if (path.basename(String(args[0])).startsWith('.llm-runtime-')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async data => { await write((data as Buffer).subarray(0, 16)); return checkpoint(); };
    }
    return handle;
  }) as typeof fs.open;
  fs.rename = async (source, destination) => {
    if (String(destination) === main && scenario === 'replace-before') await checkpoint();
    await original.rename(source, destination);
    if (String(destination) === main && ['replace-after','replace-again'].includes(scenario)) await checkpoint();
    if (path.basename(String(destination)) === 'task.json') {
      const journal = JSON.parse(await fs.readFile(destination, 'utf8'));
      if (scenario === 'move-first-journal' && journal.changes.length === 1) await checkpoint();
      if (scenario === 'create-recorded' && journal.changes[0]?.state === 'applied') await checkpoint();
    }
  };
  fs.unlink = async file => {
    if (String(file) === main && scenario === 'delete-before') await checkpoint();
    await original.unlink(file);
    if (String(file) === main && ['delete-after','move-unlinked'].includes(scenario)) await checkpoint();
  };
  fs.link = async (source, destination) => {
    await original.link(source, destination);
    if (String(destination) === target && ['move-linked','create-linked'].includes(scenario)) await checkpoint();
  };
  const args = { path: 'main.ps1', expectedHash: document.hash };
  if (scenario.startsWith('delete')) await task.execute({ version: 1, tool: 'delete_file', args }, new AbortController().signal);
  else if (scenario.startsWith('move')) await task.execute({ version: 1, tool: 'move_file', args: { ...args, destination: 'created.ps1' } }, new AbortController().signal);
  else if (scenario.startsWith('create')) await task.execute({ version: 1, tool: 'create_file', args: { path: 'created.ps1', content: 'function Get-New { return 7 }\n' } }, new AbortController().signal);
  else await task.execute({ version: 1, tool: 'apply_patch', args: { ...args, edits: [{ oldText: scenario === 'replace-again' ? 'return 2' : 'return 1', newText: scenario === 'replace-again' ? 'return 3' : 'return 2' }] } }, new AbortController().signal);
  throw new Error('Operation completed without reaching its crash checkpoint.');
}
run().catch(error => { process.send?.({ error: String(error) }); process.exitCode = 1; process.disconnect(); });
