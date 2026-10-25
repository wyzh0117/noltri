import {expect,it} from 'vitest';
import {locationOffset} from '../workspace-navigation';
import {linkedMarkdown} from './linked-content';
import type {CourseDocument} from '@noltri/schema';
const markdown='# Python\n\n## 变量\n\n### 动态类型\n\n对象具有类型。\n\n### 赋值\n\n改变绑定。';
const entry='### 动态类型\n\n对象具有类型。\n\n### 赋值\n\n改变绑定。';
const document={courseId:'python',title:'Python',markdown,projection:[{kind:'entry',from:markdown.indexOf(entry),to:markdown.length,entryId:'entry',courseChapterId:'chapter',revision:1}],entries:[{id:'entry',markdown:entry,blocks:[{id:'stable',alias:'block',from:entry.indexOf('对象'),to:entry.indexOf('对象')+7}]}]} as CourseDocument;
it('locates explicit entry headings and stable internal blocks precisely',()=>{expect(locationOffset(document,{kind:'entry',courseId:'python',courseChapterId:'chapter',entryId:'entry',headingPath:['赋值']})).toBe(markdown.indexOf('### 赋值'));expect(locationOffset(document,{kind:'entry',courseId:'python',courseChapterId:'chapter',entryId:'entry',blockId:'stable'})).toBe(markdown.indexOf('对象'));expect(linkedMarkdown(document,{kind:'entry',courseId:'python',entryId:'entry',headingPath:['动态类型']})).toContain('对象具有类型');expect(linkedMarkdown(document,{kind:'entry',courseId:'python',entryId:'entry',headingPath:['动态类型']})).not.toContain('改变绑定');});
