import {useCallback,useEffect,useRef,useState} from 'react';
import type {ApplyCourseDocumentPatchRequest,CourseDocument} from '@noltri/schema';
import {WORKSPACE_REQUEST_MAX_BYTES} from '@noltri/schema';
import type {WorkbenchApi} from '../../api';
import {describeError} from '../../api';
import {clearCourseDraft,readCourseDraft,writeCourseDraft} from '../../note-drafts';
import {documentChanges} from './document-changes';
export type SaveState='loading'|'saved'|'draft'|'saving'|'error'|'conflict';
export function useCourseDocument(api:WorkbenchApi,courseId:string|null){
 const requestedCourse=useRef(courseId);requestedCourse.current=courseId;
 const [document,setDocument]=useState<CourseDocument|null>(null),[markdown,setMarkdown]=useState(''),[status,setStatus]=useState<SaveState>('loading'),[error,setError]=useState<string|null>(null),[recovery,setRecovery]=useState<ReturnType<typeof readCourseDraft>>(null);
 const state=useRef({document:null as CourseDocument|null,markdown:'',composing:false,generation:0,dirty:false}),saving=useRef<Promise<boolean>|null>(null),pending=useRef<ApplyCourseDocumentPatchRequest|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const protect=useCallback(()=>{const s=state.current;if(!s.document||!s.dirty)return true;return writeCourseDraft({courseId:s.document.courseId,baseRevision:s.document.documentRevision,baseMarkdown:s.document.markdown,markdown:s.markdown,updatedAt:new Date().toISOString()});},[]);
 const flush=useCallback(async():Promise<boolean>=>{
  if(saving.current){if(!await saving.current)return false;if(state.current.dirty&&!state.current.composing)return flush();return !state.current.dirty;}
  const s=state.current;if(!s.document||!s.dirty)return true;if(s.composing)return protect();
  const base=s.document,snapshot=s.markdown,generation=s.generation;protect();
  const request=pending.current??{courseId:base.courseId,baseDocumentRevision:base.documentRevision,entryRevisions:Object.fromEntries(base.entries.map(e=>[e.id,e.revision])),changes:documentChanges(base.markdown,snapshot),requestId:crypto.randomUUID()};
  if(!request.changes.length){s.dirty=false;setStatus('saved');return true;}
  if(new TextEncoder().encode(JSON.stringify(request)).length>WORKSPACE_REQUEST_MAX_BYTES){setStatus('error');setError('本次修改超过 2 MiB；草稿已保留，请减少单次修改后重试。');return false;}
  pending.current=request;setStatus('saving');setError(null);
  const work=(async()=>{try{const result=await api.applyCourseDocumentPatch(request);const next=result.documents.find(d=>d.courseId===base.courseId);if(!next)throw new Error('保存响应缺少课程正文。');if(generation!==state.current.generation)return true;
   pending.current=null;state.current.document=next;setDocument(next);if(state.current.markdown===snapshot){state.current.markdown=next.markdown;state.current.dirty=false;setMarkdown(next.markdown);clearCourseDraft(base.courseId,snapshot);setStatus('saved');}else{state.current.dirty=true;protect();setStatus('draft');}return true;
  }catch(e){if(generation!==state.current.generation)return false;const message=describeError(e);setError(message);setStatus(/conflict|revision|版本|冲突/i.test(message)?'conflict':'error');return false;}finally{saving.current=null;}})();saving.current=work;return work;
 },[api,protect]);
 useEffect(()=>{const generation=++state.current.generation;state.current.document=null;state.current.dirty=false;state.current.markdown='';pending.current=null;saving.current=null;setDocument(null);setMarkdown('');setError(null);setRecovery(null);setStatus('loading');if(!courseId)return;
  void api.getCourseDocument(courseId).then(next=>{if(generation!==state.current.generation)return;state.current.document=next;state.current.markdown=next.markdown;setDocument(next);setMarkdown(next.markdown);setStatus('saved');const draft=readCourseDraft(courseId);if(draft&&draft.markdown!==next.markdown)setRecovery(draft);}).catch(e=>{if(generation===state.current.generation){setStatus('error');setError(describeError(e));}});
  return ()=>{protect();};
 },[api,courseId,protect]);
 useEffect(()=>{if(status!=='draft')return;timer.current=setTimeout(()=>{void flush();},400);return()=>{if(timer.current)clearTimeout(timer.current);};},[markdown,status,flush]);
 useEffect(()=>{const unload=(event:BeforeUnloadEvent)=>{if(state.current.dirty){protect();event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[protect]);
 function change(value:string){if(!state.current.document)return;pending.current=null;state.current.markdown=value;state.current.dirty=value!==state.current.document.markdown;setMarkdown(value);setStatus(state.current.dirty?'draft':'saved');if(!protect()){setStatus('error');setError('本机草稿空间不足。请保持窗口打开并重试保存或导出正文。');}}
 function adopt(next:CourseDocument){if(next.courseId!==requestedCourse.current)throw new Error('返回的课程与当前选择不匹配，未替换正文');if(state.current.dirty)protect();state.current.document=next;state.current.markdown=next.markdown;state.current.dirty=false;pending.current=null;setDocument(next);setMarkdown(next.markdown);setStatus('saved');setError(null);}
 return {document,markdown,status,error,recovery,change,flush,protect,adopt,recover(){if(recovery){const stale=recovery.baseRevision!==state.current.document?.documentRevision;change(recovery.markdown);setRecovery(null);if(stale){setStatus('conflict');setError('草稿基于旧版本；请比较双方内容后选择保存方式。');}}},dismissRecovery(){setRecovery(null);},composition(active:boolean){state.current.composing=active;if(!active&&state.current.dirty){setStatus('draft');setTimeout(()=>void flush(),0);}},async reload(){if(!courseId)return;const latest=await api.getCourseDocument(courseId);adopt(latest);},async compare(){if(!courseId)return null;return api.getCourseDocument(courseId);}};
}
