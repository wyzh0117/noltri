import {it,expect} from 'vitest';
import {attachmentReference} from '../src/links';
it('canonicalizes only safe registered-resource spellings and preserves fragments',()=>{
 expect(attachmentReference('./attachments/id/%E5%9B%BE.png#page=2')).toEqual({path:'attachments/id/图.png',fragment:'#page=2'});
 for(const path of ['../attachments/id/a','attachments/../a','./attachments/%2e%2e/a','https://example.test/attachments/id/a','//attachments/id/a','attachments/id/%252e%252e','attachments\\id\\a','attachments/id/a%3Fdownload=1'])expect(attachmentReference(path)).toBeNull();
});
