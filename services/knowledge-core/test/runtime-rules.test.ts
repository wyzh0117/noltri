import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { processingRulesSchema } from '@noltri/schema';
import { ProcessingRulesStore } from '../src/services/processing-rules';
import { createKnowledgeCore } from '../src/core';
import { SqliteRepository } from '../../../packages/storage/src/sqlite';
import { InMemoryRepository } from '@noltri/storage';
import { captureOf, ScriptedProvider, testConfig } from './fakes';
import { submitCaptureBatch, processCaptureBatch } from '../src/services/capture-intake';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, {recursive:true,force:true}))); });
async function setup(sqlite = false) {
 const root=await mkdtemp(join(await realpath(tmpdir()),'runtime-rules-')); dirs.push(root);
 const config=testConfig({embeddingEnabled:false});
 const rules=await ProcessingRulesStore.open({root:join(root,'rules'),defaults:{thresholds:config.thresholds,extractionInstructions:'A extraction',classificationInstructions:'A classification'}});
 const repository=sqlite ? new SqliteRepository({file:join(root,'profile.sqlite')}) : new InMemoryRepository();
 const provider=new ScriptedProvider([], {extract:i=>({items:[{text:i.text,confidence:.8,suggestedTitle:'Synthetic point'}]}),classify:()=>({action:'create',newNodeTitle:'Synthetic topic',confidence:.8,reason:'synthetic'})});
 const actor={userId:config.devUser,actor:'synthetic'};
 const core=createKnowledgeCore({repository,provider,config,processingRules:rules});
 return {root,config,rules,repository,provider,actor,core};
}
async function applyB(h:Awaited<ReturnType<typeof setup>>) {
 const draft=await h.rules.saveDraft({thresholds:{...h.config.thresholds,highConfidence:.99},extractionInstructions:'B extraction',classificationInstructions:'B classification'},h.rules.readDraft().revision);
 return h.rules.applyDraft(draft.revision);
}
describe('actual frozen task rules',()=>{
 it('freezes A before extraction; applies B during the await without changing A and next source uses B',async()=>{
  const h=await setup(); const a=h.rules.getAppliedSnapshot();
  let release!:()=>void;let reached!:()=>void;const suspended=new Promise<void>(r=>release=r), entered=new Promise<void>(r=>reached=r);
  const extract=h.provider.extractKnowledge.bind(h.provider);let first=true;
  h.provider.extractKnowledge=async input=>{if(first){first=false;reached();await suspended;}return extract(input);};
  const pending=h.core.capture(captureOf('Synthetic original A, saved before any provider.'),h.actor);
  await entered;try { const rows=await h.repository.listInbox({userId:h.actor.userId});expect(await h.repository.getCaptureProcessingPlan(h.actor.userId,rows[0]!.id)).toMatchObject({rulesSnapshot:a,extractionReady:false,points:[]});await applyB(h); } finally { release(); } const result=await pending;
  expect(h.provider.extractInputs[0]?.instructions).toBe('A extraction');expect(h.provider.classifyInputs[0]?.instructions).toBe('A classification');expect(result.items[0]?.confidenceTier).toBe('high');
  const next=await h.core.capture(captureOf('Synthetic next independent source uses the newer rules.'),h.actor);
  expect(h.provider.extractInputs[1]?.instructions).toBe('B extraction');expect(h.provider.classifyInputs[1]?.instructions).toBe('B classification');expect(next.items[0]?.confidenceTier).toBe('medium');
  const records=h.rules.listRecords();expect(records).toHaveLength(2);expect(records[0]?.ruleVersionId).toBe(a.versionId);expect(JSON.stringify(records)).not.toContain('Synthetic original');expect(JSON.stringify(records)).not.toContain('extraction');
 });
 it('preserves the source and calls no provider if trusted snapshot lookup fails',async()=>{
  const h=await setup();h.rules.getAppliedSnapshot=()=>{throw Error('private path and original');};
  await expect(h.core.capture(captureOf('Synthetic source survives a broken rule store.'),h.actor)).rejects.toThrow();
  expect(await h.repository.listInbox({userId:h.actor.userId})).toHaveLength(1);expect(h.provider.extractInputs).toHaveLength(0);expect(h.provider.classifyInputs).toHaveLength(0);
 });
 it('retries after SQLite close/reopen with A despite apply/rollback and never repeats an empty extraction',async()=>{
  const h=await setup(true);h.provider.fail.add('classify');
  const result=await h.core.capture(captureOf('Synthetic durable source with a classification failure.'),h.actor);expect(result.stage).toBe('failed');
  const a=h.rules.getAppliedSnapshot();await applyB(h);await h.rules.rollback(a.versionId,h.rules.readDraft().revision);
  await (h.repository as SqliteRepository).close();
  const repository=new SqliteRepository({file:join(h.root,'profile.sqlite')});
  try{const provider=new ScriptedProvider([],{extract:()=>({items:[]}),classify:()=>({action:'create',newNodeTitle:'Recovered synthetic',confidence:.8,reason:'synthetic'})});const core=createKnowledgeCore({repository,provider,config:h.config,processingRules:h.rules});
   await core.retryCapture(result.rawSourceId,h.actor);expect(provider.extractInputs).toHaveLength(0);expect(provider.classifyInputs[0]?.instructions).toBe('A classification');expect((await repository.getCaptureProcessingPlan(h.actor.userId,result.rawSourceId))?.rulesSnapshot?.versionId).toBe(a.versionId);
   const empty=await core.capture(captureOf('Synthetic empty extraction is completed, never reserved.'),h.actor);await core.retryCapture(empty.rawSourceId,h.actor);expect(provider.extractInputs).toHaveLength(1);expect((await repository.getCaptureProcessingPlan(h.actor.userId,empty.rawSourceId))?.extractionReady).toBe(true);
  }finally{await repository.close();}
 });
 it('does not mark persisted knowledge failed when metadata recording fails',async()=>{
  const h=await setup();h.rules.appendRecord=async()=>{throw Error('sensitive unbounded payload');};
  const result=await h.core.capture(captureOf('Synthetic task survives its metadata-only record failure.'),h.actor);expect(result.stage).toBe('completed');expect((await h.repository.findRawSource(result.rawSourceId,h.actor.userId))?.processingStatus).toBe('done');
  await h.core.capture(captureOf('irrelevant replacement text','web_app',{},result.requestId),h.actor);expect(h.provider.extractInputs).toHaveLength(1);
 });
 it('preserves source/no provider on snapshot persistence failure and ignores forged metadata rules',async()=>{
  const h=await setup();const reserve=h.repository.reserveCaptureProcessingPlan.bind(h.repository);h.repository.reserveCaptureProcessingPlan=async()=>{throw Error('synthetic persistence fault');};
  await expect(h.core.capture(captureOf('Synthetic original is safe if SQL snapshot write fails.'),h.actor)).rejects.toThrow();expect(await h.repository.listInbox({userId:h.actor.userId})).toHaveLength(1);expect(h.provider.extractInputs).toHaveLength(0);
  h.repository.reserveCaptureProcessingPlan=reserve;
  const source=await h.repository.createRawSource({userId:h.actor.userId,rawText:'Synthetic source metadata must not control administrative rules.',sourceType:'manual',capturedAt:'2026',metadata:{rulesSnapshot:{versionId:'forged',rules:{thresholds:{highConfidence:0},extractionInstructions:'FORGED'}}}});
  await h.core.retryCapture(source.id,h.actor);expect(h.provider.extractInputs[0]?.instructions).toBe('A extraction');expect((await h.repository.getCaptureProcessingPlan(h.actor.userId,source.id))?.rulesSnapshot?.versionId).toBe(h.rules.getAppliedSnapshot().versionId);
 });
 it('claims one source and reserves reanalysis identity before provider awaits',async()=>{
  const h=await setup();let release!:()=>void;let reached!:()=>void;let gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>reached=r);const extract=h.provider.extractKnowledge.bind(h.provider);
  h.provider.extractKnowledge=async input=>{reached();await gate;return extract(input);};const input=captureOf('Synthetic concurrent capture remains a single original source.');const run=h.core.capture(input,h.actor);await entered;
  const source=(await h.repository.listInbox({userId:h.actor.userId}))[0]!;await expect(h.core.retryCapture(source.id,h.actor)).rejects.toMatchObject({code:'conflict'});expect((await h.core.capture(input,h.actor)).stage).toBe('processing');release();await run;
  expect(await h.repository.listInbox({userId:h.actor.userId})).toHaveLength(1);await applyB(h);
  gate=new Promise<void>(r=>release=r);entered=new Promise<void>(r=>reached=r);const rerun=h.core.reanalyzeCapture(source.id,h.actor);await entered;
  expect(await h.repository.getCaptureProcessingPlan(h.actor.userId,source.id)).toMatchObject({analysisVersion:2,extractionReady:false,rulesSnapshot:{rules:{extractionInstructions:'B extraction'}}});
  await expect(h.core.reanalyzeCapture(source.id,h.actor)).rejects.toMatchObject({code:'conflict'});release();await rerun;expect((await h.repository.getCaptureProcessingPlan(h.actor.userId,source.id,1))?.rulesSnapshot?.rules.extractionInstructions).toBe('A extraction');expect(h.provider.extractInputs).toHaveLength(2);
 });
 it('keeps unknown legacy plans unknown and uses current rules only for explicit new analysis',async()=>{
  const h=await setup();const source=await h.repository.createRawSource({userId:h.actor.userId,rawText:'Synthetic historical extraction with no known rule identity.',sourceType:'manual',capturedAt:'2026'});await h.repository.createCaptureProcessingPlan(h.actor.userId,source.id,[]);await h.repository.updateRawSourceProcessing(source.id,h.actor.userId,'failed');
  expect((await h.core.retryCapture(source.id,h.actor)).stage).toBe('saved');expect(h.provider.extractInputs).toHaveLength(0);expect((await h.repository.getCaptureProcessingPlan(h.actor.userId,source.id,1))?.rulesSnapshot).toBeNull();
  await applyB(h);await h.core.reanalyzeCapture(source.id,h.actor);expect((await h.repository.getCaptureProcessingPlan(h.actor.userId,source.id))?.analysisVersion).toBe(2);expect(h.provider.extractInputs[0]?.instructions).toBe('B extraction');
 });
 it.each([false,true])('preserves human review and rejects reanalysis (SQLite=%s)',async sqlite=>{
  const h=await setup(sqlite);try{await applyB(h);const result=await h.core.capture(captureOf('Synthetic original that a human explicitly corrects.'),h.actor);const node=await h.repository.createNode({userId:h.actor.userId,title:'Human target'});await h.core.reviewSource(result.rawSourceId,{actionId:'human-confirm',expectedRevision:0,action:'confirm',nodeId:node.id,editedText:'Human corrected this exact content.'},h.actor);
  const before=await h.repository.findRawSource(result.rawSourceId,h.actor.userId),items=await h.repository.listKnowledgeItemsForSource(result.rawSourceId,h.actor.userId);await h.rules.rollback(h.rules.listVersions()[0]!.versionId,h.rules.readDraft().revision);await h.core.retryCapture(result.rawSourceId,h.actor);await expect(h.core.reanalyzeCapture(result.rawSourceId,h.actor)).rejects.toMatchObject({code:'conflict'});expect(await h.repository.findRawSource(result.rawSourceId,h.actor.userId)).toEqual(before);expect(await h.repository.listKnowledgeItemsForSource(result.rawSourceId,h.actor.userId)).toEqual(items);
  }finally{if(h.repository instanceof SqliteRepository)await h.repository.close();}
 });
 it('freezes before OCR and reuses recognition and A after extraction fails across applying B',async()=>{
  const h=await setup();const a=h.rules.getAppliedSnapshot();let images=0;
  class ImageProvider extends ScriptedProvider {
   override readonly capabilities={embeddings:false,chat:true,structuredOutput:true,imageRecognition:true};
   async recognizeImage(){images++;const sources=await h.repository.listInbox({userId:h.actor.userId});expect((await h.repository.getCaptureProcessingPlan(h.actor.userId,sources[0]!.id))?.rulesSnapshot).toEqual(a);await applyB(h);return {text:'Clearly recognized synthetic content with a frozen confidence gate.',confidence:.8,blocks:[{kind:'paragraph' as const,text:'Clearly recognized synthetic content with a frozen confidence gate.'}],uncertainRegions:[]};}
  }
  const provider=new ImageProvider([],{extract:i=>({items:[{text:i.text,confidence:.8,suggestedTitle:'Image point'}]}),classify:()=>({action:'create',newNodeTitle:'Image topic',confidence:.8,reason:'synthetic'})});provider.fail.add('extract');
  const core=createKnowledgeCore({repository:h.repository,provider,config:h.config,processingRules:h.rules});const bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC','base64'));
  await h.repository.putCaptureAsset({userId:h.actor.userId,sessionId:'image-session',assetId:'original',mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),bytes});
  const submitted=await submitCaptureBatch(core,h.actor,{batchId:'image-batch',sessionId:'image-session',items:[{requestId:'image-rule-request',kind:'image',userOrder:0,assetIds:['original'],source:{type:'manual'},capture:{client:'desktop',capturedAt:'2026'}}]});expect(submitted.batch.items[0]?.status).toBe('failed');const id=submitted.batch.items[0]!.rawSourceId!;
  const recognized=await h.repository.getCaptureRecognitionSnapshot(h.actor.userId,id);provider.fail.delete('extract');await processCaptureBatch(core,h.actor,'image-batch',{});
  expect(images).toBe(1);expect(provider.extractInputs[0]?.instructions).toBe('A extraction');expect(provider.classifyInputs[0]?.instructions).toBe('A classification');expect(await h.repository.getCaptureRecognitionSnapshot(h.actor.userId,id)).toEqual(recognized);expect((await h.repository.findRawSource(id,h.actor.userId))?.rawText).toBe('');expect((await h.repository.getCaptureAsset(h.actor.userId,'image-session','original'))?.bytes).toEqual(bytes);
 });
});

