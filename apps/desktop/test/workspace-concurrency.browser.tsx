/** Run from a Vite page in a real browser; no DOM emulator or test dependency is needed. */
import {useEffect,useLayoutEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import type {ApplyCourseDocumentPatchRequest,CourseDocument,LibraryItem,WorkspaceMutationResult} from '@noltri/schema';
import type {EditorView} from '@codemirror/view';
import type {WorkbenchApi} from '../src/workbench/api';
import {CourseEditor} from '../src/workbench/course-workspace/CourseEditor';
import {useCourseDocument} from '../src/workbench/course-workspace/editor/useCourseDocument';
import {MaterialsInbox} from '../src/workbench/course-workspace/tools/MaterialsInbox';

const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
async function until(check:()=>boolean){for(let i=0;i<120;i++){if(check())return;await frame();}throw new Error('Browser check timed out');}
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}

export async function checkEditorSaveRace(container:HTMLElement){
 let saved:CourseDocument={courseId:'concurrency-check',title:'Test',documentRevision:1,markdown:'# Test\n\nOriginal\n\n',chapters:[],entries:[],properties:{},sourceLinks:[],sources:[],projection:[]};
 const requests:Array<{request:ApplyCourseDocumentPatchRequest;resolve:(result:WorkspaceMutationResult)=>void}>=[];
 const api={getCourseDocument:async()=>saved,applyCourseDocumentPatch:(request:ApplyCourseDocumentPatchRequest)=>new Promise<WorkspaceMutationResult>(resolve=>requests.push({request,resolve}))} as unknown as WorkbenchApi;
 let current:ReturnType<typeof useCourseDocument>|undefined,view:EditorView|null=null,injectAtRevision=0;
 const append=(marker:number)=>{assert(view,'Editor missing');const from=view.state.doc.length,insert=`续写${marker} `;view.dispatch({changes:{from,insert},selection:{anchor:from+insert.length}});};
 function App(){const doc=useCourseDocument(api,saved.courseId),editor=useRef<EditorView|null>(null);current=doc;
  useEffect(()=>{view=editor.current;},[doc.document?.courseId]);
  useLayoutEffect(()=>{view=editor.current;if(doc.document?.documentRevision===injectAtRevision){injectAtRevision=0;append(1);}},[doc.document?.documentRevision]);
  return doc.document?<CourseEditor value={doc.markdown} mode="source" onChange={doc.change} onSelect={()=>{}} onComposition={doc.composition} onLink={()=>{}} completions={[]} offset={0} editorRef={editor}/>:null;
 }
 function respond(){const job=requests.shift();assert(job,'Save request missing');assert(job.request.baseDocumentRevision===saved.documentRevision,'Stale save base');
  const markdown=job.request.changes.reduceRight((text,c)=>text.slice(0,c.from)+c.insert+text.slice(c.to),saved.markdown).trimEnd()+'\n\n';saved={...saved,markdown,documentRevision:saved.documentRevision+1};job.resolve({documents:[saved],affectedLocations:[],revisions:{},snapshotId:null});
 }
 const root=createRoot(container);root.render(<App/>);
 try{
  await until(()=>Boolean(view&&current?.document));append(0);const first=current!.flush();await until(()=>requests.length===1);
  // A native/editor transaction after the response render but before passive effects must survive.
  injectAtRevision=2;respond();await first;await frame();await frame();
  assert(view!.state.doc.toString().includes('续写1 '),'Response passive effect erased the next input: 续写1');
  assert(current!.markdown.includes('续写1 '),'Hook lost the input after response adoption');
  const second=current!.flush();await until(()=>requests.length===1);
  view!.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));append(2);respond();await second;await frame();
  assert(current!.markdown.includes('续写2 '),'In-flight response erased composition input');
  view!.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'续写2 '}));
  await until(()=>requests.length===1);respond();await until(()=>current?.status==='saved');await frame();
  const markers=[...saved.markdown.matchAll(/续写(\d+)/g)].map(match=>Number(match[1]));
  assert(JSON.stringify(markers)==='[0,1,2]',`Saved input sequence differs: ${JSON.stringify(markers)}`);
  assert(view!.state.doc.toString()===saved.markdown,'Editor differs from saved document');
  return {passed:true,markers,revision:saved.documentRevision};
 }finally{root.unmount();window.localStorage.removeItem('noltri:course-draft:v1:concurrency-check');}
}

