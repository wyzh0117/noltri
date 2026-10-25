import type {ReactElement} from 'react';
import type {WorkbenchApi} from './api';
import type {EditorView} from '@codemirror/view';
import {CourseEditor} from './course-workspace/CourseEditor';
import type {CompletionTarget,EditorMode} from './course-workspace/CourseEditor';
import {CourseReader} from './course-workspace/CourseReader';
/** One continuous course projection; the mounted editor keeps history and selection across modes. */
export function GraphNotebook({markdown,mode,onChange,onSelect,onComposition,onLink,completions,offset,editorRef,api,courseId}:{api?:WorkbenchApi;courseId?:string;markdown:string;mode:EditorMode;onChange:(value:string)=>void;onSelect:(offset:number)=>void;onComposition:(active:boolean)=>void;onLink:(raw:string)=>void;completions:CompletionTarget[];offset:number;editorRef?:{current:EditorView|null}}):ReactElement{return <div className="cw-document-surface"><div hidden={mode==='reading'}><CourseEditor api={api} courseId={courseId} value={markdown} mode={mode} onChange={onChange} onSelect={onSelect} onComposition={onComposition} onLink={onLink} completions={completions} offset={offset} editorRef={editorRef}/></div>{mode==='reading'&&<CourseReader api={api} courseId={courseId} markdown={markdown} onSelect={onSelect} onLink={onLink} offset={offset}/>}</div>;}
