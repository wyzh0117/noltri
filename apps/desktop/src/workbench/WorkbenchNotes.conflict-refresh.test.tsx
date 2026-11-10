import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';

const css = ['workbench.css', 'notes-workbench.css', 'mindmap-view.css'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
import {WorkbenchNotes} from './WorkbenchNotes';
const style=document.createElement('style');style.textContent=${JSON.stringify(css)}+'\\n#root{height:660px}.conflict-fixture{height:640px;width:1100px}';document.head.append(style);
const path='Synthetic Conflict.md';
const original='# Synthetic Conflict\\n\\noriginal marker.\\n';
const external='# Synthetic Conflict\\n\\nexternal marker.\\n';
let root, content=original, etag='etag-1', revision=1, changes=[], holdSnapshot=false, snapshotHeld=false, snapshotCompleted=true, releaseSnapshot, failNextSnapshot=false, resetNext=false;
const file=()=>({path,content,mtime:1,ctime:1,size:content.length,etag,metadata:{frontmatter:{},headings:[{heading:'Synthetic Conflict',level:1,position:{start:{offset:0}}}],tags:[],links:[],blocks:{}}});
const snapshot=()=>({rootPath:'/synthetic-conflict-vault',files:[{path,name:path,kind:'file',extension:'md',mtime:1,size:content.length}],revision});
const api={
 vaultSnapshot:async()=>{if(failNextSnapshot){failNextSnapshot=false;snapshotCompleted=true;throw Error('Synthetic transient snapshot failure');}if(holdSnapshot){holdSnapshot=false;snapshotHeld=true;await new Promise(resolve=>releaseSnapshot=resolve);}snapshotCompleted=true;return snapshot();},
 vaultFile:async()=>file(),vaultSettings:async()=>({newLinkFormat:'shortest',propertyTypes:{}}),
 vaultMetadata:async()=>({path,metadata:file().metadata}),vaultBacklinks:async()=>({revision,backlinks:[]}),vaultMentions:async()=>({mentions:[]}),vaultHistory:async()=>({versions:[]}),
 vaultChanges:async()=>{const events=changes;changes=[];const reset=resetNext;resetNext=false;return{revision,reset,events};},
 saveVaultFile:async()=>{throw Object.assign(new Error('Synthetic ETag conflict'),{status:409});},
};
let props;
function mount(){root?.unmount();localStorage.clear();content=original;etag='etag-1';revision=1;changes=[];holdSnapshot=false;snapshotHeld=false;snapshotCompleted=true;releaseSnapshot=null;failNextSnapshot=false;resetNext=false;window.confirm=()=>true;root=createRoot(document.getElementById('root'));props={api,active:true,requestedOpen:{path,intent:{newTab:false,split:false},id:1},scopePaths:null,scopeTitle:null,libraryView:'all',tagQuery:null,vaultTagCounts:new Map(),onContextChange:()=>{}};root.render(<div className="conflict-fixture"><WorkbenchNotes {...props}/></div>);}
window.harness={mount,editDraft(){const view=EditorView.findFromDOM(document.querySelector('.cm-editor'));view.dispatch({changes:{from:view.state.doc.length,insert:'\\nlocal draft marker.'}});},triggerExternalChange(){content=external;etag='etag-2';revision++;snapshotCompleted=false;holdSnapshot=true;changes=[{path}];},triggerSnapshotFailure(){snapshotCompleted=false;failNextSnapshot=true;resetNext=true;},retrySnapshot(){snapshotCompleted=false;resetNext=true;},releaseSnapshot(){releaseSnapshot?.();},state(){return{snapshotHeld,snapshotCompleted,body:document.querySelector('.cm-content')?.innerText??'',status:document.querySelector('.vault-save-indicator')?.textContent?.trim()??null,error:document.querySelector('.vault-inline-error')?.innerText?.trim()??null,reloadAvailable:[...document.querySelectorAll('.vault-inline-error button')].some(button=>button.textContent.trim()==='重新载入外部版本')};}};
`;
const browser = createReviewBrowser(harness, fileURLToPath(new URL('.', import.meta.url)));
const state = () => browser.evaluate<any>('window.harness.state()');

describe('WorkbenchNotes background snapshot conflict ownership', () => {
  beforeAll(() => browser.start(), 30_000);
  afterAll(() => browser.close());

  it('keeps the conflict warning and explicit reload action after a successful snapshot refresh', async () => {
    await browser.evaluate('window.harness.mount()');
    await browser.until(state, value => value.body.includes('original marker.'), 5_000);
    await browser.evaluate('window.harness.editDraft()');
    await browser.until(state, value => value.status === '外部冲突' && value.error?.includes('文件在外部发生更改'), 5_000);
    await browser.evaluate('window.harness.triggerExternalChange()');
    await browser.until(state, value => value.snapshotHeld && value.status === '外部冲突', 5_000);
    const whileRefreshing = await state();
    expect(whileRefreshing.error).toContain('文件在外部发生更改');
    await browser.evaluate('window.harness.releaseSnapshot()');
    await browser.until(state, value => value.snapshotCompleted, 5_000);
    const conflicted = await state();
    expect(conflicted.status).toBe('外部冲突');
    expect(conflicted.body).toContain('local draft marker.');
    expect(conflicted.error).toContain('文件在外部发生更改');
    expect(conflicted.reloadAvailable).toBe(true);
    await browser.evaluate("[...document.querySelectorAll('.vault-inline-error button')].find(button=>button.textContent.trim()==='重新载入外部版本').click()");
    await browser.until(state, value => value.body.includes('external marker.') && value.status === '已保存' && value.error === null, 5_000);
    expect((await state()).body).not.toContain('local draft marker.');

    await browser.evaluate('window.harness.mount()');
    await browser.until(state, value => value.body.includes('original marker.'), 5_000);
    await browser.evaluate('window.harness.triggerSnapshotFailure()');
    await browser.until(state, value => value.error?.includes('Synthetic transient snapshot failure'), 5_000);
    await browser.evaluate('window.harness.retrySnapshot()');
    await browser.until(state, value => value.snapshotCompleted && value.error === null, 5_000);
    expect((await state()).status).toBe('已保存');
    expect(browser.errors).toEqual([]);
  });
});
