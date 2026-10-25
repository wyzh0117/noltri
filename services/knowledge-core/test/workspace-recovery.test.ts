import {it,expect} from 'vitest';
import {workspaceFixture} from './workspace-fixture';
import {applyCourseDocumentPatch,getCourseDocument,loadWorkspace,moveDetachedEntries,patchWorkspaceProperties} from '../src/services/course-workspace';
import {compareSnapshot,restoreSnapshot} from '../src/services/recovery';
import {connectChapter} from '../src/services/graph';
import {closeMetadata} from '../src/services/metadata';

it('keeps ordinary restore strict and accepts only the complete freshly reviewed versions for explicit recovery',async()=>{
 const f=await workspaceFixture('sqlite');
 try{
  await f.repository.saveKnowledgeNote({userId:'u',topicId:f.a.id,chapterId:null,content:'original'});
  let doc=await getCourseDocument(f.deps,f.actor,f.a.id);const entry=doc.entries[0],range=doc.projection.find(p=>p.entryId===entry.id)!;
  const edited=await applyCourseDocumentPatch(f.deps,f.actor,{courseId:f.a.id,baseDocumentRevision:doc.documentRevision,entryRevisions:{[entry.id]:entry.revision},changes:[{from:range.from,to:range.to,insert:'later'}],requestId:'snapshot-edit'}),snapshot=(await loadWorkspace(f.deps,f.actor)).snapshots.find(s=>s.id===edited.snapshotId)!;
  doc=edited.documents[0];await patchWorkspaceProperties(f.deps,f.actor,{owner:{kind:'entry',id:entry.id},expectedRevision:doc.entries[0].revision,properties:{reviewed:true},requestId:'later-property'});
  await expect(restoreSnapshot(f.deps,f.actor,snapshot.id,snapshot.afterRevisions)).rejects.toMatchObject({code:'conflict'});
  const compared=await compareSnapshot(f.deps,f.actor,snapshot.id);expect(compared.conflicts).toContain(`entry:${entry.id}`);
  await expect(restoreSnapshot(f.deps,f.actor,snapshot.id,compared.revisions)).rejects.toMatchObject({code:'conflict'});
  const b=await getCourseDocument(f.deps,f.actor,f.b.id);await patchWorkspaceProperties(f.deps,f.actor,{owner:{kind:'course',id:b.courseId},expectedRevision:b.documentRevision,properties:{remote:true},requestId:'concurrent-owner'});
  await expect(restoreSnapshot(f.deps,f.actor,snapshot.id,compared.revisions,true)).rejects.toMatchObject({code:'conflict'});
  const fresh=await compareSnapshot(f.deps,f.actor,snapshot.id),partial={...fresh.revisions};delete partial[`course:${b.courseId}`];
  await expect(restoreSnapshot(f.deps,f.actor,snapshot.id,partial,true)).rejects.toMatchObject({code:'conflict'});
  const result=await restoreSnapshot(f.deps,f.actor,snapshot.id,fresh.revisions,true);expect(result.documents.find(d=>d.courseId===f.a.id)?.markdown).toContain('original');
  const protection=(await loadWorkspace(f.deps,f.actor)).snapshots.find(s=>s.id===result.snapshotId)!;expect(protection.reason).toBe('before-restore');expect(protection.before.entries.find(e=>e.id===entry.id)).toMatchObject({markdown:'later',properties:{reviewed:true}});
  expect((await getCourseDocument(f.deps,f.actor,f.b.id)).properties).toEqual({remote:true});
 }finally{await closeMetadata(f.deps,f.actor.userId);if('close'in f.repository&&typeof f.repository.close==='function')await f.repository.close();}
});
it('retains stable detached entry identities on explicit reattachment or guarded movement',async()=>{
 const f=await workspaceFixture('sqlite');
 try{
  const detached=await f.repository.createNode({userId:'u',title:'Detached',nodeType:'chapter'});
  await f.repository.saveKnowledgeNote({userId:'u',topicId:f.a.id,chapterId:detached.id,content:'Protected body ^keep'});
  let source=await getCourseDocument(f.deps,f.actor,f.a.id),target=await getCourseDocument(f.deps,f.actor,f.b.id);const entry=source.entries[0],block=entry.blocks[0];expect(source.markdown).not.toContain('Protected body');
  const request={entryIds:[entry.id],toCourseId:target.courseId,toCourseChapterId:null,expectedEntryRevisions:{[entry.id]:entry.revision},expectedDocumentRevisions:{[source.courseId]:source.documentRevision,[target.courseId]:target.documentRevision},requestId:'move-retained'};
  await expect(moveDetachedEntries(f.deps,f.actor,{...request,expectedEntryRevisions:{}})).rejects.toMatchObject({code:'conflict'});
  const moved=await moveDetachedEntries(f.deps,f.actor,request);expect(moved.documents.find(d=>d.courseId===target.courseId)?.entries[0]).toMatchObject({id:entry.id,markdown:entry.markdown,blocks:[block]});
  await expect(moveDetachedEntries(f.deps,f.actor,{...request,requestId:'not-detached'})).rejects.toMatchObject({code:'invalid_request'});
  const state=await loadWorkspace(f.deps,f.actor),snapshot=state.snapshots.find(s=>s.id===moved.snapshotId)!;await restoreSnapshot(f.deps,f.actor,snapshot.id,snapshot.afterRevisions);
  await connectChapter(f.deps,f.actor,detached.id,f.a.id);source=await getCourseDocument(f.deps,f.actor,f.a.id);expect(source.markdown).toContain('Protected body');expect(source.entries[0].id).toBe(entry.id);expect(source.entries[0].blocks[0].id).toBe(block.id);
 }finally{await closeMetadata(f.deps,f.actor.userId);if('close'in f.repository&&typeof f.repository.close==='function')await f.repository.close();}
});
it('includes tombstones in explicit recovery CAS and revives the saved entry identity',async()=>{
 const f=await workspaceFixture();
 try{
  await f.repository.saveKnowledgeNote({userId:'u',topicId:f.a.id,chapterId:null,content:'original ^stable'});
  let doc=await getCourseDocument(f.deps,f.actor,f.a.id),entry=doc.entries[0],range=doc.projection.find(p=>p.entryId===entry.id)!;
  const edited=await applyCourseDocumentPatch(f.deps,f.actor,{courseId:f.a.id,baseDocumentRevision:doc.documentRevision,entryRevisions:{[entry.id]:entry.revision},changes:[{from:range.from,to:range.to,insert:'revised ^stable'}],requestId:'before-delete'});
  doc=edited.documents[0];entry=doc.entries[0];range=doc.projection.find(p=>p.entryId===entry.id)!;
  await applyCourseDocumentPatch(f.deps,f.actor,{courseId:f.a.id,baseDocumentRevision:doc.documentRevision,entryRevisions:{[entry.id]:entry.revision},changes:[{from:range.from,to:range.to,insert:''}],requestId:'delete-entry'});
  const state=await loadWorkspace(f.deps,f.actor);expect(state.entries.some(e=>e.id===entry.id)).toBe(false);expect(state.tombstones[`entry:${entry.id}`]).toBeGreaterThan(entry.revision);
  const comparison=await compareSnapshot(f.deps,f.actor,edited.snapshotId!),partial={...comparison.revisions};delete partial[`entry:${entry.id}`];
  await expect(restoreSnapshot(f.deps,f.actor,edited.snapshotId!,partial,true)).rejects.toMatchObject({code:'conflict'});
  const restored=await restoreSnapshot(f.deps,f.actor,edited.snapshotId!,comparison.revisions,true);expect(restored.documents[0].entries[0]).toMatchObject({id:entry.id,markdown:'original ^stable'});
  expect((await loadWorkspace(f.deps,f.actor)).tombstones[`entry:${entry.id}`]).toBeUndefined();
 }finally{await closeMetadata(f.deps,f.actor.userId);}
});
it('rejects a stale property form instead of dropping a remotely added field',async()=>{
 const f=await workspaceFixture();try{const shown=await getCourseDocument(f.deps,f.actor,f.a.id);await patchWorkspaceProperties(f.deps,f.actor,{owner:{kind:'course',id:f.a.id},expectedRevision:shown.documentRevision,properties:{reviewed:true},requestId:'remote-property'});
 await expect(patchWorkspaceProperties(f.deps,f.actor,{owner:{kind:'course',id:f.a.id},expectedRevision:shown.documentRevision,properties:{aliases:['my alias']},requestId:'stale-property-form'})).rejects.toMatchObject({code:'conflict'});
 expect((await getCourseDocument(f.deps,f.actor,f.a.id)).properties).toEqual({reviewed:true});}finally{await closeMetadata(f.deps,f.actor.userId);}
});

