import {expect,it} from 'vitest';
import {parseMarkdown} from '@noltri/note-engine';
import {outlineReorder,outlineReorderPlans} from './outline-reorder';
function moved(markdown:string,from:number,direction:-1|1):string{const plan=outlineReorder(markdown,from,direction);if(!plan)return markdown;const {change}=plan;return markdown.slice(0,change.from)+change.insert+markdown.slice(change.to);}
it('moves the complete H2 section, including descendants and fenced fake headings',()=>{
 const markdown='# Course\n\n## A\n\na ^a\n\n### Child\n\n```md\n## not a section\n```\n\n## B\n\nb ^b\n\n',after=moved(markdown,markdown.indexOf('## A'),1);expect(after.indexOf('## B')).toBeLessThan(after.indexOf('## A'));expect(after).toContain('### Child\n\n```md\n## not a section\n```');expect(moved(after,after.indexOf('## A'),-1)).toBe(markdown);expect(outlineReorder(markdown,0,1)).toBeNull();
});
it('limits H3 moves to siblings in the same parent and separates an EOF section safely',()=>{
 const markdown='# Course\n\n## A\n\n### One\n\nfirst\n\n### Two\n\nsecond\n\n## B\n\n### Other\n\nlast',plans=outlineReorderPlans(markdown);expect(plans.get(markdown.indexOf('### Two'))?.down).toBeNull();expect(plans.get(markdown.indexOf('### Other'))?.up).toBeNull();const after=moved(markdown,markdown.indexOf('## A'),1);expect(after).toContain('last\n\n## A');expect(parseMarkdown(after).headings.map(h=>h.text)).toEqual(['Course','B','Other','A','One','Two']);
});
