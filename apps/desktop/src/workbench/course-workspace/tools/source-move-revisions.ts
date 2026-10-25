import type {CourseDocument} from '@noltri/schema';
import type {WorkbenchApi} from '../../api';
/** A block move can rewrite incoming links in courses beyond its two endpoints. */
export async function sourceMoveRevisions(api:Pick<WorkbenchApi,'workspaceMetadata'|'getCourseDocument'>,source:CourseDocument,target:CourseDocument,entryIds:readonly string[]):Promise<{expectedDocumentRevisions:Record<string,number>;expectedEntryRevisions:Record<string,number>}>{
 const selected=new Set(entryIds),metadata=await api.workspaceMetadata(),incoming=metadata.links.filter(link=>link.resolution.status==='resolved'&&!!link.resolution.target.entryId&&selected.has(link.resolution.target.entryId));
 const documents=new Map<string,CourseDocument>([[target.courseId,target],[source.courseId,source]]);
 const extraIds=[...new Set(incoming.map(link=>link.courseId))].filter(id=>!documents.has(id));
 for(const document of await Promise.all(extraIds.map(id=>api.getCourseDocument(id))))documents.set(document.courseId,document);
 const expectedEntryRevisions:Record<string,number>={};for(const entry of source.entries)if(selected.has(entry.id))expectedEntryRevisions[entry.id]=entry.revision;
 for(const link of incoming)if(link.entryId){const entry=documents.get(link.courseId)?.entries.find(entry=>entry.id===link.entryId);if(!entry)throw new Error('入链正文已变化，请刷新后重试。');expectedEntryRevisions[entry.id]=entry.revision;}
 return {expectedDocumentRevisions:Object.fromEntries([...documents.values()].map(document=>[document.courseId,document.documentRevision])),expectedEntryRevisions};
}
