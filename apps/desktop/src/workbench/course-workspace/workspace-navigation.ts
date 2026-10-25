import {parseMarkdown} from '@noltri/note-engine';
import type {ContentLocation, NavigationOptions, TreeNode} from '@noltri/schema';
export type NavigateTo = (location: ContentLocation, options: NavigationOptions) => Promise<void>;
export interface CourseSummary { id:string; title:string; summary:string|null; itemCount:number; paths:TreeNode[][] }
export const TOOL_VIEWS = ['outline','backlinks','outgoing','tags','properties'] as const;
export type ToolView = typeof TOOL_VIEWS[number];
export function restoredTool(value:unknown):ToolView {return TOOL_VIEWS.includes(value as ToolView) ? value as ToolView : 'properties';}
export function courseCatalog(nodes:readonly TreeNode[]):CourseSummary[] {
  const map = new Map<string,CourseSummary>();
  function visit(children:readonly TreeNode[],parents:TreeNode[]):void {for(const node of children){const path=[...parents,node]; if(node.nodeType==='topic'){const old=map.get(node.id); if(old) old.paths.push(path); else map.set(node.id,{id:node.id,title:node.title,summary:node.summary,itemCount:node.descendantItemCount,paths:[path]});} else visit(node.children??[],path);}}
  visit(nodes,[]); return [...map.values()];
}
export function coursePath(course:CourseSummary,location?:ContentLocation|null,lastParent?:string):TreeNode[]{
  const parent=location&&'viaParentId' in location?location.viaParentId:undefined;
  return course.paths.find(path=>path.at(-2)?.id===(parent??lastParent)) ?? course.paths[0];
}
export function courseLocation(course:CourseSummary,path=course.paths[0]):ContentLocation {return {kind:'course',courseId:course.id,disciplineId:path[0]?.id,viaParentId:path.at(-2)?.id};}
export function locationOffset(document:{projection:{kind:string;from:number;entryId:string|null;courseChapterId:string|null}[];entries:{id:string;markdown:string;blocks:{id:string;from:number}[]}[]},location:ContentLocation):number {
  if(location.kind==='entry'){const range=document.projection.find(r=>r.entryId===location.entryId);const block=location.blockId?document.entries.find(e=>e.id===location.entryId)?.blocks.find(b=>b.id===location.blockId):null; const heading=location.headingPath?parseMarkdown(document.entries.find(e=>e.id===location.entryId)?.markdown??'').headings.find(h=>location.headingPath!.every((part,i)=>h.path[h.path.length-location.headingPath!.length+i]===part)):null; return (range?.from??0)+(block?.from??heading?.from??0);}
  return location.kind==='chapter'?document.projection.find(r=>r.kind==='chapter'&&r.courseChapterId===location.courseChapterId)?.from??0:0;
}
