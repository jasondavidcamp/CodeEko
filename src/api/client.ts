export interface Message { role: 'system' | 'user' | 'assistant'; content: string }
export function apiBase(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Configure an HTTPS API base URL without credentials or query parameters.');
  const base = url.toString().replace(/\/+$/, '');
  // Preserve explicitly versioned compatibility bases (for example /v1beta/openai).
  return /\/v\d+(?:(?:alpha|beta)\d*)?(?:\/|$)/.test(url.pathname) ? base : base + '/v1';
}
export class GeminiClient {
  constructor(private endpoint: string, private key: string, private timeout: number, private transport: typeof fetch = fetch) {}
  redact(text: string): string { return this.key ? text.split(this.key).join('[REDACTED API KEY]') : text; }
  private async request(route: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeout);
    try {
      signal?.throwIfAborted();
      const response = await this.transport(apiBase(this.endpoint) + route, { method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal, headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) throw new Error(`Endpoint returned HTTP ${response.status}.`);
      if (!response.body) throw new Error('Endpoint returned no body.');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.length; if (length > 1000000) throw new Error('Endpoint response exceeds limit.');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (signal?.aborted) throw new Error('Cancelled.');
      if (controller.signal.aborted) throw new Error('Endpoint request timed out.');
      if (error instanceof Error && /^Endpoint /.test(error.message)) throw error;
      // Never forward server bodies, URLs, headers or transport errors containing credentials.
      throw new Error('Endpoint request failed. Check the configured endpoint, network connection, certificate trust, and credentials.');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async models(signal?: AbortSignal): Promise<string[]> {
    const data = await this.request('/models', undefined, signal);
    if (!Array.isArray(data?.data)) throw new Error('Endpoint model list is invalid.');
    const models = [...new Set<string>(data.data.filter((m: any) => typeof m?.id === 'string' && m.id.length > 0 && m.id.length <= 200 && !m.id.includes(this.key)).map((m: any) => m.id))];
    if (!models.length) throw new Error('Endpoint returned no models.');
    return models.sort();
  }
  async complete(model: string, messages: Message[], signal?: AbortSignal): Promise<string> {
    const data = await this.request('/chat/completions', { model, messages, temperature: 0, stream: false, max_tokens: 4096, response_format: { type: 'json_object' } }, signal);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Endpoint response has no message content.');
    return this.redact(content);
  }
}
