import {expect,it} from 'vitest';
import type {CourseDocument,WorkspaceMetadata} from '@noltri/schema';
import {sourceMoveRevisions} from './source-move-revisions';
import {renameAttachmentRevisions,sameCleanupCandidates} from './ResourceDialog';
const doc=(courseId:string,documentRevision:number,id:string,revision:number)=>({courseId,documentRevision,entries:[{id,revision}]} as CourseDocument);
it('includes third-course incoming reference revisions while preserving both endpoint snapshots',async()=>{
 const source=doc('a',2,'moving',3),target=doc('b',4,'target',5),third=doc('c',6,'incoming',7),loaded:string[]=[];
 const links=[{courseId:'c',entryId:'incoming',resolution:{status:'resolved',target:{kind:'entry',courseId:'a',entryId:'moving'}}},{courseId:'c',entryId:null,resolution:{status:'resolved',target:{kind:'entry',courseId:'a',entryId:'moving'}}},{courseId:'irrelevant',entryId:'x',resolution:{status:'resolved',target:{kind:'entry',courseId:'a',entryId:'other'}}}] as WorkspaceMetadata['links'];
 const result=await sourceMoveRevisions({workspaceMetadata:async()=>({links} as WorkspaceMetadata),getCourseDocument:async id=>{loaded.push(id);return third;}},source,target,['moving']);expect(loaded).toEqual(['c']);expect(result).toEqual({expectedDocumentRevisions:{a:2,b:4,c:6},expectedEntryRevisions:{moving:3,incoming:7}});
});
it('guards every renamed-reference document and keeps cleanup confirmation scoped to the reviewed set',()=>{expect(renameAttachmentRevisions([doc('a',2,'one',3),doc('b',4,'two',5)])).toEqual({expectedDocumentRevisions:{a:2,b:4},expectedEntryRevisions:{one:3,two:5}});expect(sameCleanupCandidates(['a','b'],['b','a'])).toBe(true);expect(sameCleanupCandidates(['a'],['a','new'])).toBe(false);});
