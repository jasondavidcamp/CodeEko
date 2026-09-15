import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git } from '../repository/git';
import { safePath, check } from '../policy/boundary';
import { powershell, SymbolEntry } from './powershell';
import { decode, DocumentData } from '../repository/document';
export interface Entry { path: string; size: number; mtime: number; symbols: SymbolEntry[] }
export function excluded(file: string): boolean {
  if (/(^|\/)\.ekod-/.test(file)) return true;
  return /(^|\/)(\.git|node_modules|dist|build|out|coverage|bin|obj|vendor|\.venv|\.ssh|\.aws|\.azure|\.kube|secrets?)(\/|$)/i.test(file) || /(^|\/)(\.env[^/]*|.*(?:secret|credential|password).*|appsettings[^/]*|web\.config|nuget\.config|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i.test(file) || /\.(pem|key|pfx|p12|jks|kdbx|lock|min\.js|map|exe|dll|zip|pdf|png|jpe?g|gif|ico|woff2?|mp[34]|wav)$/i.test(file);
}
export async function fileDocument(root: string, file: string): Promise<DocumentData> {
  const full = await safePath(root, file);
  const handle = await fs.open(full, 'r');
  try {
    if (!(await handle.stat()).isFile() || (await handle.stat()).size > 256000) throw new Error('File too large or not regular.');
    const bytes = Buffer.alloc(256001);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 256000) throw new Error('File too large.');
    const data = bytes.subarray(0, bytesRead);
    return decode(data);
  } finally { await handle.close(); }
}
export async function textFile(root: string, file: string): Promise<string> { return (await fileDocument(root, file)).text; }
export class RepositoryIndex {
  entries = new Map<string, Entry>();
  constructor(readonly root: string, private storage: string) {}
  invalidate(file: string): void {
    // Watchers invalidate cached symbols, not manifest membership. Removing an
    // entry here can race a validation snapshot after its completed refresh.
    // refresh() determines additions/deletions; reads still check the real file.
    const entry = this.entries.get(file);
    if (entry) entry.mtime = -1;
  }
  async refresh(signal?: AbortSignal): Promise<void> {
    check(signal);
    const deadline = Date.now() + 30000; let indexedBytes = 0;
    const candidates = (await git(this.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)).split('\0').filter(Boolean);
    if (candidates.length > 20000) throw new Error('Repository exceeds 20,000-file pilot limit.');
    // --cached includes tracked ignored files; check-ignore --no-index filters these too.
    const ignored = new Set((await git(this.root, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], signal)).split('\0'));
    const next = new Map<string, Entry>();
    for (const file of candidates) {
      check(signal);
      if (Date.now() > deadline) throw new Error('Index refresh exceeded the 30-second pilot limit. Open a smaller repository.');
      if (excluded(file) || ignored.has(file)) continue;
      try {
        const full = await safePath(this.root, file); const stat = await fs.stat(full);
        if (!stat.isFile() || stat.size > 256000) continue;
        indexedBytes += stat.size;
        if (indexedBytes > 50000000) break;
        const previous = this.entries.get(file);
        if (previous && previous.mtime === stat.mtimeMs && previous.size === stat.size) { next.set(file, previous); continue; }
        const text = await textFile(this.root, file);
        next.set(file, { path: file, size: stat.size, mtime: stat.mtimeMs, symbols: /\.ps[md]?1$/i.test(file) ? powershell(text) : [] });
      } catch { /* Fail closed on inaccessible, linked, binary or oversized files. */ }
    }
    if (indexedBytes > 50000000) throw new Error('Repository text candidates exceed the 50 MB pilot limit.');
    check(signal); this.entries = next;
    await fs.mkdir(this.storage, { recursive: true });
    await fs.writeFile(path.join(this.storage, 'index.json'), JSON.stringify({ version: 1, entries: [...next.values()] }));
  }
  async readDocument(file: string, signal?: AbortSignal, verifyIgnore = true): Promise<DocumentData> {
    check(signal);
    if (!this.entries.has(file) || excluded(file)) throw new Error('File is outside the readable manifest.');
    // Recheck current ignore policy even if a watcher event has not yet arrived.
    if (verifyIgnore) {
      const ignored = (await git(this.root, ['ls-files', '-z', '--cached', '--others', '--ignored', '--exclude-standard', '--', file], signal)).split('\0');
      if (ignored.includes(file)) throw new Error('File is now ignored.');
    }
    const document = await fileDocument(this.root, file); check(signal); return document;
  }
  async read(file: string, signal?: AbortSignal, verifyIgnore = true): Promise<string> { return (await this.readDocument(file, signal, verifyIgnore)).text; }
}
