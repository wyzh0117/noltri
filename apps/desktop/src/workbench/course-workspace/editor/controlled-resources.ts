import type {WorkbenchApi} from '../../api';
import {attachmentReference} from '@noltri/note-engine';
/** Unsaved references resolve from the authenticated registry, before course association exists. */
export async function renderControlledResources(container:HTMLElement,api:WorkbenchApi,_courseId:string):Promise<()=>void>{
 const elements=[...container.querySelectorAll<HTMLImageElement|HTMLAnchorElement>('img[src],a[href]')].filter(element=>attachmentReference(element.dataset.resourcePath??element.getAttribute(element.tagName==='IMG'?'src':'href')??''));
 if(!elements.length)return()=>{};
 const attachments=await api.listAttachments(),urls:string[]=[];
 try{for(const element of elements){
  const attr=element.tagName==='IMG'?'src':'href',raw=element.dataset.resourcePath??element.getAttribute(attr)??'',reference=attachmentReference(raw)!;
  element.dataset.resourcePath=raw;const attachment=attachments.find(a=>a.path===reference.path);
  if(!attachment){element.removeAttribute(attr);element.title='附件不可用';continue;}
  const blob=await api.getAttachmentContent(attachment.id);if(!element.isConnected)continue;
  const url=URL.createObjectURL(blob);urls.push(url);element.setAttribute(attr,url+reference.fragment);
  if(element.tagName==='A')(element as HTMLAnchorElement).download=attachment.path.split('/').at(-1)??attachment.id;
 }}catch(error){urls.forEach(url=>URL.revokeObjectURL(url));throw error;}
 return()=>urls.forEach(url=>URL.revokeObjectURL(url));
}
