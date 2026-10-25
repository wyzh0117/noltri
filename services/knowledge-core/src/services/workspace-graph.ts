import type { ContentLocation, CourseDocument, KnowledgeNode, WorkspaceGraph, WorkspaceGraphEdge, WorkspaceGraphNode, WorkspaceGraphRequest } from '@noltri/schema';
import { workspaceGraphSchema } from '@noltri/schema';
import { knowledgeError } from '@noltri/shared';
import type { ActorContext, CoreDeps } from '../types';
import { taxonomyNodeType } from '../node-taxonomy';
import { documentFromState, loadWorkspace } from './course-workspace';
import { getMetadataIndex } from './metadata';
import {listAttachments} from './workspace-resources';
import { compileQuery, matchQuery, type EngineLocation } from '@noltri/note-engine';

export interface GraphQueryMatch { courseIds:Set<string>; colors:Map<string,string> }
/** A two-level subject graph is a membership projection, never a generic two-hop BFS. */
export function projectSubjectGraph(nodes:readonly WorkspaceGraphNode[], edges:readonly WorkspaceGraphEdge[], request:WorkspaceGraphRequest):WorkspaceGraph {
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const focus=request.focus;
  const focusId=focus.kind==='discipline'?focus.disciplineId:focus.kind==='subdiscipline'?focus.subdisciplineId:focus.courseId;
  const disciplineId=request.disciplineId??('disciplineId' in focus?focus.disciplineId:undefined);
  if(!byId.has(focusId))throw knowledgeError('not_found','图谱定位对象不存在');
  const members=edges.filter(e=>e.kind==='membership');
  const children=(id:string)=>members.filter(e=>e.to===id).map(e=>e.from);
  const parents=(id:string)=>members.filter(e=>e.from===id).map(e=>e.to);
  const inDiscipline=new Set<string>();
  if(disciplineId){const pending=[disciplineId];while(pending.length){const id=pending.pop()!;if(inDiscipline.has(id))continue;inDiscipline.add(id);pending.push(...children(id));}}
  const selected=new Set<string>();
  if(request.subjectScope==='whole-discipline'){
    if(!disciplineId||byId.get(disciplineId)?.kind!=='discipline')throw knowledgeError('invalid_request','整学科图需要明确一级学科');
    for(const id of inDiscipline)selected.add(id);
    for(const id of [...selected])if(byId.get(id)?.kind==='subdiscipline')for(const parent of parents(id))if(byId.get(parent)?.kind==='discipline')selected.add(parent);
  }else{
    selected.add(focusId);
    for(const child of children(focusId)){selected.add(child);for(const parent of parents(child))if(byId.get(parent)?.kind===byId.get(focusId)?.kind)selected.add(parent);}
    if(byId.get(focusId)?.kind==='course')for(const edge of edges)if(edge.kind!=='membership'&&(edge.from===focusId||edge.to===focusId)){selected.add(edge.from);selected.add(edge.to);}
  }
  const visible=nodes.filter(n=>selected.has(n.id)).map(n=>({...n,boundary:disciplineId? !inDiscipline.has(n.id):false}));
  const visibleIds=new Set(visible.map(n=>n.id));
  return {layoutKey:`subject:${disciplineId??'none'}:${request.subjectScope==='whole-discipline'?'whole':focusId}`,revision:0,nodes:visible,edges:edges.filter(e=>visibleIds.has(e.from)&&visibleIds.has(e.to))};
}

