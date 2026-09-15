import { Action } from '../protocol/actions';
import { RepositoryIndex } from '../indexing';
import { git } from '../repository/git';
import { check } from '../policy/boundary';
export class ReadOnlyTools {
  constructor(readonly index: RepositoryIndex, private ask: (question: string, signal: AbortSignal) => Promise<string>) {}
  async execute(action: Action, signal: AbortSignal): Promise<unknown> {
    // Refresh Git policy each action, including metadata changes not delivered by watchers.
    check(signal); await this.index.refresh(signal); const a = action.args as Record<string, any>;
    const files = [...this.index.entries.keys()].sort();
    switch (action.tool) {
      case 'list_files': { const matches = files.filter(f => !a.query || f.toLowerCase().includes(a.query.toLowerCase())); return { files: matches.slice(0, 200), truncated: matches.length > 200 }; }
      case 'read_file': return this.read(a.path, a.startLine, a.endLine, signal);
      case 'read_files': { const results = []; for (const file of a.paths) results.push(await this.read(file, 1, 120, signal)); return results; }
      case 'find_symbol': { const matches = [...this.index.entries.values()].flatMap(e => e.symbols.filter(s => s.name.toLowerCase().includes(a.query.toLowerCase())).map(s => ({ path: e.path, ...s }))); return { matches: matches.slice(0, 100), truncated: matches.length > 100 }; }
      case 'search_text': {
        const matches = []; let scanned = 0;
        for (const file of files) {
          check(signal); const text = await this.index.read(file, signal, false); scanned += text.length;
          if (scanned > 10000000) return { matches, truncated: true, reason: 'Search byte budget reached.' };
          for (const [i, line] of text.split(/\r?\n/).entries()) {
            if (line.toLowerCase().includes(a.query.toLowerCase())) matches.push({ path: file, line: i + 1, text: line.slice(0, 300) });
            if (matches.length >= 100) return { matches, truncated: true };
          }
        }
        return { matches, truncated: false };
      }
      case 'git_status': {
        const raw = await git(this.index.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal);
        const parts = raw.split('\0'); const entries = [];
        for (let i = 0; i < parts.length; i++) {
          const record = parts[i]; if (!record) continue;
          const status = record.slice(0, 2); const file = record.slice(3);
          if (/[RC]/.test(status)) i++; // Do not expose unfiltered source paths.
          if (this.index.entries.has(file)) entries.push({ status, path: file });
        }
        return { entries: entries.slice(0, 200), note: 'Only readable manifest paths are shown; deleted and excluded files are omitted.', truncated: entries.length > 200 };
      }
      case 'ask_user': return { answer: await this.ask(a.question, signal) };
      case 'complete_task': return { summary: a.summary };
      default: throw new Error('Unknown tool.');
    }
  }
  private async read(file: string, start = 1, end = start + 199, signal: AbortSignal): Promise<unknown> {
    if (end < start) throw new Error('endLine precedes startLine.');
    const document = await this.index.readDocument(file, signal);
    const lines = document.text.split('\n');
    if (start > lines.length) return { path: file, totalLines: lines.length, text: '', note: 'Requested start line is past end of file.', truncated: false };
    const last = Math.min(end, start + 199, lines.length);
    const text = lines.slice(start - 1, last).map((l, i) => `${start + i}: ${l}`).join('\n');
    return { path: file, hash: document.hash, encoding: document.encoding, lineEnding: document.eol === '\r\n' ? 'CRLF' : 'LF', startLine: start, endLine: last, totalLines: lines.length, text: text.slice(0, 12000), truncated: text.length > 12000 || last < Math.min(end, lines.length) };
  }
}
