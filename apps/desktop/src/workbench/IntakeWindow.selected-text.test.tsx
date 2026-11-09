import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntakeWindow } from ${JSON.stringify(fileURLToPath(new URL('./IntakeWindow.tsx', import.meta.url)))};
let root, activation, calls, clipboardReads, completed;
const statusFor=request=>({batchId:request.batchId,sessionId:request.sessionId,createdAt:'2026-11-05T00:00:00.000Z',updatedAt:'2026-11-05T00:00:00.000Z',items:request.items.map(item=>({requestId:item.requestId,kind:item.kind,userOrder:item.userOrder,assetIds:item.assetIds,status:'needs_review',duplicate:false,retryable:false,updatedAt:'2026-11-05T00:00:00.000Z'}))});
const api={createCaptureBatch:async request=>{calls.push(request);return {duplicate:false,batch:statusFor(request)};},getCaptureBatchStatus:async batchId=>statusFor(calls.at(-1))};
const clipboardAdapter={snapshot:async requestId=>{clipboardReads.push(requestId);return {status:'empty'};}};
const render=()=>root.render(<IntakeWindow api={api} paths={[]} onClose={()=>{}} onPersisted={()=>{}} activation={activation} clipboardAdapter={clipboardAdapter} onActivationComplete={id=>completed.push(id)}/>);
window.harness={
 mount(value){root?.unmount();calls=[];clipboardReads=[];completed=[];activation=value;root=createRoot(document.getElementById('root'));render();},
 setActivation(value){activation=value;render();},
 submit(){const button=[...document.querySelectorAll('button')].find(entry=>entry.textContent.trim()==='提交到知序');if(!button)throw Error('missing intake submit');button.click();},
 state(){return {text:document.querySelector('#intake-original-text')?.value,sourceApp:document.querySelector('#intake-source-app')?.value,sourceType:document.querySelector('#intake-source-type')?.value,notice:document.querySelector('.intake-capture-notice')?.textContent,calls,clipboardReads,completed};},
};
`;

const browser = createReviewBrowser(harness, fileURLToPath(new URL('../..', import.meta.url)));
const { evaluate, until } = browser;
const state = () => evaluate<any>('window.harness.state()');

beforeAll(() => browser.start(), 30_000);
afterAll(() => browser.close());

describe('selected text activation enters the existing intake flow', () => {
  it('skips clipboard, keeps the request ID, and submits source app metadata', async () => {
    const offer = { action: 'selectedText', requestId: 'ax-123e4567-e89b-12d3-a456-426614174000', text: 'Synthetic selected text from TextEdit.', sourceApp: 'TextEdit' };
    await evaluate(`window.harness.mount(${JSON.stringify(offer)})`);
    const entered = await until(state, value => value.text === offer.text && value.sourceApp === 'TextEdit' && value.sourceType === 'desktop_app');
    expect(entered.completed).toContain(offer.requestId);
    expect(entered.clipboardReads).toEqual([]);

    await evaluate('window.harness.submit()');
    const submitted = await until(state, value => value.calls.length === 1);
    expect(submitted.calls[0].items).toEqual([expect.objectContaining({
      requestId: offer.requestId,
      text: offer.text,
      source: { type: 'desktop_app', appName: 'TextEdit' },
    })]);
    expect(submitted.clipboardReads).toEqual([]);
    expect(browser.errors).toEqual([]);
  });

  it('handles a duplicate ID once and preserves existing human draft text', async () => {
    const offer = { action: 'selectedText', requestId: 'ax-123e4567-e89b-12d3-a456-426614174001', text: 'Synthetic selected text.', sourceApp: 'TextEdit' };
    await evaluate(`window.harness.mount(${JSON.stringify(offer)})`);
    await until(state, value => value.text === offer.text);
    await evaluate(`window.harness.setActivation(${JSON.stringify({ ...offer, text: 'Changed payload for same ID.' })})`);
    await evaluate(`window.harness.setActivation(${JSON.stringify({ action: 'selectedText', requestId: 'ax-123e4567-e89b-12d3-a456-426614174002', text: 'A second synthetic selection.', sourceApp: 'Notes' })})`);
    const kept = await until(state, value => value.completed.includes('ax-123e4567-e89b-12d3-a456-426614174002'));
    expect(kept.text).toBe(offer.text);
    expect(kept.sourceApp).toBe('TextEdit');
    expect(kept.notice).toContain('已保留原草稿');
    expect(kept.clipboardReads).toEqual([]);
    expect(browser.errors).toEqual([]);
  });
});