export async function loadGraphObjects(deps:CoreDeps,actor:ActorContext):Promise<{nodes:WorkspaceGraphNode[];edges:WorkspaceGraphEdge[];documents:CourseDocument[]}> {
  const state=await loadWorkspace(deps,actor);
  const raw=await deps.repository.listNodes(actor.userId), byId=new Map(raw.filter(n=>n.status!=='archived').map(n=>[n.id,n]));
  const stored=await deps.repository.listEdges(actor.userId), parents=new Map<string,Set<string>>();
  const kind=(n:KnowledgeNode)=>taxonomyNodeType(n,byId)==='topic'?'course':taxonomyNodeType(n,byId);
  const rank:Record<string,number>={discipline:0,subdiscipline:1,course:2};
  const add=(child:string,parent:string):void=>{const a=byId.get(child),b=byId.get(parent);if(!a||!b||rank[kind(a)]!==rank[kind(b)]+1)return;const p=parents.get(child)??new Set();p.add(parent);parents.set(child,p);};
  for(const n of byId.values())if(n.parentId)add(n.id,n.parentId);
  for(const e of stored)if(e.relationType==='part_of'&&!(e.source==='tree_structure'&&byId.get(e.fromNodeId)?.parentId!==e.toNodeId))add(e.fromNodeId,e.toNodeId);
  const roots=(id:string,seen=new Set<string>()):string[]=>{if(seen.has(id))return [];seen.add(id);const n=byId.get(id);if(n&&kind(n)==='discipline')return [id];return [...new Set([...(parents.get(id)??[])].flatMap(p=>roots(p,new Set(seen))))];};
  const nodes:WorkspaceGraphNode[]=[],edges:WorkspaceGraphEdge[]=[],documents:CourseDocument[]=[];
  for(const n of byId.values()){
    const k=kind(n);if(!['discipline','subdiscipline','course'].includes(k))continue;
    let targets:ContentLocation[]=[];
    if(k==='discipline')targets=[{kind:'discipline',disciplineId:n.id}];
    if(k==='subdiscipline')targets=roots(n.id).map(d=>({kind:'subdiscipline',disciplineId:d,subdisciplineId:n.id}));
    if(k==='course'){
      const doc=await documentFromState(deps,actor,state,n.id);documents.push(doc);
      targets=[...(parents.get(n.id)??[])].flatMap(p=>roots(p).map(d=>({kind:'course' as const,courseId:n.id,disciplineId:d,viaParentId:p})));
      if(!targets.length)targets=[{kind:'course',courseId:n.id}];
    }
    nodes.push({id:n.id,title:n.title,kind:k as WorkspaceGraphNode['kind'],targets,boundary:false,linked:false,weight:0,createdAt:n.createdAt});
    for(const p of parents.get(n.id)??[])edges.push({id:`member:${n.id}:${p}`,from:n.id,to:p,kind:'membership',createdAt:stored.find(e=>e.fromNodeId===n.id&&e.toNodeId===p&&e.relationType==='part_of')?.createdAt??null});
  }
  const concepts=new Map<string,WorkspaceGraphNode>();
  for(const doc of documents)for(const c of doc.chapters){
    if(c.detached)continue;
    const id=`concept:${c.conceptId}`,node=concepts.get(id)??{id,title:c.title,kind:'chapter' as const,targets:[],boundary:false,linked:false,weight:0,createdAt:null};
    const course=nodes.find(n=>n.id===doc.courseId);
    node.targets.push(...(course?.targets??[{kind:'course' as const,courseId:doc.courseId}]).map(t=>({kind:'chapter' as const,courseId:doc.courseId,courseChapterId:c.id,...('disciplineId'in t&&t.disciplineId?{disciplineId:t.disciplineId}:{})})));
    concepts.set(id,node);edges.push({id:`chapter:${c.id}`,from:id,to:doc.courseId,kind:'membership',createdAt:null});
  }
  nodes.push(...concepts.values());
  return {nodes,edges,documents};
}

function location(target:EngineLocation):ContentLocation {
  if(target.kind==='entry'&&target.entryId)return {kind:'entry',courseId:target.courseId,courseChapterId:target.courseChapterId??null,entryId:target.entryId,...(target.blockId?{blockId:target.blockId}:{}),...(target.headingPath?{headingPath:target.headingPath}:{})};
  if(target.kind==='chapter'&&target.courseChapterId)return {kind:'chapter',courseId:target.courseId,courseChapterId:target.courseChapterId};
  return {kind:'course',courseId:target.courseId};
}

