import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';

// Real WorkbenchApp, IntakeWindow, adapters and queue; only OS IPC and API are synthetic.
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import WorkbenchApp from ${JSON.stringify(fileURLToPath(new URL('./WorkbenchApp.tsx', import.meta.url)))};
let root, snapshot, holdSnapshot, releaseSnapshot, imageFailure, calls=[], traces=[], reads=0;
let holdAxRegistration=false, releaseAxRegistration=null;const listenerSequence=[];
const callbacks=new Map(), listeners=new Map();let nextCallback=0;
const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));
Object.defineProperty(navigator,'clipboard',{configurable:true,value:Object.fromEntries(['read','readText','write','writeText'].map(name=>[name,async()=>{reads++;throw Error('Real clipboard API forbidden in synthetic test');}]))});
window.__TAURI_INTERNALS__={transformCallback:callback=>{callbacks.set(++nextCallback,callback);return nextCallback;},invoke:async(command,args={})=>{
 calls.push(command);
 if(command==='plugin:event|listen'){listenerSequence.push('listen:'+args.event);if(args.event==='noltri-ax-selection-accepted'&&holdAxRegistration)return new Promise(resolve=>{releaseAxRegistration=()=>{listeners.set(args.handler,args.event);listenerSequence.push('registered:'+args.event);resolve(args.handler);};});listeners.set(args.handler,args.event);listenerSequence.push('registered:'+args.event);return args.handler;}
 if(command==='plugin:event|unlisten')return;
 if(command==='start_ax_selection_offers_if_enabled'){listenerSequence.push('start:ax-listener='+[...listeners.values()].includes('noltri-ax-selection-accepted'));return {enabled:false,permission:'not_checked'};}
 if(command==='get_intake_shortcut_status')return {screenshot:'registered',openIntake:'registered'};
 if(command==='trace_capture_stage'){traces.push({stage:args.stage,errorCode:args.errorCode});return;}
 if(command==='snapshot_system_clipboard'){if(holdSnapshot)await new Promise(resolve=>releaseSnapshot=resolve);return structuredClone(snapshot);}
 if(command==='take_clipboard_snapshot'){if(imageFailure)throw Error('Synthetic image handoff failure');return Array.from(png);}
 if(command==='begin_screen_capture')return {status:'captured',captureId:'synthetic-screen',mimeType:'image/png',byteLength:png.length,capturedAt:'2026-11-04T00:00:00Z',clipboardCopied:true,source:null};
 if(command==='take_screen_capture_bytes')return Array.from(png);
 throw Error('Unexpected synthetic IPC: '+command);
}};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(event,id)=>{listenerSequence.push('unlisten:'+event);listeners.delete(id);callbacks.delete(id);}};
const api={tree:async()=>({rootId:null,nodes:[],totalNodes:0}),health:async()=>({status:'ok',productId:'synthetic',instanceId:'synthetic',protocolVersion:'1',version:'0',storageDriver:'memory',storage:{driver:'memory',ok:true,detail:{}},aiProvider:'disabled',embeddingDim:0,requiresAiKey:false}),listItems:async()=>({items:[],limit:200,offset:0}),vaultSnapshot:async()=>({rootPath:'/synthetic',files:[],revision:0}),vaultSettings:async()=>({newLinkFormat:'shortest',propertyTypes:{}}),vaultDiagnostics:async()=>({indexing:false,queued:0,failedFiles:[]}),vaultChanges:async()=>({revision:0,reset:false,events:[]})};
const render=()=>root.render(<WorkbenchApp api={api} apiBaseUrl="http://127.0.0.1:1" mcpEndpoint="" tokenConfigured={false} outsideTauri={false}/>);
window.harness={
 mount(value,hold=false,failImage=false){root?.unmount();calls=[];traces=[];reads=0;listenerSequence.length=0;listeners.clear();callbacks.clear();snapshot=value;holdSnapshot=hold;imageFailure=failImage;releaseSnapshot=null;releaseAxRegistration=null;localStorage.clear();root=createRoot(document.querySelector('#root'));render();},
 holdAxListener(){holdAxRegistration=true;},
 releaseAxListener(){holdAxRegistration=false;if(!releaseAxRegistration)throw Error('AX listener registration is not pending');releaseAxRegistration();releaseAxRegistration=null;},
 axRegistrationPending:()=>releaseAxRegistration!==null,
 unmount(){root?.unmount();root=null;},
 ready:()=>[...listeners.values()].includes('noltri-intake-activation'),
 activate(action,id){const entry=[...listeners].find(([,event])=>event==='noltri-intake-activation');if(!entry)throw Error('Listener not ready');callbacks.get(entry[0])({event:entry[1],id:entry[0],payload:{action,requestId:id}});},
 release(){holdSnapshot=false;releaseSnapshot();releaseSnapshot=null;},
 rerender:render,
 remember(){window.retainedIntake=document.querySelector('.intake-window');},
 state:()=>({text:document.querySelector('#intake-original-text')?.value??null,images:document.querySelectorAll('.intake-image-row').length,notice:document.querySelector('.intake-capture-notice')?.textContent??'',same:window.retainedIntake===document.querySelector('.intake-window'),calls:[...calls],traces:[...traces],clipboardAPICalls:reads,listenerSequence:[...listenerSequence]}),
};
`;
const browser = createReviewBrowser(harness, fileURLToPath(new URL('../..', import.meta.url)));
const { evaluate, until } = browser;
type State = { text: string | null; images: number; notice: string; same: boolean; calls: string[]; traces: Array<{ stage: string; errorCode?: string }>; clipboardAPICalls: number; listenerSequence: string[] };
const state = () => evaluate<State>('window.harness.state()');
const available = (text?: string, image = false) => ({ status: 'available', snapshotId: 'synthetic-clipboard', capturedAt: '2026-11-04T00:00:00Z', source: null, ...(text === undefined ? {} : { text }), ...(image ? { imageMimeType: 'image/png' } : {}) });
async function mount(snapshot: object, hold = false, failImage = false): Promise<void> {
  await evaluate(`window.harness.mount(${JSON.stringify(snapshot)},${hold},${failImage})`);
  await until(() => evaluate<boolean>('window.harness.ready()'), Boolean);
}
const activate = (action: string, id: string) => evaluate(`window.harness.activate(${JSON.stringify(action)},${JSON.stringify(id)})`);
async function finishV(): Promise<State> {
  return until(state, value => value.calls.includes('snapshot_system_clipboard') && value.notice.length > 0);
}
async function finishS(): Promise<State> {
  return until(state, value => value.images > 0 && value.traces.some(trace => trace.stage === 'busy_release'));
}

describe('synthetic native clipboard to real intake editor', () => {
  beforeAll(() => browser.start(), 30_000);
  afterAll(() => browser.close());

  it('starts persisted AX offers after the main listener is registered and cancels startup on unmount', async () => {
    await evaluate('window.harness.holdAxListener()');
    await evaluate(`window.harness.mount(${JSON.stringify(available('Synthetic startup ordering.'))})`);
    await until(() => evaluate<boolean>('window.harness.axRegistrationPending()'), Boolean);
    expect((await state()).calls).not.toContain('start_ax_selection_offers_if_enabled');
    await evaluate('window.harness.releaseAxListener()');
    const started = await until(state, value => value.calls.includes('start_ax_selection_offers_if_enabled'));
    const registered = started.listenerSequence.indexOf('registered:noltri-ax-selection-accepted');
    const start = started.listenerSequence.indexOf('start:ax-listener=true');
    expect(registered).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(registered);

    await evaluate('window.harness.holdAxListener()');
    await evaluate(`window.harness.mount(${JSON.stringify(available('Synthetic canceled startup.'))})`);
    await until(() => evaluate<boolean>('window.harness.axRegistrationPending()'), Boolean);
    await evaluate('window.harness.unmount();window.harness.releaseAxListener();new Promise(resolve=>setTimeout(resolve,20))');
    const canceled = await state();
    expect(canceled.calls).not.toContain('start_ax_selection_offers_if_enabled');
    expect(canceled.listenerSequence).toContain('unlisten:noltri-ax-selection-accepted');
  });

  it('retains V text in the same intake when S queues an image three seconds later', async () => {
    await mount(available('Synthetic V text retained through S.'));
    await activate('openIntake', 'synthetic-v-normal');
    expect((await finishV()).text).toBe('Synthetic V text retained through S.');
    await evaluate('window.harness.remember();window.harness.rerender();new Promise(resolve=>setTimeout(resolve,3000))');
    await activate('capture', 'synthetic-s-normal');
    const result = await finishS();
    expect(result).toMatchObject({ text: 'Synthetic V text retained through S.', images: 1, same: true, clipboardAPICalls: 0 });
    expect(result.calls.filter(call => call === 'snapshot_system_clipboard')).toHaveLength(1);
  });

  it('rejects a fast S while V is pending and retains text when the later S is admitted', async () => {
    await mount(available('Synthetic deferred V text.'), true);
    await activate('openIntake', 'synthetic-v-held');
    await until(state, value => value.calls.includes('snapshot_system_clipboard'));
    await activate('capture', 'synthetic-s-too-early');
    await until(state, value => value.traces.some(trace => trace.stage === 'state_check' && trace.errorCode === 'busy'));
    expect((await state()).calls).not.toContain('begin_screen_capture');
    await evaluate('window.harness.release()');
    expect((await finishV()).text).toBe('Synthetic deferred V text.');
    await activate('capture', 'synthetic-s-after-v');
    expect(await finishS()).toMatchObject({ text: 'Synthetic deferred V text.', images: 1, clipboardAPICalls: 0 });
  });

  it.each(['empty', 'denied', 'failed', 'image-only', 'whitespace'])('leaves raw text empty for %s V and preserves S image', async (kind) => {
    await mount(kind === 'image-only' ? available(undefined, true) : kind === 'whitespace' ? available(' \n\t') : { status: kind });
    await activate('openIntake', 'synthetic-v-' + kind);
    const before = await finishV();
    expect(before.text).toBe('');
    if (kind === 'image-only') expect(before.images).toBe(1);
    await activate('capture', 'synthetic-s-' + kind);
    const after = await finishS();
    expect(after.text).toBe('');
    expect(after.images).toBe(kind === 'image-only' ? 2 : 1);
    expect(after.notice).toContain('截图已复制到剪贴板');
    expect(after.clipboardAPICalls).toBe(0);
  });

  it('imports valid native text when its companion image cannot be consumed before S', async () => {
    await mount(available('Synthetic mixed snapshot text.' , true), false, true);
    await activate('openIntake', 'synthetic-v-image-failure');
    expect((await finishV()).text).toBe('Synthetic mixed snapshot text.');
    await activate('capture', 'synthetic-s-after-image-failure');
    expect(await finishS()).toMatchObject({ text: 'Synthetic mixed snapshot text.', images: 1, clipboardAPICalls: 0 });
  });
});
