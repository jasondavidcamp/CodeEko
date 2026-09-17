import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { PowerShellTransport } from '../src/api/powerShellTransport';
import { powerShellProbeScript } from '../src/api/powerShellProbeScript';
import { GeminiClient } from '../src/api/client';
import { RequestTiming } from '../src/state/performanceDiagnostics';

const answer = JSON.stringify({ version:1,tool:'complete_task',args:{summary:'Hello ☃'} });
const sse = 'data: ' + JSON.stringify({ choices:[{delta:{content:answer},finish_reason:'stop'}] })+'\n\ndata: [DONE]\n\n';
const windowsPowerShell = path.join(process.env.SystemRoot ?? 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
// Only this in-memory fixture copy permits HTTP. Shipped code always requires HTTPS.
const loopbackScript = powerShellProbeScript.replace("$address.Scheme -ne 'https'", "$address.Scheme -ne 'http'")
  .replace('$inputData = ConvertFrom-Json -InputObject $line', "$inputData = ConvertFrom-Json -InputObject $line\n$inputData.url = ([string]$inputData.url).Replace('https://127.0.0.1:', 'http://127.0.0.1:')");

for (const engine of ['Windows PowerShell 5.1','PowerShell 7']) {
  test(`${engine} worker streams mislabeled SSE, compression and errors; cancellation owns only its child`, { skip:process.platform!=='win32',timeout:60000 }, async t => {
    const exe = engine === 'Windows PowerShell 5.1' ? windowsPowerShell : path.join(process.env.ProgramFiles ?? 'C:/Program Files','PowerShell/7/pwsh.exe');
    try { await fs.access(exe); } catch { t.skip('PowerShell engine is unavailable.'); return; }
    const sent: { body:string; encoding?:string; contentType?:string }[]=[];
    let scenario='delayed';
    const server=createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;
      sent.push({body,encoding:req.headers['accept-encoding'],contentType:req.headers['content-type']});
      if(scenario==='redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/private'});res.end();return;}
      if(scenario==='error'){res.writeHead(429);res.end('private-error');return;}
      if(scenario==='gzip'){res.writeHead(200,{'Content-Type':'text/event-stream','Content-Encoding':'gzip'});res.end(gzipSync(sse));return;}
      res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();
      if(scenario==='stall')return;
      if(scenario==='invalid'){res.end('private-invalid');return;}
      await delay(250);if(res.destroyed)return;res.write(': heartbeat\n\n');
      await delay(150);if(res.destroyed)return;res.end(sse);
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>{server.closeAllConnections();server.close();});
    const port=(server.address() as {port:number}).port;
    const worker=new PowerShellTransport(exe,3000,loopbackScript);t.after(()=>worker.close());
    await worker.start(new AbortController().signal);
    assert.match(worker.metadata!.version,engine==='Windows PowerShell 5.1'?/^5\.1\./:/^7\./);
    const client=new GeminiClient(`https://127.0.0.1:${port}`,'private-fixture-key',3000,worker.fetch);
    const messages=[{role:'user' as const,content:'synthetic-fixture'}];
    let timing:RequestTiming|undefined;
    const probe=client.forTransportProbe('default',()=>{});
    assert.equal(await probe.probe('fixture',messages,4096,new AbortController().signal,r=>{timing=r;}),answer);
    await worker.settled();
    assert.ok(timing!.firstBodyByteMs!-timing!.headersMs!>=180);assert.ok(timing!.firstContentMs!>timing!.firstBodyByteMs!);
    assert.equal(timing!.responseHeaders?.contentType,'json');assert.equal(timing!.streamed,true);
    assert.ok(worker.measurement.firstBodyByteMs!-worker.measurement.headersMs!>=180);
    assert.equal(sent[0].encoding,undefined);assert.equal(sent[0].contentType,'application/json');
    scenario='gzip';
    assert.equal(await client.forTransportProbe('identity',()=>{}).probe('fixture',messages,4096,new AbortController().signal,r=>{timing=r;}),answer);
    await worker.settled();assert.equal(sent[1].encoding,'identity');assert.equal(sent[0].body,sent[1].body);
    assert.equal(timing!.responseHeaders?.contentEncoding,'gzip');
    scenario='invalid';await assert.rejects(probe.probe('fixture',messages,4096,new AbortController().signal,r=>{timing=r;}));await worker.settled();
    assert.equal(timing!.outcome,'failed');assert.doesNotMatch(JSON.stringify(timing),/private/);
    scenario='redirect';await assert.rejects(probe.probe('fixture',messages,4096,new AbortController().signal,r=>{timing=r;}),/HTTP 302/);await worker.settled();assert.equal(timing!.status,302);
    scenario='error';await assert.rejects(probe.probe('fixture',messages,4096,new AbortController().signal,r=>{timing=r;}),/HTTP 429/);await worker.settled();
    assert.doesNotMatch(JSON.stringify(timing),/private/);
    scenario='stall';const abort=new AbortController();const started=Date.now();
    const pending=probe.probe('fixture',messages,4096,abort.signal,r=>{timing=r;});setTimeout(()=>abort.abort(),200);
    await assert.rejects(pending,/Cancelled/);await worker.close();assert.equal(worker.usable,false);assert.ok(Date.now()-started<2500);
    assert.equal(timing!.outcome,'cancelled');await assert.rejects(worker.fetch('https://fixture.invalid',{method:'POST',body:'{}'}),/unavailable/);
  });
}
test('PowerShell initialization is abortable and a failed launch never exposes raw stderr', {skip:process.platform!=='win32',timeout:15000},async()=>{
  const worker=new PowerShellTransport(windowsPowerShell,1000,'Start-Sleep -Seconds 60');
  const abort=new AbortController();const pending=worker.start(abort.signal);setTimeout(()=>abort.abort(),100);
  await assert.rejects(pending,/worker stopped/);await worker.close();assert.equal(worker.usable,false);
  const absent=new PowerShellTransport('C:/missing-private-path/worker.exe',1000);
  await assert.rejects(absent.start(new AbortController().signal),/worker stopped/);await absent.close();
});