for (const sqlite of [false, true]) describe(`review authority gates (SQLite=${sqlite})`, () => {
 async function state(h: Awaited<ReturnType<typeof setup>>, sourceId: string) {
  const items=await h.repository.listKnowledgeItemsForSource(sourceId,h.actor.userId);
  return {items,links:await Promise.all(items.map(item=>h.repository.listLinksForItem(item.id,h.actor.userId))),nodes:await h.repository.listNodes(h.actor.userId),edges:await h.repository.listEdges(h.actor.userId),versions:await h.repository.listVersionRecords(h.actor.userId),plan:await h.repository.getCaptureProcessingPlan(h.actor.userId,sourceId)};
 }
 async function review(h: Awaited<ReturnType<typeof setup>>, sourceId:string, action:'confirm'|'defer'|'reject', nodeId:string, text:string) {
  return h.core.reviewSource(sourceId,{actionId:`human-${action}`,expectedRevision:0,action,...(action==='confirm'?{nodeId,editedText:text}:{})} as Parameters<typeof h.core.reviewSource>[1],h.actor);
 }
 it.each(['confirm','defer','reject'] as const)('rejects stale reservation after human %s without claiming or calling a provider',async action=>{
  const h=await setup(sqlite);try{
   h.provider.fail.add('extract');const failed=await h.core.capture(captureOf('Synthetic failed source awaiting a fresh reservation.'),h.actor);h.provider.fail.clear();const node=await h.repository.createNode({userId:h.actor.userId,title:'Human target'});
   let reached!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>reached=r),gate=new Promise<void>(r=>release=r);const reserve=h.repository.reserveCaptureProcessingPlan.bind(h.repository);
   h.repository.reserveCaptureProcessingPlan=async input=>{reached();await gate;return reserve(input);};
   const retry=h.core.retryCapture(failed.rawSourceId,h.actor);const settled=retry.then(()=>null,error=>error);await entered;await review(h,failed.rawSourceId,action,node.id,'Human text wins the stale claim race.');const before=await state(h,failed.rawSourceId),source=await h.repository.findRawSource(failed.rawSourceId,h.actor.userId);release();expect(await settled).toMatchObject({code:'conflict'});expect(await state(h,failed.rawSourceId)).toEqual(before);expect(await h.repository.findRawSource(failed.rawSourceId,h.actor.userId)).toEqual(source);expect(h.provider.extractInputs).toHaveLength(0);
  }finally{if(h.repository instanceof SqliteRepository)await h.repository.close();}
 });
 for(const pause of ['classification','record'] as const) it.each([['confirm',true],['confirm',false],['defer',false],['reject',false]] as const)(`cancels ${pause} work after human %s (same text=%s) without post-review tree/item/link/plan mutation`,async(action,sameText)=>{
  const h=await setup(sqlite);try{
   const original='Synthetic authority source keeps its reviewed meaning and placement.';const target=await h.repository.createNode({userId:h.actor.userId,title:'Human target'});
   let reached!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>reached=r),gate=new Promise<void>(r=>release=r);let pauses=0;
   h.provider.classifyKnowledge=async input=>{if(pause==='classification'){reached();await gate;}return {action:'create',newNodePath:['AI parent','AI leaf'],confidence:.8,reason:'synthetic'};};
   const append=h.rules.appendRecord.bind(h.rules);h.rules.appendRecord=async record=>{const value=record as {phase?:string;status?:string};if(pause==='record'&&value.phase==='persisting'&&value.status==='running'&&pauses++===0){reached();await gate;}return append(record);};
   const capture=h.core.capture(captureOf(original),h.actor);await entered;const source=(await h.repository.listInbox({userId:h.actor.userId}))[0]!;await review(h,source.id,action,target.id,sameText?original:'Human changes both meaning and placement.');const before=await state(h,source.id);release();const result=await capture;
   expect(await state(h,source.id)).toEqual(before);expect(result.items).toEqual([]);expect(result.stage).toBe(action==='confirm'?'completed':'needs_review');expect(h.rules.listRecords().find(record=>record.taskId===`${source.id}:1`)).toMatchObject({status:'cancelled',phase:'completed',errorCode:'cancelled'});expect(h.provider.extractInputs).toHaveLength(1);
   expect((await h.repository.findRawSource(source.id,h.actor.userId))?.reviewStatus).toBe(action==='confirm'?'confirmed':action==='defer'?'deferred':'rejected');
  }finally{if(h.repository instanceof SqliteRepository)await h.repository.close();}
 });
});
it('canonicalizes fallback rules before hashing valid differently ordered threshold objects',async()=>{
 const originalConfig=testConfig({embeddingEnabled:false});const config={...originalConfig,thresholds:Object.fromEntries(Object.entries(originalConfig.thresholds).reverse()) as typeof originalConfig.thresholds};
 const repository=new InMemoryRepository();const provider=new ScriptedProvider([]);const core=createKnowledgeCore({repository,provider,config});const result=await core.capture(captureOf('Synthetic fallback rule order must not change a valid configuration.'),{userId:config.devUser,actor:'synthetic'});expect(result.processingStatus).toBe('done');const plan=await repository.getCaptureProcessingPlan(config.devUser,result.rawSourceId);const canonical=processingRulesSchema.parse({thresholds:config.thresholds,extractionInstructions:'',classificationInstructions:''});expect(plan?.rulesSnapshot?.contentHash).toBe(createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
});

for(const sqlite of [false,true])for(const pause of ['claim','recognition'] as const)describe(`image authority ${pause} (SQLite=${sqlite})`,()=>{
 it.each(['confirm','defer','reject'] as const)('preserves human %s after the image path loses authority',async action=>{
  const h=await setup(sqlite);try{
   let reached!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>reached=r),gate=new Promise<void>(r=>release=r);let images=0;
   class ImageProvider extends ScriptedProvider{override readonly capabilities={embeddings:false,chat:true,structuredOutput:true,imageRecognition:true};async recognizeImage(){images++;if(pause==='recognition'){reached();await gate;}return{text:'Synthetic recognized content after a human action.',confidence:.99,blocks:[{kind:'paragraph' as const,text:'Synthetic recognized content after a human action.'}],uncertainRegions:[]};}}
   const provider=new ImageProvider([]);const core=createKnowledgeCore({repository:h.repository,provider,config:h.config,processingRules:h.rules});
   const reserve=h.repository.reserveCaptureProcessingPlan.bind(h.repository);if(pause==='claim')h.repository.reserveCaptureProcessingPlan=async input=>{reached();await gate;return reserve(input);};
   const target=await h.repository.createNode({userId:h.actor.userId,title:'Human image target'});const bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC','base64'));await h.repository.putCaptureAsset({userId:h.actor.userId,sessionId:'s',assetId:'a',mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),bytes});
   const task=submitCaptureBatch(core,h.actor,{batchId:'b',sessionId:'s',items:[{requestId:'human-image-gate',kind:'image',userOrder:0,assetIds:['a'],source:{type:'manual'},capture:{capturedAt:'2026',client:'desktop'}}]});await entered;const source=(await h.repository.listInbox({userId:h.actor.userId}))[0]!;await core.reviewSource(source.id,{actionId:'image-review',expectedRevision:0,action,...(action==='confirm'?{nodeId:target.id,editedText:'Human image meaning.'}:{})} as Parameters<typeof core.reviewSource>[1],h.actor);
   const before=await h.repository.findRawSource(source.id,h.actor.userId),recognized=await h.repository.getCaptureRecognitionSnapshot(h.actor.userId,source.id),items=await h.repository.listKnowledgeItemsForSource(source.id,h.actor.userId);const links=await Promise.all(items.map(item=>h.repository.listLinksForItem(item.id,h.actor.userId)));release();const result=await task;
   expect(result.batch.items[0]?.status).toBe(action==='confirm'?'done':'needs_review');const after=await h.repository.findRawSource(source.id,h.actor.userId);expect(after).toMatchObject({rawText:before!.rawText,reviewStatus:before!.reviewStatus,reviewRevision:before!.reviewRevision});if(pause==='claim'||action==='confirm')expect(after).toEqual(before);expect(await h.repository.listKnowledgeItemsForSource(source.id,h.actor.userId)).toEqual(items);expect(await Promise.all(items.map(item=>h.repository.listLinksForItem(item.id,h.actor.userId)))).toEqual(links);expect(await h.repository.getCaptureRecognitionSnapshot(h.actor.userId,source.id)).toEqual(recognized);expect(images).toBe(pause==='claim'?0:1);expect(provider.extractInputs).toHaveLength(0);if(pause==='recognition')expect(h.rules.listRecords()[0]).toMatchObject({status:'cancelled',errorCode:'cancelled'});
  }finally{if(h.repository instanceof SqliteRepository)await h.repository.close();}
 });
});
