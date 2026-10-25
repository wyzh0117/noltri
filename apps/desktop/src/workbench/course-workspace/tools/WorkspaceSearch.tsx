import {useEffect,useRef,useState} from 'react';
import type {ReactElement} from 'react';
import type {WorkspaceSearchResponse} from '@noltri/schema';
import type {WorkbenchApi} from '../../api';
import {describeError} from '../../api';
import type {NavigateTo} from '../workspace-navigation';
import {Icon} from '../ui/Icon';
export function WorkspaceSearch({api,query,onQuery,navigate}:{api:WorkbenchApi;query:string;onQuery:(q:string)=>void;navigate:NavigateTo}):ReactElement{
 const generation=useRef(0);
 const [result,setResult]=useState<WorkspaceSearchResponse|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false);
 useEffect(()=>{const id=++generation.current;const controller=new AbortController();setLoading(false);setResult(null);setError(null);if(!query.trim())return;const timer=setTimeout(()=>{setLoading(true);void api.searchKnowledge(query,undefined,{signal:controller.signal,limit:60}).then(next=>{if(!controller.signal.aborted)setResult(next);}).catch(e=>{if(!controller.signal.aborted)setError(describeError(e));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});},180);return()=>{clearTimeout(timer);controller.abort();};},[api,query]);
 return <div className="cw-search-panel"><label className="cw-search-field"><Icon name="search"/><input type="search" autoFocus aria-label="搜索全部课程" placeholder="搜索课程、正文或 tag:标签" value={query} onChange={e=>onQuery(e.target.value)}/></label>{loading&&<p className="cw-muted">正在搜索…</p>}{error&&<p className="cw-error" role="alert">{error}</p>}{result&&<small className="cw-search-count">{result.hits.length} 个结果</small>}<div className="cw-search-results">{result?.hits.map(hit=><button type="button" key={hit.id} onClick={()=>void navigate(hit.location,{origin:'search'})}><strong>{hit.title}</strong><span>{hit.snippet}</span><small>{[...new Set(hit.matches.map(m=>m.field))].join(' · ')}</small></button>)}</div>{result?.cursor&&<button type="button" onClick={()=>{const id=generation.current;setLoading(true);void api.searchKnowledge(query,result.cursor,{limit:60}).then(next=>{if(id===generation.current)setResult({...next,hits:[...result.hits,...next.hits]});}).catch(e=>{if(id===generation.current)setError(describeError(e));}).finally(()=>{if(id===generation.current)setLoading(false);});}}>加载更多</button>}{!query&&<p className="cw-muted">支持短语、OR、tag:、path: 和属性查询。</p>}</div>;
}
