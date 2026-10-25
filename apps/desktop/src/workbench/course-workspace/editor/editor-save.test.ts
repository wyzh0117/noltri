import {expect,it} from 'vitest';
import {documentChanges} from './document-changes';
function apply(before:string,after:string):string {return documentChanges(before,after).reduceRight((text,c)=>text.slice(0,c.from)+c.insert+text.slice(c.to),before);}
it('sends a minimal UTF-16 replacement without cutting surrogate pairs',()=>{for(const [before,after] of [['甲😀乙','甲😃乙'],['# Python\n\n## 变量\n\nabc','# Python\n\n## 类型\n\nabZc'],['甲😀乙','甲乙'],['','## 变量\n\n原创'],['same','same']])expect(apply(before,after)).toBe(after);expect(documentChanges('甲😀乙','甲😃乙')).toEqual([{from:1,to:3,insert:'😃'}]);expect(documentChanges('abc','abc')).toEqual([]);});
