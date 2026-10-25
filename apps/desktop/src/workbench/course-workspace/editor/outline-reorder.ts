import {parseMarkdown} from '@noltri/note-engine';
import type {Heading} from '@noltri/note-engine';
import type {DocumentChange} from '@noltri/schema';
export interface OutlineReorder {change:DocumentChange;nextOffset:number}
interface SiblingMoves {up:OutlineReorder|null;down:OutlineReorder|null}
/** Root AST headings define sections; code and quoted headings never become draggable units. */
export function outlineReorderPlans(markdown:string):Map<number,SiblingMoves>{
 const parsed=parseMarkdown(markdown,{tolerateInvalidFrontmatter:true}),roots=new Set((parsed.ast.children??[]).filter(node=>node.type==='heading').map(node=>node.position?.start.offset)),headings=parsed.headings.filter(heading=>roots.has(heading.from)),groups=new Map<string,Heading[]>(),parents:Heading[]=[],next:Heading[]=[],ends=new Map<number,number>(),result=new Map<number,SiblingMoves>();
 for(let i=headings.length-1;i>=0;i--){const heading=headings[i];while(next.length&&next.at(-1)!.depth>heading.depth)next.pop();ends.set(heading.from,next.at(-1)?.from??markdown.length);next.push(heading);}
 for(const heading of headings){while(parents.length&&parents.at(-1)!.depth>=heading.depth)parents.pop();const key=`${parents.at(-1)?.from??-1}:${heading.depth}`,siblings=groups.get(key)??[];siblings.push(heading);groups.set(key,siblings);parents.push(heading);if(heading.depth>1)result.set(heading.from,{up:null,down:null});}
 for(const siblings of groups.values())for(let i=0;i+1<siblings.length;i++){
  const first=siblings[i],second=siblings[i+1];if(first.depth===1)continue;const to=ends.get(second.from)!,a=markdown.slice(first.from,second.from),b=markdown.slice(second.from,to),separated=b.endsWith('\n\n')?b:b.endsWith('\n')?b+'\n':b+'\n\n',insert=separated+a;
  if(insert===markdown.slice(first.from,to))continue;
  const change={from:first.from,to,insert};result.get(first.from)!.down={change,nextOffset:first.from+separated.length};result.get(second.from)!.up={change,nextOffset:first.from};
 }
 return result;
}
export function outlineReorder(markdown:string,from:number,direction:-1|1):OutlineReorder|null{return outlineReorderPlans(markdown).get(from)?.[direction===-1?'up':'down']??null;}