export async function checkInboxArchivePage(container:HTMLElement){
 const items:LibraryItem[]=Array.from({length:201},(_,i)=>({id:`item-${i}`,content:`Original input ${i}`,summary:null,kind:'paper_excerpt',source:{type:'manual',title:`Input ${i}`,url:null,platform:null,appName:null,capturedAt:'2026-10-26T00:00:00Z',citation:null,page:null,author:null,doi:null},previewImageUrl:null,subjectPath:[],researchPoint:null,tags:[],aiStatus:'pending',createdAt:'2026-10-26T00:00:00Z',archived:false}));
 const offsets:number[]=[],requests:string[]=[];let delayArchive=false,finishArchive:(()=>void)|null=null;
 const api={listItems:async({state,limit,offset}:{state:string;limit:number;offset:number})=>{offsets.push(offset);requests.push(`${state}:${offset}`);return {items:items.filter(item=>state==='all'||(state==='archive'?item.archived:!item.archived)).slice(offset,offset+limit)};},listItemRelations:async()=>[],archiveItem:(id:string)=>new Promise<{item:LibraryItem}>(resolve=>{const finish=()=>{const item=items.find(item=>item.id===id)!;item.archived=true;resolve({item:{...item}});};if(delayArchive)finishArchive=finish;else finish();})} as unknown as WorkbenchApi;
 const root=createRoot(container);root.render(<MaterialsInbox api={api} paths={[]} onClose={()=>{}} onUpdated={()=>{}}/>);
 const button=(text:string)=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===text);
 try{
  await until(()=>container.querySelectorAll('.cw-inbox-item').length===200);
  button('加入比较')!.click();await frame();(container.querySelector('.cw-inbox-open') as HTMLButtonElement).click();await until(()=>Boolean(button('移到归档')));
  button('移到归档')!.click();await until(()=>Boolean(button('恢复到资料库')));(container.querySelector('[aria-label="关闭详情"]') as HTMLButtonElement).click();await frame();await frame();
  button('加载更多资料')?.click();await frame();await frame();
  const titles=[...container.querySelectorAll('.cw-inbox-open')].map(element=>element.textContent);
  assert(titles.includes('Input 200'),`Last input unreachable after archive; offsets ${JSON.stringify(offsets)}`);
  assert(!titles.includes('Input 0'),'Archived input remains in pending list');
  assert(Boolean(button('并排研究比较（1/2）')),'Archive reset the comparison selection');
  const pageOffsets=[...offsets];delayArchive=true;
  (container.querySelector('.cw-inbox-open') as HTMLButtonElement).click();await until(()=>Boolean(button('移到归档')));
  button('移到归档')!.click();await until(()=>Boolean(finishArchive));(container.querySelector('[aria-label="关闭详情"]') as HTMLButtonElement).click();await frame();
  button('已归档')!.click();await until(()=>container.querySelector('.cw-inbox-open')?.textContent==='Input 0');
  finishArchive!();await frame();await frame();
  const reopened=container.querySelector<HTMLButtonElement>('[aria-label="关闭详情"]');if(reopened){reopened.click();await frame();await frame();}
  const archivedTitles=[...container.querySelectorAll('.cw-inbox-open')].map(element=>element.textContent);
  assert(button('已归档')?.getAttribute('aria-pressed')==='true','Current filter changed after delayed archive');
  assert(JSON.stringify(archivedTitles)==='["Input 0","Input 1"]',`Delayed archive replaced the active filter: ${JSON.stringify({requests,archivedTitles})}`);
  assert(!reopened,'Delayed archive reopened closed details');
  assert(Boolean(button('并排研究比较（1/2）')),'Delayed archive reset comparison selection');
  return {passed:true,visible:titles.length,offsets:pageOffsets,retainedComparison:1,delayedFilter:{requests,archivedTitles,reopened:Boolean(reopened)}};
 }finally{root.unmount();}
}
