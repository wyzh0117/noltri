import {expect,it} from 'vitest';
import {sourceIds} from './panels/SourceProperties';
import {tagCounts} from './panels/WorkspaceTools';
import {renderMarkdown} from './editor/markdown-renderer';
import type {CourseDocument,WorkspaceMetadata} from '@noltri/schema';
it('counts independent source identities across a chapter and entry',()=>{const document={sourceLinks:[{entryId:'a',sourceId:'one'},{entryId:'b',sourceId:'one'},{entryId:'a',sourceId:'two'}]} as CourseDocument;expect(sourceIds(document,['a','b'])).toEqual(['one','two']);expect(sourceIds(document,['b'])).toEqual(['one']);expect(sourceIds(document,[])).toEqual([]);});
it('deduplicates owner tags and nested parents rather than adding child counts',()=>{const objects=[{id:'a',tags:['编程/变量','编程/类型'],properties:{tags:['编程/变量']}},{id:'b',tags:['编程/变量']} ] as WorkspaceMetadata['objects'];expect(Object.fromEntries(tagCounts(objects))).toEqual({'编程':2,'编程/变量':2,'编程/类型':1});});
it('sanitizes imported HTML, event handlers, scripts and unsafe protocols',()=>{const html=renderMarkdown('<script>window.pwned=true</script>\n\n<img src="file:///etc/passwd" onerror="alert(1)">\n\n<a href="javascript:alert(1)">unsafe</a>\n\n**safe**\n\n[[C++#变量|变量]]');expect(html).not.toMatch(/<script|onerror|file:|javascript:/i);expect(html).toContain('<strong>safe</strong>');expect(html).toContain('#knowledge:C%2B%2B%23');});

it('renders a safe callout title without leaving the authoring marker in reading output',()=>{const html=renderMarkdown('> [!NOTE] 提示\n> 正文内容');expect(html).toContain('cw-callout');expect(html).toContain('<strong>提示</strong>');expect(html).not.toContain('[!NOTE]');});
