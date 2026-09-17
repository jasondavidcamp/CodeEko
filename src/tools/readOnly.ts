import { showCommit } from '../repository/history';
import { Action } from '../protocol/actions';
import { RepositoryIndex, excluded } from '../indexing';
import { git } from '../repository/git';
import { check, safePath } from '../policy/boundary';
import { powershell } from '../indexing/powershell';
export class ReadOnlyTools {
  constructor(readonly index: RepositoryIndex, private ask: (question: string, signal: AbortSignal) => Promise<string>, private refresh = (signal: AbortSignal) => index.refresh(signal), private observe = (_file: string, _hash: string, _explicitRead: boolean) => {}) {}
  inventory(query?: string): { files: string[]; truncated: boolean } {
    const matches = [...this.index.entries.keys()].sort().filter(f => !query || f.toLowerCase().includes(query.toLowerCase()));
    return { files: matches.slice(0, 200), truncated: matches.length > 200 };
  }
  async execute(action: Action, signal: AbortSignal): Promise<unknown> {
    check(signal);
    if (action.tool === 'ask_user') return { answer: await this.ask(action.args.question, signal) };
    if (action.tool === 'complete_task') return { summary: action.args.summary };
    // Refresh Git policy each action, including metadata changes not delivered by watchers.
    await this.refresh(signal); const a = action.args as Record<string, any>;
    const files = [...this.index.entries.keys()].sort();
    switch (action.tool) {
      case 'list_files': return this.inventory(a.query);
      case 'read_file': { const result = await this.read(a.path, a.startLine, a.endLine, signal); this.observeRead(result); return result; }
      case 'read_files': { const results = []; for (const file of a.paths) results.push(await this.read(file, 1, 120, signal)); results.forEach(result => this.observeRead(result)); return results; }
      case 'find_symbol': {
        const matches = [];
        for (const entry of this.index.entries.values()) {
          if (!entry.symbols.some(s => s.name.toLowerCase().includes(a.query.toLowerCase()))) continue;
          // Bind returned symbols to real bytes, not just cached stat metadata.
          const document = await this.index.readDocument(entry.path, signal, false);
          const symbols = powershell(document.text).filter(s => s.name.toLowerCase().includes(a.query.toLowerCase()));
          if (symbols.length) this.observe(entry.path, document.hash, false);
          matches.push(...symbols.map(s => ({ path: entry.path, ...s })));
          if (matches.length > 100) break;
        }
        return { matches: matches.slice(0, 100), truncated: matches.length > 100 };
      }
      case 'search_text': {
        const matches = []; let scanned = 0;
        for (const file of files) {
          check(signal); const document = await this.index.readDocument(file, signal, false); const text = document.text; scanned += text.length;
          if (scanned > 10000000) return { matches, truncated: true, reason: 'Search byte budget reached.' };
          for (const [i, line] of text.split(/\r?\n/).entries()) {
            if (line.toLowerCase().includes(a.query.toLowerCase())) { this.observe(file, document.hash, false); matches.push({ path: file, line: i + 1, text: line.slice(0, 300) }); }
            if (matches.length >= 100) return { matches, truncated: true };
          }
        }
        return { matches, truncated: false };
      }
      case 'git_show_commit': return showCommit(this.index.root, a.revision, signal);
      case 'git_status': {
        const raw = await git(this.index.root, ['status', '--porcelain=v1', '--no-renames', '-z', '--untracked-files=all'], signal);
        const parts = raw.split('\0'); const entries = [];
        for (let i = 0; i < parts.length; i++) {
          const record = parts[i]; if (!record) continue;
          const status = record.slice(0, 2); const file = record.slice(3);
          if (/[RC]/.test(status)) i++; // Do not expose unfiltered source paths.
          if (this.index.entries.has(file)) entries.push({ status, path: file });
          else if (status.includes('D') && !excluded(file)) {
            // Missing files cannot belong to the readable index, but their deletion
            // is still part of Git status. Expose names only after path/ignore checks.
            try { await safePath(this.index.root, file, true); } catch { continue; }
            if (!(await git(this.index.root, ['check-ignore', '--no-index', '--', file], signal, true)).trim()) entries.push({ status, path: file });
          }
        }
        return { entries: entries.slice(0, 200), note: 'Readable files and eligible tracked deletions are shown. Renames appear as separate old-path deletions and new paths; include both when committing a rename. Excluded and ignored paths are omitted.', truncated: entries.length > 200 };
      }
      default: throw new Error('Unknown tool.');
    }
  }
  private observeRead(result: unknown): void {
    const file = result as { path: string; hash?: string };
    if (file.hash) this.observe(file.path, file.hash, true);
  }
  private async read(file: string, start = 1, end = start + 199, signal: AbortSignal): Promise<unknown> {
    if (end < start) throw new Error('endLine precedes startLine.');
    const document = await this.index.readDocument(file, signal);
    const lines = document.text.split('\n');
    if (start > lines.length) return { path: file, totalLines: lines.length, text: '', note: 'Requested start line is past end of file.', truncated: false };
    const last = Math.min(end, start + 199, lines.length);
    const text = lines.slice(start - 1, last).join('\n');
    return { path: file, hash: document.hash, encoding: document.encoding, lineEnding: document.eol === '\r\n' ? 'CRLF' : 'LF', startLine: start, endLine: last, totalLines: lines.length, text: text.slice(0, 12000), truncated: text.length > 12000 || last < lines.length };
  }
}
