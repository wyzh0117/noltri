import {parseMarkdown} from '@noltri/note-engine';
import type {CourseDocument} from '@noltri/schema';
export interface LinkOccurrence {courseId?:string;courseChapterId?:string|null;entryId?:string;referenceFrom?:number;documentFrom?:number}
export type OpenKnowledgeLink=(raw:string,occurrence?:LinkOccurrence)=>void;
export function documentReference(document:CourseDocument,from:number):LinkOccurrence {
 const range=document.projection.find(range=>range.kind==='entry'&&range.entryId&&range.from<=from&&from<range.to);
 return {courseId:document.courseId,documentFrom:from,...(range?{entryId:range.entryId!,courseChapterId:range.courseChapterId,referenceFrom:from-range.from}:{})};
}
/** Match the clicked AST occurrence through save normalization; identical raw links remain distinct. */
export function savedReferenceOffset(before:string,after:string,from:number):number {
 if(before===after)return from;
 const previous=parseMarkdown(before,{tolerateInvalidFrontmatter:true}).links,next=parseMarkdown(after,{tolerateInvalidFrontmatter:true}).links,index=previous.findIndex(link=>link.from===from);
 if(index<0||previous.length!==next.length||next[index]?.raw!==previous[index].raw)throw new Error('保存时链接位置发生变化，请重新点击链接。');
 return next[index].from;
}

export function referenceInput(raw:string):string {const parsed=parseMarkdown(raw,{tolerateInvalidFrontmatter:true}).links.find(link=>link.from===0&&link.to===raw.length);return parsed?.raw??'[['+raw+']]';}
export function referenceTarget(raw:string):string {return parseMarkdown(raw,{tolerateInvalidFrontmatter:true}).links.find(link=>link.from===0&&link.to===raw.length)?.target??raw.split('|')[0];}
