import type {DocumentChange} from '@noltri/schema';
/** One minimal replacement, expressed in the server projection's UTF-16 coordinates. */
export function documentChanges(before:string,after:string):DocumentChange[]{
 if(before===after)return [];let from=0;while(from<before.length&&from<after.length&&before[from]===after[from])from++;
 if(from>0&&/[\uD800-\uDBFF]/.test(before[from-1]))from--;
 let end=before.length,afterEnd=after.length;while(end>from&&afterEnd>from&&before[end-1]===after[afterEnd-1]){end--;afterEnd--;}
 if(end<before.length&&/[\uDC00-\uDFFF]/.test(before[end])){end++;afterEnd++;}
 return [{from,to:end,insert:after.slice(from,afterEnd)}];
}
