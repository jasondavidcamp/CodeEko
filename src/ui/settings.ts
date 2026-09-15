import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { apiBase } from '../api/client';

export const settingsFields = [
  { key: 'endpoint', group: 'Connection', label: 'API endpoint', description: 'Your HTTPS API base URL. No endpoint is supplied by default.', value: '' },
  { key: 'model', group: 'Connection', label: 'Model', description: 'Use the model picker in chat to discover models, or enter an exact model ID here.', value: '' },
  { key: 'requestTimeout', group: 'Connection', label: 'Request timeout', description: 'Milliseconds to wait for a model request (1,000–300,000).', value: 60000 },
  { key: 'permissionMode', group: 'Permissions', label: 'Permission mode', description: 'Review is read-only. Workspace confirms destructive edits. Full access permits implemented repository operations without those confirmations. Path and unsaved-buffer checks still apply.', value: 'Full access', options: ['Review', 'Workspace', 'Full access'] },
  { key: 'pesterVersion', group: 'Validation', label: 'Pester version', description: 'Auto uses the newest installed supported version. A missing selected version is reported.', value: 'Auto', options: ['Auto', '4', '5'] },
  { key: 'validationExecutionPolicy', group: 'Validation', label: 'Execution policy', description: 'Inherit workstation policy, or use RemoteSigned for validation processes. Machine policy is unchanged.', value: 'Inherit', options: ['Inherit', 'RemoteSigned'] },
  { key: 'installValidationModules', group: 'Validation', label: 'Install missing validation modules', description: 'Allow a CurrentUser installation attempt from PSGallery when required modules are missing.', value: false },
  { key: 'debugRejectedResponses', group: 'Diagnostics', label: 'Capture rejected model responses', description: 'Save bounded local debug captures. The configured API key is redacted, but source code and other sensitive text may remain. Turning this off stops new captures.', value: false }
];

export function validateSetting(key: unknown, value: unknown): { key: string; value: string | number | boolean } {
  const field = settingsFields.find(field => field.key === key);
  if (!field || typeof value !== typeof field.value || (field.options && !field.options.includes(value as string))) throw new Error('Choose a supported setting value.');
  if (typeof value === 'string') {
    value = value.trim();
    if ((value as string).length > 2000) throw new Error('This value is too long.');
    if (key === 'endpoint' && value) { try { apiBase(value as string); } catch { throw new Error('Use an HTTPS API URL without credentials, query parameters or fragments.'); } }
  }
  if (key === 'requestTimeout' && (!Number.isInteger(value) || (value as number) < 1000 || (value as number) > 300000)) throw new Error('Enter a timeout between 1,000 and 300,000 milliseconds.');
  return { key: field.key, value: value as string | number | boolean };
}

export class SettingsPage implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  constructor(private busy: () => boolean) {}
  open(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const panel = this.panel = vscode.window.createWebviewPanel('llmRuntime.settings', 'LLM Runtime Settings', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
    const send = (notice = '', failed = false) => {
      const config = vscode.workspace.getConfiguration('llmRuntime');
      const values = Object.fromEntries(settingsFields.map(field => [field.key, config.get(field.key, field.value)]));
      if (values.permissionMode === 'Custom') values.permissionMode = 'Review';
      void panel.webview.postMessage({ type: 'settings', values, notice, failed });
    };
    let saving = false;
    const listener = panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'ready') { send(); return; }
      if (saving) return;
      saving = true;
      try {
        if (message?.type === 'save') {
          if (this.busy()) throw new Error('Wait for the running task to finish before changing settings.');
          const setting = validateSetting(message.key, message.value);
          await vscode.workspace.getConfiguration('llmRuntime').update(setting.key, setting.value, vscode.ConfigurationTarget.Global);
          send('Saved to your VS Code user settings.');
        } else if (message?.type === 'setKey') {
          if (this.busy()) throw new Error('Wait for the running task to finish before changing the API key.');
          await vscode.commands.executeCommand('llmRuntime.setKey');
          send('API key setup closed. Keys are stored through VS Code SecretStorage.');
        } else if (message?.type === 'export') await vscode.commands.executeCommand('llmRuntime.exportStartupDiagnostics');
      } catch (error) { send(error instanceof Error && ['save', 'setKey'].includes(message?.type) ? error.message : 'The settings action could not finish.', true); }
      finally { saving = false; }
    });
    const change = vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('llmRuntime')) send(); });
    panel.onDidDispose(() => { listener.dispose(); change.dispose(); this.panel = undefined; });
    panel.webview.html = settingsHtml();
  }
  dispose(): void { this.panel?.dispose(); }
}

