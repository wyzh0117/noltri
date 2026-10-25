import {documentChanges} from './editor/document-changes';
import {createRoot} from 'react-dom/client';
import {CourseReader} from './CourseReader';
import {useEffect,useLayoutEffect,useRef} from 'react';
import type {ReactElement} from 'react';
import {Compartment,EditorState,StateEffect,StateField,Facet,Transaction} from '@codemirror/state';
import {Decoration,EditorView,WidgetType,keymap,drawSelection,highlightActiveLine} from '@codemirror/view';
import type {DecorationSet} from '@codemirror/view';
import {defaultKeymap,history,historyKeymap} from '@codemirror/commands';
import {markdown} from '@codemirror/lang-markdown';
import {syntaxHighlighting,defaultHighlightStyle,syntaxTree} from '@codemirror/language';
import {autocompletion,completionKeymap} from '@codemirror/autocomplete';
import type {CompletionContext} from '@codemirror/autocomplete';
import {parseMarkdown} from '@noltri/note-engine';
import type {WorkbenchApi} from '../api';
import type {OpenKnowledgeLink} from './editor/link-occurrences';
import {renderControlledResources} from './editor/controlled-resources';
import {renderMarkdown,renderStaticDiagrams} from './editor/markdown-renderer';
export type EditorMode='live'|'source'|'reading';
export interface CompletionTarget {label:string;detail:string;insert:string}
interface PreviewContext {api?:WorkbenchApi;courseId?:string;onLink?:OpenKnowledgeLink;onSelect?:(from:number)=>void}
const resourceContext=Facet.define<PreviewContext,PreviewContext>({combine:values=>values[0]??{}});
class Preview extends WidgetType{private cleanup=()=>{};constructor(readonly source:string,readonly from:number,readonly context:PreviewContext){super();}override eq(other:Preview){return other.source===this.source&&other.from===this.from;}toDOM(){const element=document.createElement('div');element.className='cw-live-widget cw-prose';element.dataset.offset=String(this.from);if(this.source.includes('![[')&&this.context.api&&this.context.courseId){const root=createRoot(element);root.render(<CourseReader documentOffset={this.from} markdown={this.source} api={this.context.api} courseId={this.context.courseId} onSelect={()=>this.context.onSelect?.(this.from)} onLink={(raw,occurrence)=>this.context.onLink?.(raw,occurrence)}/>);element.classList.add('cw-live-embed');this.cleanup=()=>queueMicrotask(()=>root.unmount());return element;}element.innerHTML=renderMarkdown(this.source,this.from);queueMicrotask(()=>{void renderStaticDiagrams(element);if(this.context.api&&this.context.courseId)void renderControlledResources(element,this.context.api,this.context.courseId).then(cleanup=>{if(element.isConnected)this.cleanup=cleanup;else cleanup();}).catch(()=>{});});return element;}override ignoreEvent(){return false;}override destroy(){this.cleanup();}}
const focusEffect=StateEffect.define<boolean>();
const focusField=StateField.define<boolean>({create:()=>false,update(value,tr){for(const effect of tr.effects)if(effect.is(focusEffect))return effect.value;return value;}});
export function liveDecorations(state:EditorState,selected=state.field(focusField,false)?state.selection.ranges:[]):DecorationSet{
 const ranges:ReturnType<ReturnType<typeof Decoration.mark>['range']>[]=[];
 // CM's incremental syntax tree supplies presentation blocks; authoritative links stay in Core.
 for(let node=syntaxTree(state).topNode.firstChild;node;node=node.nextSibling){
  const {from,to}=node,next=node.nextSibling?.from??state.doc.length,end=/^\s*$/.test(state.doc.sliceString(to,next))?Math.max(to,next-1):to;
  if(to<=from||selected.some(s=>s.from<=(node.nextSibling?end:state.doc.length)&&s.to>=from))continue;
  if(/^(?:ATXHeading[1-6]|SetextHeading[12]|Paragraph|Table|Blockquote|FencedCode|CodeBlock|BulletList|OrderedList|HorizontalRule|HTMLBlock)$/.test(node.name)){
   ranges.push(Decoration.replace({widget:new Preview(state.doc.sliceString(from,to),from,state.facet(resourceContext)),block:true}).range(from,end));
  }
 }
 syntaxTree(state).iterate({enter(node){if(/^ATXHeading[1-6]$/.test(node.name)&&selected.some(s=>s.from<=node.to&&s.to>=node.from)){const depth=Number(node.name.at(-1));ranges.push(Decoration.line({class:'cw-heading-'+depth}).range(state.doc.lineAt(node.from).from));}}});
 return Decoration.set(ranges,true);
}
const live=StateField.define<DecorationSet>({create:liveDecorations,update(value,tr){return tr.docChanged||tr.selection||syntaxTree(tr.state)!==syntaxTree(tr.startState)||tr.effects.some(e=>e.is(focusEffect))?liveDecorations(tr.state):value;},provide:field=>EditorView.decorations.from(field)});
export function CourseEditor({value,mode,onChange,onSelect,onComposition,onLink,completions,offset,editorRef,api,courseId}:{api?:WorkbenchApi;courseId?:string;value:string;mode:EditorMode;onChange:(value:string)=>void;onSelect:(offset:number)=>void;onComposition:(active:boolean)=>void;onLink:OpenKnowledgeLink;completions:CompletionTarget[];offset:number;editorRef?:{current:EditorView|null}}):ReactElement{
 const container=useRef<HTMLDivElement>(null),view=useRef<EditorView|null>(null),compartment=useRef(new Compartment()),callbacks=useRef({onChange,onSelect,onComposition,onLink,completions});callbacks.current={onChange,onSelect,onComposition,onLink,completions};
 useEffect(()=>{if(!container.current)return;function complete(context:CompletionContext){const word=context.matchBefore(/\[\[[^\]\n]*/);if(!word)return null;return {from:word.from+2,options:callbacks.current.completions.map(c=>({label:c.label,detail:c.detail,apply:c.insert+']]',type:'text'})),validFor:/[^\]\n]*/};}
 const editor=new EditorView({parent:container.current,state:EditorState.create({doc:value,extensions:[resourceContext.of({api,courseId,onLink:(raw,occurrence)=>callbacks.current.onLink(raw,occurrence),onSelect:from=>callbacks.current.onSelect(from)}),focusField,markdown(),history(),drawSelection(),highlightActiveLine(),EditorView.lineWrapping,syntaxHighlighting(defaultHighlightStyle),keymap.of([...completionKeymap,...defaultKeymap,...historyKeymap]),autocompletion({override:[complete]}),compartment.current.of(mode==='live'?[live]:[]),EditorView.updateListener.of(update=>{if(update.docChanged)callbacks.current.onChange(update.state.doc.toString());if(update.selectionSet||update.docChanged)callbacks.current.onSelect(update.state.selection.main.head);}),EditorView.domEventHandlers({focus(_event,editor){editor.dispatch({effects:focusEffect.of(true)});},blur(_event,editor){editor.dispatch({effects:focusEffect.of(false)});},compositionstart(){callbacks.current.onComposition(true);},compositionend(){callbacks.current.onComposition(false);},click(event,editor){const anchor=(event.target as HTMLElement).closest('a');if(anchor?.getAttribute('href')?.startsWith('#knowledge:')||anchor?.getAttribute('href')?.startsWith('#embed:')){event.preventDefault();callbacks.current.onLink(decodeURIComponent(anchor.getAttribute('href')!.slice(anchor.getAttribute('href')!.startsWith('#knowledge:')?11:7)),Number.isFinite(Number(anchor.dataset.referenceFrom))?{courseId,documentFrom:Number(anchor.dataset.referenceFrom)}:{courseId});return true;}const widget=(event.target as HTMLElement).closest<HTMLElement>('.cw-live-widget');if(widget?.dataset.offset){const at=Number(widget.dataset.offset);callbacks.current.onSelect(at);editor.dispatch({selection:{anchor:at}});return true;}if(event.metaKey||event.ctrlKey){const pos=editor.posAtCoords({x:event.clientX,y:event.clientY});if(pos!==null){const link=parseMarkdown(editor.state.doc.toString()).links.find(l=>pos>=l.from&&pos<=l.to);if(link){callbacks.current.onLink(link.raw,{courseId,documentFrom:link.from});return true;}}}return false;}})]})});view.current=editor;if(editorRef)editorRef.current=editor;return()=>{editor.destroy();view.current=null;if(editorRef)editorRef.current=null;};},[]);
 // Reconcile before another input can arrive; a passive effect can erase newer typing.
 useLayoutEffect(()=>{const editor=view.current;if(editor&&value!==editor.state.doc.toString()&&!editor.composing){editor.dispatch({changes:documentChanges(editor.state.doc.toString(),value),annotations:Transaction.addToHistory.of(false)});}},[value]);
 useEffect(()=>{view.current?.dispatch({effects:compartment.current.reconfigure(mode==='live'?[live]:[])});},[mode]);
 useEffect(()=>{const editor=view.current;if(editor){const at=Math.min(offset,editor.state.doc.length);editor.dispatch({selection:{anchor:at},effects:EditorView.scrollIntoView(at,{y:'start'})});}},[offset]);
 return <div ref={container} className={'cw-editor cw-mode-'+mode} aria-label="课程编辑器"/>;
}