it('explicitly restores a removed chapter together with reviewed later dependents and can undo that recovery',async()=>{
 const f=await workspaceFixture('sqlite');
 try{
  let doc=await getCourseDocument(f.deps,f.actor,f.a.id);
  const append=async(text:string,id:string)=>{const result=await applyCourseDocumentPatch(f.deps,f.actor,{courseId:doc.courseId,baseDocumentRevision:doc.documentRevision,entryRevisions:Object.fromEntries(doc.entries.map(e=>[e.id,e.revision])),changes:[{from:doc.markdown.length,to:doc.markdown.length,insert:text}],requestId:id});doc=result.documents[0];return result;};
  const first=await append('## Added chapter\n\nInitial body','add-chapter'),chapter=doc.chapters.find(c=>c.title==='Added chapter')!;
  await append('Later separate paragraph ^retained','later-entry');
  const later=doc.entries.find(e=>e.markdown.includes('Later separate'))!,state=await loadWorkspace(f.deps,f.actor);
  const source=await f.repository.createRawSource({userId:f.actor.userId,rawText:later.markdown,sourceType:'manual',capturedAt:new Date().toISOString()});
  state.sourceLinks.push({entryId:later.id,sourceId:source.id,locations:[]});
  state.resolvedReferences[`entry:${later.id}`]={content:later.markdown,revision:later.revision,references:[]};
  await f.repository.commitWorkspaceState(f.actor.userId,state.revision,state);
  const comparison=await compareSnapshot(f.deps,f.actor,first.snapshotId!);
  expect(comparison.conflicts).toContain(`entry:${later.id}`);
  await expect(restoreSnapshot(f.deps,f.actor,first.snapshotId!,comparison.revisions)).rejects.toMatchObject({code:'conflict'});
  const partial={...comparison.revisions};delete partial[`entry:${later.id}`];
  await expect(restoreSnapshot(f.deps,f.actor,first.snapshotId!,partial,true)).rejects.toMatchObject({code:'conflict'});
  const result=await restoreSnapshot(f.deps,f.actor,first.snapshotId!,comparison.revisions,true),after=await loadWorkspace(f.deps,f.actor);
  expect(after.chapters.some(c=>c.id===chapter.id)).toBe(false);expect(after.entries.some(e=>e.courseChapterId===chapter.id)).toBe(false);
  expect(after.sourceLinks.some(link=>link.entryId===later.id)).toBe(false);expect(after.resolvedReferences[`entry:${later.id}`]).toBeUndefined();
  const protection=after.snapshots.find(s=>s.id===result.snapshotId)!;expect(protection.objectKeys).toContain(`entry:${later.id}`);expect(protection.before.entries.find(e=>e.id===later.id)).toEqual(later);
  await restoreSnapshot(f.deps,f.actor,protection.id,protection.afterRevisions);
  const undone=await loadWorkspace(f.deps,f.actor);expect(undone.chapters.some(c=>c.id===chapter.id)).toBe(true);expect(undone.entries.find(e=>e.id===later.id)).toMatchObject({markdown:later.markdown,blocks:later.blocks,courseChapterId:chapter.id});
  expect(undone.sourceLinks).toContainEqual({entryId:later.id,sourceId:source.id,locations:[]});expect(undone.resolvedReferences[`entry:${later.id}`]?.content).toBe(later.markdown);
 }finally{await closeMetadata(f.deps,f.actor.userId);if('close'in f.repository&&typeof f.repository.close==='function')await f.repository.close();}
});
