import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../src/api/client';
import { compareTransportTiming, ProbeWorker, transportEnvironment } from '../src/api/transportComparison';
import { transportMetadata } from '../src/api/transportMetadata';
import { taskProtocol } from '../src/protocol/actions';
import { PerformanceDiagnostics } from '../src/state/performanceDiagnostics';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const environment = transportEnvironment({ host: 'local', platform: 'win32', proxySupport: 'override', proxyConfigured: true,
  httpProxyEnvironment: true, httpsProxyEnvironment: false, noProxyEnvironment: true, proxyStrictSSL: true });
const answer = JSON.stringify({ version: 1, tool: 'complete_task', args: { summary: 'Hello!' } });
const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
function worker(fetch: typeof global.fetch): ProbeWorker & { starts: number; closes: number } {
  let usable = false;
  return { starts: 0, closes: 0, get usable() { return usable; }, metadata: undefined, measurement: {},
    async start() { this.starts++; usable = true; }, fetch, async settled() {}, async close() { this.closes++; usable = false; } };
}
test('paired transport probes use identical production hello bodies, isolate overrides and never export content', async () => {
  const sent: { client: string; body: string; encoding: string | null }[] = [];
  const transport = (client: string): typeof fetch => async (_url, init) => {
    sent.push({ client, body: String(init?.body), encoding: new Headers(init?.headers).get('accept-encoding') });
    return new Response(sse, { headers: { 'Content-Type': 'application/json; private-secret', 'Content-Encoding': 'gzip' } });
  };
  const child = worker(transport('powershell'));
  const client = new GeminiClient('https://private-host.invalid', 'private-key', 300000, transport('vscode'), 'User message', false);
  const report = await compareTransportTiming(client, 'fixture', 'Full access', environment, new AbortController().signal, () => {}, async () => child);
  assert.equal(report.transportComparisonVersion, 1); assert.equal(report.completed, true); assert.equal(report.allRepliesValid, true);
  assert.equal(report.results.length, 20); assert.equal(new Set(sent.map(s => s.body)).size, 1);
  assert.equal(new Set(report.results.map(r => r.requestDigest)).size, 1);
  assert.deepEqual(JSON.parse(sent[0].body), { model: 'fixture', messages: client.formatMessages([{ role: 'system', content: taskProtocol('Full access') }, { role: 'user', content: 'hello' }]), temperature: 0, stream: true, max_tokens: 4096 });
  assert.equal(sent.filter(s => s.encoding === 'identity').length, 10);
  assert.deepEqual(report.summary.map(s => s.validReplies), [5,5,5,5]);
  assert.equal(report.settings.timeoutMs, 90000); assert.equal(child.starts, 1); assert.equal(child.closes, 1);
  assert.ok(report.results.every(r => r.timing?.responseHeaders?.contentType === 'json'));
  await client.complete('fixture', [{ role: 'user', content: 'unchanged chat' }]);
  assert.equal(JSON.parse(sent.at(-1)!.body).stream, false); assert.equal(sent.at(-1)!.encoding, null);
  assert.doesNotMatch(JSON.stringify(report), /private-|Hello!|unchanged chat|Return exactly/);
});
test('invalid replies do not enter medians and unavailable PowerShell is explicit', async () => {
  const client = new GeminiClient('https://fixture.invalid', 'key', 1000, async () => new Response('{"choices":[{"message":{"content":"private-unexpected"},"finish_reason":"stop"}]}'));
  const report = await compareTransportTiming(client, 'fixture', 'Review', environment, new AbortController().signal, () => {}, async () => undefined);
  assert.equal(report.powerShell.status, 'unavailable'); assert.equal(report.allRepliesValid, false);
  assert.equal(report.results.filter(r => r.reply === 'unavailable').length, 10);
  assert.ok(report.summary.every(s => s.medianElapsedMs === null));
  assert.doesNotMatch(JSON.stringify(report), /private-unexpected|fixture.invalid/);
});
test('cancellation during initialization closes the worker without a provider call', async () => {
  const abort = new AbortController(); let calls = 0;
  const child = worker(async () => { throw new Error('Should not call.'); });
  child.start = async () => { abort.abort(); throw new Error('private startup failure'); };
  const client = new GeminiClient('https://fixture.invalid', 'key', 1000, async () => { calls++; throw new Error(); });
  const report = await compareTransportTiming(client, 'fixture', 'Review', environment, abort.signal, () => {}, async () => child);
  assert.equal(report.cancelled, true); assert.equal(report.completed, false); assert.equal(report.results.length, 0);
  assert.equal(calls, 0); assert.ok(child.closes > 0); assert.doesNotMatch(JSON.stringify(report), /private/);
});
test('failed initialization and transport death are explicit and never restart the worker', async () => {
  for (const startupFailure of [true,false]) {
    let workerCalls = 0;
    const child = worker(async () => { workerCalls++; await child.close(); throw new Error('private worker failure'); });
    if (startupFailure) child.start = async () => { child.starts++; throw new Error('private startup failure'); };
    const client = new GeminiClient('https://fixture.invalid', 'key', 1000, async () => new Response(sse));
    const report = await compareTransportTiming(client, 'fixture', 'Review', environment, new AbortController().signal, () => {}, async () => child);
    assert.equal(report.powerShell.status, startupFailure ? 'startup-failed' : 'stopped');
    assert.equal(child.starts, 1); assert.equal(workerCalls, startupFailure ? 0 : 1);
    assert.equal(report.summary.filter(s => s.variant.startsWith('vscode')).reduce((n,s) => n + s.validReplies,0),10);
    assert.doesNotMatch(JSON.stringify(report), /private/);
  }
});
test('cancellation retains completed measurements; authentication/rate rejection stops the comparison', async () => {
  for (const status of [200,401,403,429]) {
    const abort = new AbortController(); let calls = 0;
    const transport: typeof fetch = async () => { calls++; if(status === 200 && calls === 2) abort.abort(); return new Response(status === 200 ? sse : 'private-error', { status }); };
    const child = worker(transport);
    const report = await compareTransportTiming(new GeminiClient('https://fixture.invalid','key',1000,transport), 'fixture','Review',environment,abort.signal,()=>{},async()=>child);
    assert.equal(calls,status===200?2:1); assert.equal(report.completed,false); assert.ok(child.closes > 0);
    assert.equal(report.results.length,calls); assert.equal(report.cancelled,status===200);
  }
});
test('header categories reject private values and survive sanitized persistence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'codeeko-header-test-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const metadata = transportMetadata(new Headers({ 'content-type':'text/event-stream; boundary=private', 'content-encoding':'private-encoding', 'transfer-encoding':'private-transfer', 'content-length':'private-length', 'set-cookie':'private-cookie' }));
  assert.deepEqual(metadata,{contentType:'event-stream',contentEncoding:'other',transferEncoding:'other'});
  assert.equal(transportMetadata(new Headers({'content-encoding':'gzip, br'})).contentEncoding,'multiple');
  const log = new PerformanceDiagnostics(); await log.configure(root,'test');
  log.finish(log.begin('completion','Standard',1000),{responseHeaders:metadata}); await log.flush();
  const again = new PerformanceDiagnostics(); await again.configure(root,'test');
  assert.deepEqual(again.snapshot().requests[0].responseHeaders,metadata);
  assert.doesNotMatch(JSON.stringify(again.snapshot()),/private/);
  assert.doesNotMatch(JSON.stringify(transportEnvironment({...environment,proxyUrl:'private-proxy',nodeVersion:'v24.0.0'})),/private-proxy/);
});
