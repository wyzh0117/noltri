import {history,undo} from '@codemirror/commands';
import {documentChanges} from './document-changes';
import {it,expect} from 'vitest';
import {EditorState,Transaction} from '@codemirror/state';
import {markdown} from '@codemirror/lang-markdown';
import {liveDecorations} from '../CourseEditor';
it('keeps the active paragraph in source through trailing whitespace and document end',()=>{
 for(const text of ['A paragraph with **formatting** ', 'A paragraph\n\n']){
  const state=EditorState.create({doc:text,selection:{anchor:text.length},extensions:[markdown()]});
  expect(liveDecorations(state,state.selection.ranges).size).toBe(0);
  expect(liveDecorations(state,[]).size).toBe(1);
 }
 const text='Earlier paragraph\n\n## Next';const state=EditorState.create({doc:text,selection:{anchor:text.length},extensions:[markdown()]});
 const decorations=liveDecorations(state,state.selection.ranges),ranges:number[]=[];decorations.between(0,text.length,(from,to)=>{if(to>from)ranges.push(from);});expect(ranges).toEqual([0]);
});

it('preserves typing undo through the accepted projection adding separator newlines',()=>{
 let state=EditorState.create({doc:'# Course\n\noriginal\n\n',extensions:[history()]});
 state=state.update({changes:{from:state.doc.length,insert:'typed text'}}).state;
 state=state.update({changes:documentChanges(state.doc.toString(),state.doc.toString()+'\n\n'),annotations:Transaction.addToHistory.of(false)}).state;
 expect(undo({state,dispatch:tr=>{state=tr.state;}})).toBe(true);expect(state.doc.toString()).not.toContain('typed text');expect(state.doc.toString()).toContain('original');
});
