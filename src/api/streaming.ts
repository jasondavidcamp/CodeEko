import { responseMetadata, RequestMetadata } from '../state/performanceDiagnostics';
import { checkFinishReason } from './finish';
/** Decode OpenAI-compatible JSON or SSE without trusting the Content-Type header. */
export class CompletionDecoder {
  private mode: 'unknown' | 'json' | 'sse' = 'unknown';
  private pending = '';
  private data: string[] = [];
  private eventName = '';
  private text = '';
  private finished = false;
  done = false;
  readonly metadata: RequestMetadata = {};
  get streamed(): boolean { return this.mode === 'sse'; }
  constructor(private onContent: () => void) {}

  push(chunk: string): void {
    this.pending += chunk;
    if (this.mode === 'unknown') {
      const start = this.pending.trimStart();
      if (!start) return;
      if (start[0] === '{' || start[0] === '[') this.mode = 'json';
      else if (/^(?:data:|event:|id:|retry:|:)/.test(start)) {
        this.mode = 'sse'; this.pending = start;
      } else if (/[\r\n]/.test(start)) throw new Error('Endpoint returned an unsupported response format.');
      else return;
    }
    if (this.mode !== 'sse') return;
    while (!this.done) {
      const match = /\r\n|\r|\n/.exec(this.pending);
      if (!match || (match[0] === '\r' && match.index === this.pending.length - 1)) break;
      const line = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (!line) { this.event(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    if (field === 'event') this.eventName = value;
  }

  private event(): void {
    const data = this.data.join('\n'); this.data = [];
    const name = this.eventName; this.eventName = '';
    if (name === 'error') throw new Error('Endpoint reported a streaming error.');
    if (!data.trim()) return;
    if (data.trim() === '[DONE]') { this.done = true; return; }
    let event: any;
    try { event = JSON.parse(data); } catch { throw new Error('Endpoint returned malformed streaming data.'); }
    Object.assign(this.metadata, responseMetadata(event));
    if (event?.error) throw new Error('Endpoint reported a streaming error.');
    if (!event || typeof event !== 'object') throw new Error('Endpoint returned malformed streaming data.');
    if (event.choices !== undefined && !Array.isArray(event.choices)) throw new Error('Endpoint returned malformed streaming data.');
    for (const choice of event.choices ?? []) {
      if (choice?.index !== undefined && choice.index !== 0) continue;
      const content = choice?.delta?.content;
      if (typeof content === 'string' && content.length) {
        if (this.finished) throw new Error('Endpoint sent content after stream completion.');
        this.text += content; this.onContent();
      } else if (content != null && typeof content !== 'string') throw new Error('Endpoint returned malformed streaming content.');
      if (choice?.finish_reason != null) {
        checkFinishReason(choice.finish_reason);
        this.finished = true;
      }
    }
  }

  result(): any {
    if (this.mode === 'sse') {
      if (!this.done) {
        if (this.pending) this.line(this.pending.replace(/\r$/, ''));
        this.event();
      }
      if (!this.done && !this.finished) throw new Error('Endpoint stream ended before completion.');
      return { choices: [{ message: { content: this.text } }] };
    }
    try { return JSON.parse(this.pending); }
    catch { throw new Error('Endpoint returned invalid JSON.'); }
  }
}
