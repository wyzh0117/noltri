import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import type {TreeNode} from '@noltri/schema';
import {courseCatalog,courseLocation,coursePath,restoredTool,TOOL_VIEWS} from './workspace-navigation';
import {RightSidebar} from './RightSidebar';
const node=(id:string,nodeType:string,children:TreeNode[]=[]):TreeNode=>({id,title:id,nodeType,children,status:'active',confidence:null,summary:'摘要',itemCount:2,descendantItemCount:3,childCount:children.length});
it('deduplicates course cards and preserves the entering shared path',()=>{const course=node('python','topic');const catalog=courseCatalog([node('cs','discipline',[node('lang','subdiscipline',[course])]),node('math','discipline',[node('applied','subdiscipline',[course])])]);expect(catalog).toHaveLength(1);const path=coursePath(catalog[0],{kind:'course',courseId:'python',viaParentId:'applied'});expect(courseLocation(catalog[0],path)).toEqual({kind:'course',courseId:'python',disciplineId:'math',viaParentId:'applied'});expect(coursePath(catalog[0],null,'lang')[0].id).toBe('cs');});
it('uses the same tab DOM and keyboard order and defaults to properties',()=>{expect(restoredTool('invalid')).toBe('properties');expect(restoredTool('outline')).toBe('outline');const html=renderToStaticMarkup(createElement(RightSidebar,{expanded:false,graph:null,children:tool=>tool}));const ids=[...html.matchAll(/id="cw-tab-([^"]+)"/g)].map(match=>match[1]);expect(ids).toEqual([...TOOL_VIEWS]);expect(html).toContain('aria-selected="true" aria-controls="cw-panel-properties"');});
