import {expect,it} from 'vitest';
import type {WorkspaceSearchResponse} from '@noltri/schema';
import {mergeSearchBatch} from './WorkspaceSearch';
const hit=(id:string,snippet=id)=>({id,title:id,snippet,location:{kind:'course' as const,courseId:id},matches:[]});
it('keeps earlier hits and incomplete scanning state through empty progressive batches',()=>{
 const previous={revision:1,query:'tag:x',hits:[hit('a')],pending:true,scanned:50,cursor:'50'} satisfies WorkspaceSearchResponse;
 const next={...previous,hits:[],scanned:100,cursor:'100'};expect(mergeSearchBatch(previous,next)).toEqual({...next,hits:[hit('a')]});
});
it('deduplicates progressive hits and retains ordinary pagination for completed batches',()=>{
 const previous={revision:1,query:'x',hits:[hit('a'),hit('b')],pending:true,scanned:10,cursor:'10'} satisfies WorkspaceSearchResponse,next={...previous,hits:[hit('b','updated'),hit('c')],pending:false,scanned:40,cursor:'40'},result=mergeSearchBatch(previous,next);expect(result.hits.map(h=>h.id)).toEqual(['a','b','c']);expect(result.hits[1].snippet).toBe('updated');expect(result.pending).toBe(false);expect(result.cursor).toBe('40');
});
