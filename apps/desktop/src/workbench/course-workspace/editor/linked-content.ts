import {parseMarkdown} from '@noltri/note-engine';
import type {CourseDocument,WorkspaceLinkResolution} from '@noltri/schema';
export type ResolvedTarget=Extract<WorkspaceLinkResolution,{status:'resolved'}>['target'];
export function linkedMarkdown(document:CourseDocument,target:ResolvedTarget):string{
 if(target.kind==='entry'&&target.entryId){const entry=document.entries.find(e=>e.id===target.entryId);if(!entry)return '';if(target.blockId){const block=entry.blocks.find(b=>b.id===target.blockId||b.alias===target.blockId);return block?entry.markdown.slice(block.from,block.to):'';}if(target.headingPath){const heading=parseMarkdown(entry.markdown).headings.find(h=>target.headingPath!.every((part,i)=>h.path[h.path.length-target.headingPath!.length+i]===part));return heading?entry.markdown.slice(heading.from,heading.contentTo):'';}return entry.markdown;}
 if(target.kind==='chapter'&&target.courseChapterId){const range=document.projection.find(p=>p.kind==='chapter'&&p.courseChapterId===target.courseChapterId);if(!range)return '';const end=document.projection.find(p=>p.kind==='chapter'&&p.from>range.from)?.from??document.markdown.length;return document.markdown.slice(range.from,end);}
 return document.markdown;
}
