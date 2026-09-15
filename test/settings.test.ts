import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';

test('settings tab validates writes, reuses its panel and never exposes keys', async () => {
  const values: Record<string, unknown> = {}, sent: any[] = [], calls: string[] = [];
  let receive: (m:any)=>Promise<void> = async()=>{}, disposed=()=>{}, changed:(e:any)=>void=()=>{}, panels=0, reveals=0, busy=false;
  const disposable={dispose(){}};
  const panel={reveal(){reveals++;},dispose(){disposed();},onDidDispose(fn:()=>void){disposed=fn;return disposable;},webview:{html:'',onDidReceiveMessage(fn:typeof receive){receive=fn;return disposable;},postMessage(m:any){sent.push(m);return Promise.resolve(true);}}};
  const mock={ViewColumn:{Active:1},ConfigurationTarget:{Global:1},window:{createWebviewPanel(){panels++;return panel;}},commands:{executeCommand:async(name:string)=>{calls.push(name);}},workspace:{getConfiguration:(namespace:string)=>{assert.equal(namespace,'ekod');return ({get:(key:string,fallback:unknown)=>values[key]??fallback,update:async(key:string,value:unknown,target:number)=>{assert.equal(target,1);values[key]=value;}});},onDidChangeConfiguration(fn:typeof changed){changed=fn;return disposable;}}};
  const Module=require('node:module'),original=Module._load;
  Module._load=function(name:string,...args:any[]){return name==='vscode'?mock:original.call(this,name,...args);};
  let settings: typeof import('../src/ui/settings');
  try{settings=require('../src/ui/settings');}finally{Module._load=original;}
  const page=new settings.SettingsPage(()=>busy, async()=>{calls.push('openRejectedLogs');return 'Revealed capture.';});page.open();page.open();assert.equal(panels,1);assert.equal(reveals,1);
  await receive({type:'ready'});assert.equal(sent.at(-1).values.endpoint,'');assert.equal(sent.at(-1).values.requestTimeout,300000);assert.equal(sent.at(-1).values.compatibilityMode,'User message');
  for(const [key,value] of [['apiKey','private-key'],['permissionMode','Custom'],['compatibilityMode','Unsupported'],['endpoint','http://example.test'],['endpoint','https://user:password@example.test'],['requestTimeout',0],['requestTimeout',NaN],['installValidationModules','true']]){
    await receive({type:'save',key,value});assert.equal(sent.at(-1).failed,true);assert.equal(Object.keys(values).length,0);
  }
  await receive({type:'save',key:'endpoint',value:'https://example.test/v1'});assert.equal(values.endpoint,'https://example.test/v1');
  await receive({type:'save',key:'compatibilityMode',value:'User message'});assert.equal(values.compatibilityMode,'User message');
  await receive({type:'save',key:'installValidationModules',value:true});assert.equal(values.installValidationModules,true);
  busy=true;await receive({type:'save',key:'permissionMode',value:'Full access'});assert.equal(values.permissionMode,undefined);assert.match(sent.at(-1).notice,/running task/);busy=false;
  await receive({type:'setKey'});await receive({type:'export'});assert.deepEqual(calls,['ekod.setKey','ekod.exportStartupDiagnostics']);
  busy=true;await receive({type:'openRejectedLogs',path:'untrusted-path'});assert.equal(calls.at(-1),'openRejectedLogs');assert.equal(sent.at(-1).notice,'Revealed capture.');busy=false;
  values.model='external-change';changed({affectsConfiguration:()=>true});assert.equal(sent.at(-1).values.model,'external-change');
  assert.ok(!JSON.stringify(sent).includes('private-key'));
  const script=/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(panel.webview.html)![1];assert.doesNotThrow(()=>new vm.Script(script));
  assert.ok(panel.webview.html.includes("default-src 'none'"));page.dispose();page.open();assert.equal(panels,2);page.dispose();
});
