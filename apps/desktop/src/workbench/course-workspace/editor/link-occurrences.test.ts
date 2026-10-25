import {expect,it} from 'vitest';
import {parseMarkdown} from '@noltri/note-engine';
import type {CourseDocument} from '@noltri/schema';
import {documentReference,referenceInput,referenceTarget,savedReferenceOffset} from './link-occurrences';
import {renderMarkdown} from './markdown-renderer';
it('renders a distinct exact UTF-16 source offset for identical wiki and relative links',()=>{
 const markdown='前缀\\* [[Python]] 与 [[Python]]。\n\n[相同](Python.md) [相同](Python.md)',base=47,html=renderMarkdown(markdown,base),offsets=[...html.matchAll(/data-reference-from="(\d+)"/g)].map(match=>Number(match[1]));
 expect(offsets).toEqual(parseMarkdown(markdown).links.map(link=>base+link.from));expect(new Set(offsets).size).toBe(4);expect(html).toContain('#knowledge:'+encodeURIComponent('[相同](Python.md)'));
});
it('retains the clicked occurrence through normalization without selecting the first identical link',()=>{
 const before='# A\n\n[[T]] [[T]] [[T]]',after='# A\n\n\n[[T]] [[T]] [[T]]\n\n',from=before.lastIndexOf('[[T]]');expect(savedReferenceOffset(before,after,from)).toBe(after.lastIndexOf('[[T]]'));expect(()=>savedReferenceOffset(before,'[[T]] '+after,from)).toThrow('位置发生变化');
 const document={courseId:'course',projection:[{kind:'entry',from:20,to:80,entryId:'second',courseChapterId:'chapter'}]} as CourseDocument;expect(documentReference(document,37)).toEqual({courseId:'course',documentFrom:37,entryId:'second',courseChapterId:'chapter',referenceFrom:17});
});
it('keeps full occurrence syntax for resolved bindings and controlled resource paths',()=>{expect(referenceInput('![[Python#变量]]')).toBe('![[Python#变量]]');expect(referenceInput('[显示](Python.md)')).toBe('[显示](Python.md)');expect(referenceTarget('![[attachments/id/图片.png|图]]')).toBe('attachments/id/图片.png');});
