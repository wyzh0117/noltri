import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createProcessingConsoleCommands } from '../lib/tauri';
import { ConsoleBootView, loadDesktopSession } from './processing-console-boot';
import type { ProcessingConsoleApi } from './ProcessingConsole';
const noApi: ProcessingConsoleApi={processingRules:async()=>{throw Error('synthetic no IO')},processingRecords:async()=>{throw Error('synthetic no IO')},saveProcessingRulesDraft:async()=>{throw Error('no IO')},applyProcessingRules:async()=>{throw Error('no IO')},rollbackProcessingRules:async()=>{throw Error('no IO')}};
it('uses trusted native role; main never requests console credentials',async()=>{
 const calls:string[]=[];const ipc=createProcessingConsoleCommands(async<T,>(command:string)=>{calls.push(command);return 'main' as T;});
 expect(await loadDesktopSession(true,ipc,()=>{throw Error('no console client')})).toEqual({role:'main'});
 expect(calls).toEqual(['get_native_window_role']);
});
it('console receives exactly one minimal bootstrap then builds its five-method adapter',async()=>{
 const calls:string[]=[];let endpoint:unknown;
 const ipc=createProcessingConsoleCommands(async<T,>(command:string)=>{calls.push(command);return (command==='get_native_window_role'?'processing-console':{apiBaseUrl:'http://127.0.0.1:8787',apiToken:'synthetic-token'}) as T;});
 const session=await loadDesktopSession(true,ipc,e=>{endpoint=e;return noApi;});
 expect(session).toEqual({role:'processing-console',api:noApi});expect(endpoint).toEqual({apiBaseUrl:'http://127.0.0.1:8787',apiToken:'synthetic-token'});
 expect(calls).toEqual(['get_native_window_role','get_processing_console_bootstrap']);
});
it('browser URL cannot grant native console role and unknown native role fails closed',async()=>{
 expect(await loadDesktopSession(false,{role:async()=>{throw Error('no native IPC')},bootstrap:async()=>{throw Error('no credentials')},open:async()=>{}},()=>noApi)).toEqual({role:'main'});
 await expect(loadDesktopSession(true,{role:async()=> 'spoofed' as any,bootstrap:async()=>{throw Error('no credentials')},open:async()=>{}},()=>noApi)).rejects.toThrow();
});
it('renders the console without onboarding, main workbench or connection secrets',()=>{
 const html=renderToStaticMarkup(<ConsoleBootView api={noApi}/>);
 expect(html).toContain('处理规则与记录');expect(html).not.toContain('model-onboarding');expect(html).not.toContain('synthetic-token');expect(html).not.toContain('http://127.0.0.1');
});
it('open IPC has no caller-supplied label, URL, token or reload options',async()=>{
 const calls:unknown[]=[];await createProcessingConsoleCommands(async<T,>(...args:[string,Record<string,unknown>?])=>{calls.push(args);return undefined as T;}).open();expect(calls).toEqual([['open_processing_console']]);
});
it('preserves the trusted console role without constructing an API when bootstrap fails',async()=>{
 const calls:string[]=[];let clients=0;
 const ipc=createProcessingConsoleCommands(async<T,>(command:string)=>{calls.push(command);if(command==='get_native_window_role')return 'processing-console' as T;throw Error('/private/profile secret-token');});
 await expect(loadDesktopSession(true,ipc,()=>{clients++;return noApi;})).resolves.toEqual({role:'processing-console',api:null});
 expect(clients).toBe(0);expect(calls).toEqual(['get_native_window_role','get_processing_console_bootstrap']);
});
it('renders a credential-free diagnostics fallback without rule or record actions when no Core API is available',()=>{
 const html=renderToStaticMarkup(<ConsoleBootView api={null}/>);
 expect(html).toContain('Core 服务尚未就绪');expect(html).toContain('刷新运行诊断');expect(html).toContain('运行诊断尚未读取');
 for(const hidden of ['保存草稿','应用已保存草稿','刷新处理记录','重新加载并比较','model-onboarding','synthetic-token','http://127.0.0.1'])expect(html).not.toContain(hidden);
});
