import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';
const harness = String.raw`
import React from 'react';
import { createRoot } from 'react-dom/client';
import WorkbenchApp from ${JSON.stringify(fileURLToPath(new URL('./WorkbenchApp.tsx', import.meta.url)))};
import { buildMcpConnectionConfiguration } from ${JSON.stringify(fileURLToPath(new URL('./mcp-connection-configuration.ts', import.meta.url)))};
let root,calls=[],copies=[],copyCalls=0,clipboardReads=[],nativeCalls=[],logs=[],options={};
const token='generated-synthetic-device-credential';
const endpoint='http://127.0.0.1:18890/mcp';
for(const name of ['log','warn','error'])console[name]=(...args)=>{logs.push(args.map(String).join(' '));};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
 read:async()=>{clipboardReads.push('read');throw Error('Synthetic clipboard read denied');},
 readText:async()=>{clipboardReads.push('readText');throw Error('Synthetic clipboard read denied');},
 write:async()=>{throw Error('Synthetic clipboard write denied');},
 writeText:async text=>{if(options.reject)throw Error('Synthetic permission failure '+token);copies.push(text);},
}});
window.__TAURI_INTERNALS__={invoke:async(command)=>{nativeCalls.push(command);throw Error('Unexpected synthetic native call');},transformCallback:()=>1};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
const known={
 tree:async()=>({rootId:null,totalNodes:0,nodes:[]}),listItems:async()=>({items:[],limit:200,offset:0}),
 health:async()=>({status:'ok',productId:'synthetic-test',instanceId:'synthetic-test',protocolVersion:'1',version:'0',storageDriver:'memory',storage:{driver:'memory',ok:true,detail:{}},aiProvider:'disabled',embeddingDim:0,requiresAiKey:false}),
 vaultSnapshot:async()=>({rootPath:'/synthetic-mcp-copy-vault',files:[],revision:0}),
 vaultSettings:async()=>({newLinkFormat:'shortest',propertyTypes:{}}),
 vaultDiagnostics:async()=>({revision:0,indexing:false,queued:0,failedFiles:[],lastIndexedAt:null,cache:{loaded:true,persisted:false,entries:0},worker:{restarts:0,timeouts:0}}),
 vaultChanges:async()=>({revision:0,reset:false,events:[]}),
};
const api=new Proxy({}, {get(_target,name){return (...args)=>{calls.push(String(name));if(!(name in known))return Promise.reject(Error('Unexpected fake API: '+String(name)));return known[name](...args);};}});
window.harness={
 mount(opts={}){root?.unmount();options=opts;calls=[];copies=[];copyCalls=0;clipboardReads=[];nativeCalls=[];logs=[];localStorage.clear();root=createRoot(document.getElementById('root'));const copy=opts.noCallback?undefined:async()=>{copyCalls++;await navigator.clipboard.writeText(buildMcpConnectionConfiguration(opts.invalidEndpoint?'https://example.invalid/mcp':endpoint,opts.invalidToken?'':token));};root.render(<WorkbenchApp api={api} apiBaseUrl="http://127.0.0.1:1" mcpEndpoint={endpoint} tokenConfigured={!opts.unconfigured} outsideTauri onCopyMcpConfiguration={copy}/>);},
 click(label){const el=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===label||x.textContent.trim().endsWith(label)||x.getAttribute('aria-label')===label);if(!el)throw Error('Missing button: '+label);el.click();},
 connection(){document.querySelector('.connection-details').open=true;},
 state:()=>({copies,copyCalls,clipboardReads,nativeCalls,logs,text:document.body.innerText,html:document.body.innerHTML,calls}),
};
`;
const browser = createReviewBrowser(harness, fileURLToPath(new URL('../..', import.meta.url)));
const { evaluate, until } = browser;
const state = () => evaluate<{ copies: string[]; copyCalls: number; clipboardReads: string[]; nativeCalls: string[]; logs: string[]; text: string; html: string; calls: string[] }>('window.harness.state()');
const click = (label: string) => evaluate(`window.harness.click(${JSON.stringify(label)})`);
async function open(options: object = {}): Promise<void> {
  await evaluate(`window.harness.mount(${JSON.stringify(options)})`);
  await until(state, s => s.calls.includes('vaultSnapshot'));
  await click('Provider 管理');
  await until(() => evaluate<boolean>("!!document.querySelector('.connection-details')"), Boolean);
  await evaluate('window.harness.connection()');
}
const copyLabel = '复制MCP连接配置（含本机凭据）';
describe('explicit authenticated MCP copy in real App', () => {
  beforeAll(() => browser.start(), 30_000);
  afterAll(() => browser.close());
  it('copies the private closure configuration only on the named gesture and keeps URL-only copy honest', async () => {
    await open();
    const initial = await state();
    expect(initial.copyCalls).toBe(0);expect(initial.copies).toEqual([]);
    expect(initial.text).toMatch(/仅.*地址.*(?:无法|不能).*认证/);
    expect(initial.html).not.toContain('generated-synthetic-device-credential');
    await click('重新检查连接');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    expect((await state()).copyCalls).toBe(0);
    await click('复制入口地址');
    expect((await state()).copies).toEqual(['http://127.0.0.1:18890/mcp']);expect((await state()).copyCalls).toBe(0);
    await click(copyLabel);
    await until(state, s => s.copyCalls === 1 && s.copies.length === 2);
    const copied = await state();
    expect(copied.copies[1]).toBe('[mcp_servers.noltri]\nurl = "http://127.0.0.1:18890/mcp"\nhttp_headers = { Authorization = "Bearer generated-synthetic-device-credential" }\n');
    expect(copied.text).toContain('连接配置已复制');
    expect(copied.html).not.toContain('generated-synthetic-device-credential');expect(copied.logs.join('\n')).not.toContain('generated-synthetic-device-credential');
    expect(copied.clipboardReads).toEqual([]);expect(copied.nativeCalls).toEqual([]);
  });
  it('only offers credential copy when both callback and authorization metadata are present', async () => {
    for (const options of [{ unconfigured: true }, { noCallback: true }]) {
      await open(options);
      expect(await evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(copyLabel)})`)).toBe(false);
      expect((await state()).copyCalls).toBe(0);expect((await state()).copies).toEqual([]);
    }
  });
  it('reports only generic failure metadata and leaves the clipboard untouched for invalid credentials or rejection', async () => {
    for (const options of [{ invalidToken: true }, { invalidEndpoint: true }, { reject: true }]) {
      await open(options);await click(copyLabel);
      await until(state, s => s.text.includes('复制连接配置失败'));
      const failed = await state();
      expect(failed.copyCalls).toBe(1);expect(failed.copies).toEqual([]);
      expect(failed.html).not.toContain('generated-synthetic-device-credential');expect(failed.logs.join('\n')).not.toContain('generated-synthetic-device-credential');expect(failed.text).not.toContain('Synthetic permission failure');
      expect(failed.clipboardReads).toEqual([]);expect(failed.nativeCalls).toEqual([]);
    }
  });
});
