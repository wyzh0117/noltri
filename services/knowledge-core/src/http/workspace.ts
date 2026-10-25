import {z} from 'zod';
import {
  applyCourseDocumentPatchSchema,moveSourceAssignmentsSchema,courseDocumentSchema,workspaceMutationResultSchema,
  workspaceGraphRequestSchema,workspaceGraphSchema,workspaceMetadataSchema,workspaceSearchRequestSchema,workspaceSearchResponseSchema,
  resolveWorkspaceLinkRequestSchema,linkResolutionSchema,contentLocationSchema,workspaceBacklinksSchema,restoreSnapshotRequestSchema,
  workspaceSnapshotSchema,workspaceSettingsSchema,WORKSPACE_REQUEST_MAX_BYTES,patchWorkspacePropertiesSchema,
  workspaceAttachmentSchema,uploadAttachmentSchema,renameAttachmentSchema,importMarkdownSchema,importMarkdownResultSchema,courseMarkdownExportSchema,
} from '@noltri/schema';
import {knowledgeError} from '@noltri/shared';
import type {ActorContext} from '../types';
import type {KnowledgeCore} from '../core';
import {requireNodeAccess,requireScope,type ClientGrant} from '../authorization';
import {getCourseDocument,applyCourseDocumentPatch,moveSourceAssignments,patchWorkspaceProperties} from '../services/course-workspace';
import {getMetadataIndex,searchKnowledge,resolveWorkspaceLink,getBacklinks} from '../services/metadata';
import {listSnapshots,restoreSnapshot,getWorkspaceSettings,updateWorkspaceSettings} from '../services/recovery';
import {selectWorkspaceGraph} from '../services/workspace-graph';
import {listAttachments,readAttachment,uploadAttachment,deleteAttachment,renameAttachment,cleanupAttachments,importMarkdown,exportCourseMarkdown} from '../services/workspace-resources';
import {readJsonBody,parseWith} from './parse';
export const WORKSPACE_ROUTES=[
  {method:'POST',segments:['api','workspace','attachments',':id','rename']},
  {method:'POST',segments:['api','workspace','attachments','cleanup']},
  {method:'GET',segments:['api','workspace','attachments']},
  {method:'POST',segments:['api','workspace','attachments']},
  {method:'DELETE',segments:['api','workspace','attachments',':id']},
  {method:'GET',segments:['api','workspace','attachments',':id','content']},
  {method:'POST',segments:['api','workspace','import']},
  {method:'GET',segments:['api','workspace','courses',':id','export']},
  {method:'GET',segments:['api','workspace','courses',':id','document']},
  {method:'PATCH',segments:['api','workspace','courses',':id','document']},
  {method:'POST',segments:['api','workspace','source-assignments','move']},
  {method:'POST',segments:['api','workspace','graph']},
  {method:'GET',segments:['api','workspace','metadata']},
  {method:'POST',segments:['api','workspace','search']},
  {method:'POST',segments:['api','workspace','links','resolve']},
  {method:'POST',segments:['api','workspace','backlinks']},
  {method:'GET',segments:['api','workspace','snapshots']},
  {method:'POST',segments:['api','workspace','snapshots',':id','restore']},
  {method:'GET',segments:['api','workspace','settings']},
  {method:'PATCH',segments:['api','workspace','settings']},
  {method:'POST',segments:['api','workspace','properties']},
];
export async function handleWorkspace(args:{path:string;method:string;segments:readonly string[];request:Request;core:KnowledgeCore;actor:ActorContext;grant?:ClientGrant}):Promise<unknown>{
  const {path,method,segments,request,core,actor,grant}=args,deps=core.deps;
  const body=()=>readJsonBody(request,WORKSPACE_REQUEST_MAX_BYTES);
  if(grant&&!grant.scopes.includes('read'))throw knowledgeError('unauthorized','工作区需要读取权限；只写采集请使用现有采集入口');
  // A truncated editable projection cannot safely be written back. Capped clients use search.
  if(actor.snippetChars!==undefined&&path!=='api/workspace/search')throw knowledgeError('unauthorized','此连接仅授权片段检索，连续正文与索引需要完整读取授权');
  if(path==='api/workspace/courses/:id/document'){
    const courseId=decodeURIComponent(segments[3]);requireNodeAccess(grant,courseId,'课程正文');
    if(method==='GET')return courseDocumentSchema.parse(await getCourseDocument(deps,actor,courseId));
    requireNodeAccess(grant,null,'课程结构与引用事务');
    const input=parseWith(applyCourseDocumentPatchSchema,await body(),'document patch');if(input.courseId!==courseId)throw knowledgeError('invalid_request','路径与请求课程不一致');
    return workspaceMutationResultSchema.parse(await applyCourseDocumentPatch(deps,actor,input));
  }
  requireNodeAccess(grant,null,'统一工作区索引与跨课程事务');
  switch(path){
    case 'api/workspace/source-assignments/move':return workspaceMutationResultSchema.parse(await moveSourceAssignments(deps,actor,parseWith(moveSourceAssignmentsSchema,await body(),'move source assignments')));
    case 'api/workspace/graph':return workspaceGraphSchema.parse(await selectWorkspaceGraph(deps,actor,parseWith(workspaceGraphRequestSchema,await body(),'workspace graph')));
    case 'api/workspace/metadata':return workspaceMetadataSchema.parse(await getMetadataIndex(deps,actor));
    case 'api/workspace/search':{const input=parseWith(workspaceSearchRequestSchema,await body(),'workspace search');return workspaceSearchResponseSchema.parse(await searchKnowledge(deps,actor,input.query,input.cursor,{signal:request.signal,limit:input.limit}));}
    case 'api/workspace/links/resolve':{const input=parseWith(resolveWorkspaceLinkRequestSchema,await body(),'resolve knowledge link');return linkResolutionSchema.parse(await resolveWorkspaceLink(deps,actor,input.context,input.rawLink));}
    case 'api/workspace/backlinks':{const {target}=parseWith(z.object({target:contentLocationSchema}),await body(),'backlinks');return workspaceBacklinksSchema.parse(await getBacklinks(deps,actor,target));}
    case 'api/workspace/snapshots':return z.array(workspaceSnapshotSchema).parse(await listSnapshots(deps,actor));
    case 'api/workspace/snapshots/:id/restore':{const input=parseWith(restoreSnapshotRequestSchema,await body(),'restore snapshot');return workspaceMutationResultSchema.parse(await restoreSnapshot(deps,actor,decodeURIComponent(segments[3]),input.expectedRevisions));}
    case 'api/workspace/attachments':return method==='GET'?z.array(workspaceAttachmentSchema).parse(await listAttachments(deps,actor,new URL(request.url).searchParams.get('courseId')??undefined)):await uploadAttachment(deps,actor,parseWith(uploadAttachmentSchema,await body(),'attachment upload'));
    case 'api/workspace/attachments/:id/rename':{const input=parseWith(renameAttachmentSchema,await body(),'rename attachment');if(input.attachmentId!==decodeURIComponent(segments[3]))throw knowledgeError('invalid_request','路径与附件身份不一致');return workspaceMutationResultSchema.extend({attachment:workspaceAttachmentSchema}).parse(await renameAttachment(deps,actor,input));}
    case 'api/workspace/attachments/cleanup':return cleanupAttachments(deps,actor,parseWith(z.object({confirmed:z.boolean().optional(),attachmentIds:z.array(z.string()).optional(),expectedRevisions:z.record(z.string(),z.number().int().nonnegative()).optional()}),await body(),'attachment cleanup'));
    case 'api/workspace/attachments/:id':{const input=parseWith(z.object({expectedRevision:z.number().int().positive()}),await body(),'delete attachment');await deleteAttachment(deps,actor,decodeURIComponent(segments[3]),input.expectedRevision);return {ok:true};}
    case 'api/workspace/attachments/:id/content':{
      const {attachment,bytes}=await readAttachment(deps,actor,decodeURIComponent(segments[3]));
      const safe=/^(image\/(png|jpeg|gif|webp|avif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/pdf)$/i.test(attachment.mimeType);
      return new Response(new Uint8Array(bytes).buffer,{headers:{'content-type':safe?attachment.mimeType:'application/octet-stream','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(attachment.path.split('/').at(-1)??'attachment')}`,'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"}});
    }
    case 'api/workspace/import':requireScope(grant,'POST','api/capture');return importMarkdownResultSchema.parse(await importMarkdown(deps,actor,parseWith(importMarkdownSchema,await body(),'Markdown import')));
    case 'api/workspace/courses/:id/export':return courseMarkdownExportSchema.parse(await exportCourseMarkdown(deps,actor,decodeURIComponent(segments[3])));
    case 'api/workspace/properties':return workspaceMutationResultSchema.parse(await patchWorkspaceProperties(deps,actor,parseWith(patchWorkspacePropertiesSchema,await body(),'workspace properties')));
    case 'api/workspace/settings':return workspaceSettingsSchema.parse(method==='GET'?await getWorkspaceSettings(deps,actor):await updateWorkspaceSettings(deps,actor,parseWith(workspaceSettingsSchema.partial(),await body(),'workspace settings')));
    default:throw knowledgeError('not_found','未知工作区端点');
  }
}
