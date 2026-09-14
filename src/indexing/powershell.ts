export interface SymbolEntry { name: string; kind: string; line: number }
export function powershell(text: string): SymbolEntry[] {
  const result: SymbolEntry[] = [];
  const patterns: [string, RegExp][] = [
    ['function', /^\s*(?:function|filter)\s+([\w:-]+)/i], ['class', /^\s*class\s+([\w]+)/i],
    ['parameter', /(?:\[[\w\[\].]+\]\s*)\$([\w]+)/], ['import', /\bImport-Module\s+([^;\r\n]+)/i],
    ['export', /\bExport-ModuleMember\s+([^;\r\n]+)/i], ['dot-source', /^\s*\.\s+(.+)/],
    ['manifest', /^\s*(RootModule|NestedModules|RequiredModules|FunctionsToExport|CmdletsToExport)\s*=\s*(.+)/i],
    ['pester', /^\s*(?:Describe|Context|It)\s+['"]([^'"]+)/i]
  ];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trimStart().startsWith('#')) return;
    for (const [kind, regex] of patterns) { const m = regex.exec(line); if (m) result.push({ name: m[1] + (m[2] ? ': ' + m[2] : ''), kind, line: i + 1 }); }
  });
  return result;
}