export async function selectWorkspaceGraph(deps:CoreDeps,actor:ActorContext,request:WorkspaceGraphRequest):Promise<WorkspaceGraph> {
  const {nodes,edges,documents}=await loadGraphObjects(deps,actor),index=await getMetadataIndex(deps,actor);
  const byId=new Map(nodes.map(n=>[n.id,n]));
  for(const link of index.links){
    if(link.resolution.status!=='resolved')continue;
    const target=link.resolution.target,course=byId.get(target.courseId);
    if(!course)continue;course.linked=true;
    const precise=location(target),kind=link.reference.embed?'embed':'link';
    edges.push({id:`link:${JSON.stringify(link.sourceLocation)}:${link.field??''}:${link.reference.from}`,from:link.courseId,to:target.courseId,kind,target:precise,createdAt:null});
    const chapterId=target.courseChapterId??documents.find(d=>d.courseId===target.courseId)?.entries.find(e=>e.id===target.entryId)?.courseChapterId;
    const chapter=documents.flatMap(d=>d.chapters).find(c=>c.id===chapterId);
    if(chapter){const concept=byId.get(`concept:${chapter.conceptId}`);if(concept){concept.linked=true;edges.push({id:`link-anchor:${JSON.stringify(link.sourceLocation)}:${link.field??''}:${link.reference.from}`,from:link.courseId,to:concept.id,kind,target:precise,createdAt:null});}}
  }
  if(request.view==='subject')return finishWorkspaceGraph({...projectSubjectGraph(nodes,edges,request),revision:index.revision});
  const query=compileQuery(request.filter),groups=request.groups.map(g=>({...g,ast:compileQuery(g.query)}));
  const matched=new Set<string>(),colors=new Map<string,string>();
  // Complete queries match one owner before projection; AND never joins two entries.
  for(const object of index.objects){if(matchQuery(query,object).matched)matched.add(object.courseId);}
  for(const group of groups)for(const object of index.objects)if(!colors.has(object.courseId)&&matchQuery(group.ast,object).matched)colors.set(object.courseId,group.color);
  const focus=request.focus,focusCourse='courseId'in focus?focus.courseId:undefined;
  const discipline=request.disciplineId??('disciplineId'in focus?focus.disciplineId:undefined);
  const courses=nodes.filter(n=>n.kind==='course');
  const allowed=new Set(courses.filter(n=>request.advancedScope==='all'||request.advancedScope==='focus'||n.targets.some(t=>'disciplineId'in t&&t.disciplineId===discipline)).map(n=>n.id));
  const networkEdges=edges.filter(e=>(e.kind==='link'||e.kind==='embed')&&byId.get(e.to)?.kind==='course'&&allowed.has(e.from)&&allowed.has(e.to));
  const selected=new Set<string>(),traversed=new Set<string>();
  if(request.advancedScope==='focus'&&focusCourse){
    selected.add(focusCourse);let frontier=new Set([focusCourse]);
    for(let depth=0;depth<request.depth;depth++){
      const next=new Set<string>();
      for(const e of networkEdges){if(request.outgoing&&frontier.has(e.from)){selected.add(e.to);next.add(e.to);traversed.add(e.id);}if(request.incoming&&frontier.has(e.to)){selected.add(e.from);next.add(e.from);traversed.add(e.id);}}
      frontier=next;
    }
  }else for(const id of allowed)selected.add(id);
  const visible:WorkspaceGraphNode[]=courses.filter(n=>selected.has(n.id)&&matched.has(n.id)).map(n=>({...n,color:colors.get(n.id)}));
  const visibleIds=new Set(visible.map(n=>n.id));
  let visibleEdges=networkEdges.filter(e=>visibleIds.has(e.from)&&visibleIds.has(e.to)&&(request.advancedScope!=='focus'||request.interconnect||traversed.has(e.id)));
  if(request.showTags){
    const tags=new Map<string,Set<string>>();
    for(const object of index.objects)if(visibleIds.has(object.courseId))for(const tag of object.tags??[]){const courses=tags.get(tag)??new Set<string>();courses.add(object.courseId);tags.set(tag,courses);}
    for(const [tag,courseIds] of tags){if(!matchQuery(query,{id:`tag:${tag}`,kind:'tag',title:tag,tags:[tag]}).matched)continue;const id=`tag:${tag}`;visible.push({id,title:tag,kind:'tag',targets:[],boundary:false,linked:false,weight:0,createdAt:null});for(const c of courseIds)visibleEdges.push({id:`${id}:${c}`,from:c,to:id,kind:'tag',createdAt:null});}
  }
  const attachments=await listAttachments(deps,actor);
  const attachmentByPath=new Map(attachments.map(a=>[a.path,a]));
  const attachmentReference=(raw:string)=>{try{return attachmentByPath.get(decodeURIComponent(raw.split('#')[0]));}catch{return undefined;}};
  if(request.showAttachments){
    const assets=new Map<string,WorkspaceGraphNode>();
    for(const link of index.links){
      if(!visibleIds.has(link.courseId))continue;
      const a=attachmentReference(link.reference.target);if(!a)continue;
      const id=`attachment:${a.id}`;
      if(!matchQuery(query,{id,kind:'attachment',title:a.path.split('/').at(-1),file:a.path,path:a.path,properties:{mimeType:a.mimeType,size:a.size}}).matched)continue;
      assets.set(id,{id,title:a.path.split('/').at(-1)??a.id,kind:'attachment',targets:[],boundary:false,linked:true,weight:0,createdAt:a.createdAt});
      visibleEdges.push({id:`attachment:${link.entryId}:${link.reference.from}`,from:link.courseId,to:id,kind:'attachment',createdAt:null});
    }
    visible.push(...assets.values());
  }
  if(request.showUnresolved){
    const unresolved=new Map<string,WorkspaceGraphNode>();
    for(const link of index.links){if(!visibleIds.has(link.courseId)||link.resolution.status!=='unresolved'||attachmentReference(link.reference.target))continue;const title=link.reference.target,id=`unresolved:${title.normalize('NFC')}`;if(!unresolved.has(id))unresolved.set(id,{id,title:`${title} · 待建立`,kind:'unresolved',targets:[],boundary:false,linked:true,weight:0,createdAt:null});visibleEdges.push({id:`unresolved:${JSON.stringify(link.sourceLocation)}:${link.field??''}:${link.reference.from}`,from:link.courseId,to:id,kind:link.reference.embed?'embed':'link',createdAt:null});}
    visible.push(...unresolved.values());
  }
  if(!request.showOrphans){const connected=new Set(visibleEdges.flatMap(e=>[e.from,e.to]));for(let i=visible.length-1;i>=0;i--)if(!connected.has(visible[i].id))visible.splice(i,1);}
  const finalIds=new Set(visible.map(n=>n.id));visibleEdges=visibleEdges.filter(e=>finalIds.has(e.from)&&finalIds.has(e.to));
  return finishWorkspaceGraph({layoutKey:`advanced:${request.advancedScope}:${request.advancedScope==='focus'?focusCourse:request.advancedScope==='discipline'?discipline:'all'}`,revision:index.revision,nodes:visible,edges:visibleEdges});
}

export function finishWorkspaceGraph(graph:WorkspaceGraph):WorkspaceGraph {
  const degrees=new Map<string,number>();
  for(const e of graph.edges){degrees.set(e.from,(degrees.get(e.from)??0)+1);degrees.set(e.to,(degrees.get(e.to)??0)+1);}
  return workspaceGraphSchema.parse({...graph,nodes:graph.nodes.map(n=>({...n,weight:degrees.get(n.id)??0}))});
}
