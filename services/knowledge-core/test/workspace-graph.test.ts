import {describe,it,expect} from 'vitest';
import {workspaceGraphRequestSchema,type WorkspaceGraphNode,type WorkspaceGraphEdge} from '@noltri/schema';
import {projectSubjectGraph,selectWorkspaceGraph} from '../src/services/workspace-graph';
import {makeHarness} from './fakes';
import {applyCourseDocumentPatch,getCourseDocument,patchWorkspaceProperties} from '../src/services/course-workspace';
const node=(id:string,kind:WorkspaceGraphNode['kind']):WorkspaceGraphNode=>({id,title:id,kind,targets:[],boundary:false,linked:false,weight:0,createdAt:null});
const edge=(from:string,to:string):WorkspaceGraphEdge=>({id:from+to,from,to,kind:'membership',createdAt:null});
describe('course workspace graph projection',()=>{
  const nodes=[node('D','discipline'),node('X','discipline'),node('S','subdiscipline'),node('T','subdiscipline'),node('U','subdiscipline'),node('A','course'),node('B','course'),node('C','course'),node('H','chapter'),node('J','chapter')];
  const edges=[edge('S','D'),edge('T','D'),edge('S','X'),edge('U','X'),edge('A','S'),edge('B','S'),edge('B','T'),edge('C','T'),edge('H','A'),edge('H','B'),edge('J','B')];
  it('uses two adjacent types and stops at shared sibling boundaries',()=>{
    const select=(focus:unknown)=>projectSubjectGraph(nodes,edges,workspaceGraphRequestSchema.parse({focus,disciplineId:'D'}));
    expect(select({kind:'discipline',disciplineId:'D'}).nodes.map(n=>n.id).sort()).toEqual(['D','S','T','X']);
    expect(select({kind:'subdiscipline',disciplineId:'D',subdisciplineId:'S'}).nodes.map(n=>n.id).sort()).toEqual(['A','B','S','T']);
    expect(select({kind:'course',courseId:'A',disciplineId:'D'}).nodes.map(n=>n.id).sort()).toEqual(['A','B','H']);
  });
  it('whole-discipline layout and membership survive central course selection',()=>{
    const request={focus:{kind:'discipline',disciplineId:'D'},disciplineId:'D',subjectScope:'whole-discipline'};
    const before=projectSubjectGraph(nodes,edges,workspaceGraphRequestSchema.parse(request));
    const after=projectSubjectGraph(nodes,edges,workspaceGraphRequestSchema.parse({...request,focus:{kind:'chapter',courseId:'A',courseChapterId:'instance',disciplineId:'D'}}));
    expect(after).toEqual(before);expect(before.nodes.map(n=>n.id)).not.toContain('U');expect(before.nodes.find(n=>n.id==='X')?.boundary).toBe(true);
  });
  it('matches a complete query on one child owner before course aggregation',async()=>{
    const h=makeHarness(),u=h.actor.userId;
    const d=await h.repository.createNode({userId:u,title:'D',nodeType:'discipline'}),s=await h.repository.createNode({userId:u,title:'S',nodeType:'subdiscipline',parentId:d.id}),c=await h.repository.createNode({userId:u,title:'Course',nodeType:'topic',parentId:s.id});
    let doc=await getCourseDocument(h.core.deps,h.actor,c.id);
    await applyCourseDocumentPatch(h.core.deps,h.actor,{courseId:c.id,baseDocumentRevision:doc.documentRevision,entryRevisions:{},changes:[{from:doc.markdown.length,to:doc.markdown.length,insert:'\n## One\nalpha\n\n## Two\nbeta'}],requestId:'body'});
    doc=await getCourseDocument(h.core.deps,h.actor,c.id);
    await patchWorkspaceProperties(h.core.deps,h.actor,{owner:{kind:'entry',id:doc.entries[0].id},expectedRevision:doc.entries[0].revision,properties:{tags:['x']},requestId:'tag'});
    const request=workspaceGraphRequestSchema.parse({focus:{kind:'course',courseId:c.id,disciplineId:d.id},view:'advanced',advancedScope:'all',filter:'tag:x beta'});
    expect((await selectWorkspaceGraph(h.core.deps,h.actor,request)).nodes.filter(n=>n.kind==='course')).toHaveLength(0);
    request.filter='tag:x alpha';expect((await selectWorkspaceGraph(h.core.deps,h.actor,request)).nodes.map(n=>n.id)).toContain(c.id);
  });
});
it('requires a course for advanced focus rather than silently expanding a category globally',async()=>{
 const h=makeHarness(),userId=h.actor.userId;
 const d=await h.repository.createNode({userId,title:'D',nodeType:'discipline'}),s=await h.repository.createNode({userId,title:'S',nodeType:'subdiscipline',parentId:d.id});
 const c=await h.repository.createNode({userId,title:'Inside',nodeType:'topic',parentId:s.id});await h.repository.createNode({userId,title:'Outside',nodeType:'topic'});
 for(const focus of [{kind:'discipline',disciplineId:d.id},{kind:'subdiscipline',disciplineId:d.id,subdisciplineId:s.id}]){
  const request=workspaceGraphRequestSchema.parse({focus,view:'advanced',advancedScope:'focus'});
  await expect(selectWorkspaceGraph(h.core.deps,h.actor,request)).rejects.toMatchObject({code:'invalid_request'});
  const graph=await selectWorkspaceGraph(h.core.deps,h.actor,{...request,advancedScope:'discipline'});expect(graph.nodes.filter(n=>n.kind==='course').map(n=>n.id)).toEqual([c.id]);
 }
});
