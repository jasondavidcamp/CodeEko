export interface RequestTiming {
  id: number; at: string; operation: 'models' | 'completion'; mode: string; timeoutMs: number; repair: boolean;
  firstContentMs?: number; contentChunks?: number; streamed?: boolean; streamingRequested?: boolean;
  elapsedMs?: number; headersMs?: number; status?: number; outcome: string;
}
// Only locally generated metadata. Never accept request text, URLs, errors or provider bodies.
export class PerformanceDiagnostics {
  private records: RequestTiming[] = [];
  private nextId = 0;
  begin(operation: RequestTiming['operation'], mode: string, timeoutMs: number, repair = false): number {
    const id = ++this.nextId;
    this.records.push({ id, at: new Date().toISOString(), operation, mode, timeoutMs, repair, outcome: 'pending' });
    this.records = this.records.slice(-100);
    return id;
  }
  finish(id: number, result: Pick<RequestTiming, 'elapsedMs' | 'headersMs' | 'status' | 'outcome' | 'firstContentMs' | 'contentChunks' | 'streamed' | 'streamingRequested'>): void {
    const record = this.records.find(record => record.id === id);
    if (record) Object.assign(record, result);
  }
  clear(): void { this.records = []; }
  snapshot(runtimeVersion = 'unknown'): { version: number; runtimeVersion: string; scope: string; requests: RequestTiming[] } {
    return { version: 1, runtimeVersion, scope: 'Current extension session; latest 100 requests', requests: this.records.map(record => ({ ...record })) };
  }
}
export const performanceDiagnostics = new PerformanceDiagnostics();
