import {it,expect} from 'vitest';
import type {CourseDocument} from '@noltri/schema';
import {legacyDraftChange} from './PreservedContent';
import {locationOffset} from '../workspace-navigation';
it('maps a legacy concept draft to only its reviewed section and refuses unmapped or detached targets',()=>{
 const markdown='# Course\n\nIntro\n\n## Old\n\nSaved body\n\n## Next\n\nKeep';
 const document={courseId:'course',markdown,chapters:[{id:'instance',conceptId:'concept',detached:false}],entries:[],projection:[{kind:'title',from:0,to:8,entryId:null,courseChapterId:null},{kind:'chapter',from:markdown.indexOf('## Old'),to:markdown.indexOf('## Old')+6,entryId:null,courseChapterId:'instance'},{kind:'chapter',from:markdown.indexOf('## Next'),to:markdown.indexOf('## Next')+7,entryId:null,courseChapterId:'next'}]} as unknown as CourseDocument;
 const draft={topicId:'course',chapterId:'concept',content:'New draft',updatedAt:'now'},change=legacyDraftChange(document,draft),updated=markdown.slice(0,change.from)+change.insert+markdown.slice(change.to);
 expect(updated).toContain('Intro');expect(updated).toContain('New draft');expect(updated).toContain('## Next\n\nKeep');expect(updated).not.toContain('Saved body');
 expect(()=>legacyDraftChange(document,{...draft,topicId:'other'})).toThrow();expect(()=>legacyDraftChange(document,{...draft,chapterId:'missing'})).toThrow();
 document.chapters[0].detached=true;expect(()=>legacyDraftChange(document,draft)).toThrow();
 expect(locationOffset(document,{kind:'entry',courseId:'course',courseChapterId:'instance',entryId:'detached'})).toBeNull();
 expect(locationOffset(document,{kind:'chapter',courseId:'course',courseChapterId:'detached'})).toBeNull();
});
