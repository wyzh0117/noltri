import {useEffect,useState,useRef} from 'react';
import type {ReactElement} from 'react';
import type {LibraryItem} from '@noltri/schema';
import type {WorkbenchApi} from '../../api';
import {describeError} from '../../api';
import {ItemDetailDialog,CompareDialog,toggleComparedItems} from '../../WorkbenchApp';
import type {CategoryPath} from '../../WorkbenchApp';
import {IconButton} from '../ui/Icon';
/** Existing source inspection and research comparison stay behind the capture inbox. */
export function MaterialsInbox({api,paths,onClose,onUpdated}:{api:WorkbenchApi;paths:CategoryPath[];onClose:()=>void;onUpdated:()=>void}):ReactElement{
 const [items,setItems]=useState<LibraryItem[]>([]),[state,setState]=useState<'organize'|'all'|'archive'>('organize'),[selected,setSelected]=useState<LibraryItem|null>(null),[compared,setCompared]=useState<LibraryItem[]>([]),[compare,setCompare]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0),loading=useRef(false),nextOffset=useRef(0),[hasMore,setHasMore]=useState(false),[loadingPage,setLoadingPage]=useState(false);
 async function loadPage(reset=false){
  const token=reset?++generation.current:generation.current;if(!reset&&loading.current)return;
  const offset=reset?0:nextOffset.current;loading.current=true;setLoadingPage(true);setError('');
  if(reset){setItems([]);setHasMore(false);nextOffset.current=0;}
  try{const result=await api.listItems({state,limit:200,offset});if(token!==generation.current)return;setItems(old=>reset?result.items:[...old,...result.items.filter(item=>!old.some(existing=>existing.id===item.id))]);nextOffset.current=offset+result.items.length;setHasMore(result.items.length===200);}
  catch(e){if(token===generation.current)setError(describeError(e));}
  finally{if(token===generation.current){loading.current=false;setLoadingPage(false);}}
 }
 useEffect(()=>{void loadPage(true);return()=>{generation.current++;loading.current=false;};},[api,state]);
 const update=(item:LibraryItem)=>{setSelected(item);setItems(old=>old.map(i=>i.id===item.id?item:i));setCompared(old=>old.map(i=>i.id===item.id?item:i));onUpdated();};
 if(compare)return <CompareDialog items={compared} onClose={()=>setCompare(false)}/>;
 if(selected)return <ItemDetailDialog api={api} item={selected} items={items} paths={paths} compareSelected={compared.some(i=>i.id===selected.id)} busy={busy} onClose={()=>setSelected(null)} onCompare={()=>setCompared(old=>toggleComparedItems(old,selected))} onUpdated={update} onArchive={()=>{setBusy(true);void api.archiveItem(selected.id).then(r=>update(r.item)).catch(e=>setError(describeError(e))).finally(()=>setBusy(false));}} onRestore={()=>{setBusy(true);void api.restoreItem(selected.id).then(r=>update(r.item)).catch(e=>setError(describeError(e))).finally(()=>setBusy(false));}} onError={setError}/>;
 return <section className="dialog-content"><header className="cw-panel-heading"><h2>收集箱</h2><IconButton icon="close" label="关闭收集箱" onClick={onClose}/></header><div className="cw-actions">{(['organize','all','archive'] as const).map(view=><button key={view} aria-pressed={state===view} onClick={()=>setState(view)}>{view==='organize'?'待整理':view==='all'?'全部输入':'已归档'}</button>)}<button disabled={compared.length!==2} onClick={()=>setCompare(true)}>并排研究比较（{compared.length}/2）</button></div>{error&&<p className="cw-error" role="alert">{error}<button type="button" disabled={loadingPage} onClick={()=>void loadPage(nextOffset.current===0)}>重试读取</button></p>}{items.length?items.map(item=><article className="cw-inbox-item" key={item.id}><button className="cw-inbox-open" onClick={()=>setSelected(item)}>{item.source.title||item.content.slice(0,60)}</button><p>{item.content}</p><small>{item.subjectPath.join(' / ')} · {item.aiStatus}</small><button onClick={()=>setCompared(old=>toggleComparedItems(old,item))}>{compared.some(i=>i.id===item.id)?'取消比较':'加入比较'}</button></article>):<p>暂无资料。</p>}{(hasMore||loadingPage)&&<button type="button" disabled={loadingPage} onClick={()=>void loadPage()}>{loadingPage?'正在读取…':'加载更多资料'}</button>}</section>;
}
