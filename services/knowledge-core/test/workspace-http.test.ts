import {describe,it,expect} from 'vitest';
import {ApiClient} from '@noltri/api-client';
import {createRequestHandler} from '../src/http/router';
import {makeHarness,testConfig} from './fakes';
describe('workspace HTTP and validating client',()=>{
  it('round trips long course edits, metadata, replay, restore, and rejects cross-course bodies',async()=>{
    const h=makeHarness(),node=await h.repository.createNode({userId:h.actor.userId,title:'课程',nodeType:'topic'});
    const handler=createRequestHandler({core:h.core,config:h.config});
    const api=new ApiClient({baseUrl:'http://localhost',fetchImpl:async(input,init)=>handler(new Request(String(input),init))});
    const doc=await api.getCourseDocument(node.id),text='正文'.repeat(25000);
    const request={courseId:node.id,baseDocumentRevision:doc.documentRevision,entryRevisions:{},changes:[{from:doc.markdown.length,to:doc.markdown.length,insert:'\n## 章节\n'+text}],requestId:'http-save'};
    const result=await api.applyCourseDocumentPatch(request);expect(result.documents[0].markdown).toContain(text);expect(await api.applyCourseDocumentPatch(request)).toEqual(result);
    expect((await api.workspaceMetadata()).objects.length).toBeGreaterThan(0);expect((await api.searchKnowledge('正文')).hits.length).toBeGreaterThan(0);
    const response=await handler(new Request(`http://localhost/api/workspace/courses/wrong/document`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(request)}));expect(response.status).toBe(400);
    await expect(api.applyCourseDocumentPatch({...request,requestId:'stale'})).rejects.toMatchObject({status:409});
    const snapshots=await api.listWorkspaceSnapshots();expect(snapshots.length).toBeGreaterThan(0);
    const snapshot=snapshots[0];const comparison=await api.compareWorkspaceSnapshot(snapshot.id);expect(comparison.revisions[`course:${node.id}`]).toBe(result.documents[0].documentRevision);expect(comparison.conflicts).toEqual([]);const restored=await api.restoreWorkspaceSnapshot(snapshot.id,snapshot.afterRevisions);expect(restored.documents[0].markdown).not.toContain(text);
  });
  it('fails closed for scoped indexes and snippet-only editable documents',async()=>{
    const h=makeHarness(),node=await h.repository.createNode({userId:h.actor.userId,title:'restricted',nodeType:'topic'});
    const grant={id:'g',label:'limited',client:'test',scopes:['read'] as const,nodeIds:[node.id],snippetChars:null,secretHash:'ignored',createdAt:new Date().toISOString(),revokedAt:null};
    const handler=createRequestHandler({core:h.core,config:h.config,identityResolver:async()=>({userId:h.actor.userId,actor:'test',via:'grant',grant})});
    const response=await handler(new Request('http://localhost/api/workspace/metadata'));expect(response.status).toBe(401);
    expect((await handler(new Request('http://localhost/api/workspace/snapshots/unknown/compare'))).status).toBe(401);
    expect((await handler(new Request('http://localhost/api/workspace/detached-entries/move',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}))).status).toBe(401);
    const capped=createRequestHandler({core:h.core,config:h.config,identityResolver:async()=>({userId:h.actor.userId,actor:'test',via:'grant',grant:{...grant,nodeIds:null,snippetChars:20}})});
    expect((await capped(new Request(`http://localhost/api/workspace/courses/${node.id}/document`))).status).toBe(401);
  });
  it('keeps authenticated resource bytes safe and imports originals through the capture boundary',async()=>{
    const {mkdtemp,rm}=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
    const directory=await mkdtemp(path.join(os.tmpdir(),'noltri-resource-http-'));
    try{
      const h=makeHarness({config:testConfig({sqliteFile:path.join(directory,'memory-test.sqlite')})});
      const c=await h.repository.createNode({userId:h.actor.userId,title:'Import',nodeType:'topic'});
      const handler=createRequestHandler({core:h.core,config:h.config});
      const api=new ApiClient({baseUrl:'http://localhost',fetchImpl:async(input,init)=>handler(new Request(String(input),init))});
      const uploaded=await api.uploadAttachment({path:'unsafe.svg',mimeType:'image/svg+xml',contentBase64:Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'),requestId:'upload-svg'});
      expect('id'in uploaded).toBe(true);if(!('id'in uploaded))return;
      const response=await handler(new Request(`http://localhost/api/workspace/attachments/${uploaded.id}/content`));
      expect(response.headers.get('content-type')).toBe('application/octet-stream');expect(response.headers.get('content-security-policy')).toContain('sandbox');
      expect((await api.getAttachmentContent(uploaded.id)).type).toBe('application/octet-stream');
      const preview=await api.cleanupAttachments();expect(preview.confirmationRequired).toBe(true);expect(preview.candidateRevisions[uploaded.id]).toBe(uploaded.revision);
      const later=await api.uploadAttachment({path:'later.txt',mimeType:'text/plain',contentBase64:Buffer.from('later').toString('base64'),requestId:'upload-after-preview'});if(!('id'in later))throw new Error('Incomplete small upload');
      const cleanup=await api.cleanupAttachments({confirmed:true,attachmentIds:preview.candidateIds,expectedRevisions:preview.candidateRevisions});expect(cleanup.deletedIds).toEqual([uploaded.id]);expect((await api.listAttachments()).some(a=>a.id===later.id)).toBe(true);
      const doc=await api.getCourseDocument(c.id);
      const imported=await api.importMarkdown({courseId:c.id,courseChapterId:null,markdown:'x',path:'original.md',requestId:'import-small',expectedDocumentRevision:doc.documentRevision,replaceExisting:false});
      expect(imported.document.markdown).toContain('x');expect((await h.repository.findRawSource(imported.rawSourceId,h.actor.userId))?.rawText).toBe('x');
      expect((await api.exportCourseMarkdown(c.id)).manifest.sources.some(s=>s.id===imported.rawSourceId)).toBe(true);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('moves only the selected shared course membership and preserves its other path',async()=>{
    const h=makeHarness(),u=h.actor.userId;
    const d=await h.repository.createNode({userId:u,title:'D',nodeType:'discipline'});
    const parents=await Promise.all(['A','B','C'].map(title=>h.repository.createNode({userId:u,title,nodeType:'subdiscipline',parentId:d.id})));
    const course=await h.repository.createNode({userId:u,title:'Shared',nodeType:'topic',parentId:parents[0].id});
    await h.repository.createEdge({userId:u,fromNodeId:course.id,toNodeId:parents[1].id,relationType:'part_of',source:'course_membership'});
    const handler=createRequestHandler({core:h.core,config:h.config}),api=new ApiClient({baseUrl:'http://localhost',fetchImpl:async(input,init)=>handler(new Request(String(input),init))});
    await api.moveNode(course.id,{targetParentId:parents[2].id,fromParentId:parents[1].id});
    expect((await h.repository.findNode(course.id,u))?.parentId).toBe(parents[0].id);
    expect(await h.repository.findEdge(u,course.id,parents[1].id,'part_of')).toBeNull();expect(await h.repository.findEdge(u,course.id,parents[2].id,'part_of')).not.toBeNull();
    const tree=await api.tree();expect(tree.nodes[0].children?.flatMap(p=>p.children??[]).filter(n=>n.id===course.id)).toHaveLength(2);
  });
});