export function settingsHtml(): string {
  const nonce = randomBytes(16).toString('hex');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:13px/1.5 var(--vscode-font-family);display:flex;min-height:100vh}nav{width:190px;flex-shrink:0;padding:38px 16px;border-right:1px solid var(--vscode-panel-border)}nav p{font-size:11px;color:var(--vscode-descriptionForeground);margin:0 10px 22px;text-transform:uppercase;letter-spacing:1px}button,input,select{font:inherit;color:inherit}button{cursor:pointer}nav button{display:block;width:100%;text-align:left;border:0;background:transparent;padding:9px 12px;margin:3px 0;border-radius:8px}nav button[aria-current=true],nav button:hover{background:var(--vscode-list-hoverBackground)}main{width:100%;max-width:1000px;padding:45px 48px}h1{font-size:25px;font-weight:500;margin:0 0 8px}.subtitle,.description{color:var(--vscode-descriptionForeground)}.subtitle{margin:0 0 30px}.card{border:1px solid var(--vscode-panel-border);border-radius:16px;padding:0 20px;background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.row{display:flex;gap:28px;align-items:center;justify-content:space-between;padding:22px 0;border-bottom:1px solid var(--vscode-panel-border)}.row:last-child{border-bottom:0}.copy{flex:1;min-width:0}label{font-weight:600;display:block;margin-bottom:4px}.description{font-size:12px;max-width:470px}input:not([type=checkbox]),select{width:220px;max-width:100%;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));background:var(--vscode-input-background);border-radius:8px;padding:8px}input[type=checkbox]{appearance:none;width:34px;height:20px;border:1px solid var(--vscode-panel-border);border-radius:20px;background:var(--vscode-input-background);position:relative;cursor:pointer;flex-shrink:0}input[type=checkbox]:before{content:'';position:absolute;width:14px;height:14px;top:2px;left:2px;background:var(--vscode-foreground);border-radius:50%}input[type=checkbox]:checked{background:var(--vscode-button-background)}input[type=checkbox]:checked:before{left:16px;background:var(--vscode-button-foreground)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.action{padding:7px 13px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border);border-radius:8px}#notice{min-height:24px;margin-top:20px;color:var(--vscode-descriptionForeground)}#notice.error{color:var(--vscode-errorForeground)}[hidden]{display:none!important}@media(max-width:700px){nav{width:145px;padding:24px 8px}main{padding:24px 20px}.row{align-items:flex-start;flex-direction:column;gap:12px}input:not([type=checkbox]),select{width:100%}}@media(max-width:420px){body{display:block}nav{width:100%;display:flex;flex-wrap:wrap;padding:8px;border-right:0;border-bottom:1px solid var(--vscode-panel-border)}nav p{display:none}nav button{width:auto}main{padding:20px 14px}}
</style></head><body><nav aria-label="Settings sections"><p>LLM Runtime</p>${['Connection','Permissions','Validation','Diagnostics'].map(group => `<button data-group="${group}" aria-current="${group === 'Connection'}">${group}</button>`).join('')}</nav><main><h1 id="heading">Connection</h1><p class="subtitle">Configure your coding assistant. Changes save automatically.</p><div id="content"></div><p id="notice" role="status" aria-live="polite"></p></main>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(),fields=${JSON.stringify(settingsFields)},content=document.getElementById('content'),notice=document.getElementById('notice');let group='Connection',values={},pending=false;
function render(){content.replaceChildren();const card=document.createElement('div');card.className='card';content.append(card);for(const field of fields.filter(f=>f.group===group)){const row=document.createElement('div');row.className='row';const copy=document.createElement('div');copy.className='copy';const label=document.createElement('label');label.htmlFor=field.key;label.textContent=field.label;const description=document.createElement('div');description.className='description';description.id=field.key+'-description';description.textContent=field.description;copy.append(label,description);const control=document.createElement(field.options?'select':'input');control.id=field.key;control.setAttribute('aria-describedby',description.id);if(field.options){for(const value of field.options){const option=document.createElement('option');option.value=value;option.textContent=value;control.append(option);}}else control.type=typeof field.value==='boolean'?'checkbox':typeof field.value==='number'?'number':'text';if(control.type==='number'){control.min='1000';control.max='300000';}if(control.type==='checkbox'){control.checked=values[field.key]??field.value;control.setAttribute('role','switch');}else control.value=values[field.key]??field.value;control.disabled=pending;control.onchange=()=>{pending=true;notice.textContent='Saving…';for(const item of content.querySelectorAll('input,select'))item.disabled=true;vscode.postMessage({type:'save',key:field.key,value:control.type==='checkbox'?control.checked:control.type==='number'?Number(control.value):control.value});};row.append(copy,control);card.append(row);}if(group==='Connection'||group==='Diagnostics'){const row=document.createElement('div');row.className='row';const copy=document.createElement('div');copy.className='description';copy.textContent=group==='Connection'?'API keys stay in VS Code SecretStorage and are never shown on this page.':'Startup logging is automatic. Export a sanitized report to investigate loading problems.';const button=document.createElement('button');button.className='action';button.textContent=group==='Connection'?'Set API key':'Export startup diagnostics';button.onclick=()=>vscode.postMessage({type:group==='Connection'?'setKey':'export'});row.append(copy,button);card.append(row);}}
for(const button of document.querySelectorAll('nav button'))button.onclick=()=>{group=button.dataset.group;document.getElementById('heading').textContent=group;for(const item of document.querySelectorAll('nav button'))item.setAttribute('aria-current',String(item===button));render();};window.addEventListener('message',event=>{if(event.data?.type!=='settings')return;const focus=document.activeElement?.id;values=event.data.values;pending=false;notice.textContent=event.data.notice||'';notice.className=event.data.failed?'error':'';render();if(focus)document.getElementById(focus)?.focus();});render();vscode.postMessage({type:'ready'});
</script></body></html>`;
}
