import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NativeUpdatePanel, runNativeUpdateAction } from './NativeUpdatePanel';
import { createNativeUpdateCommands } from '../lib/tauri';

it('requires application safety guards before installation and restart', async () => {
  const calls: string[] = [];
  const api = createNativeUpdateCommands(async <T,>(command: string) => { calls.push(command); return { status: 'installed' } as T; });
  await expect(runNativeUpdateAction(api, 'install', async () => false)).rejects.toThrow('请先保存草稿并等待任务完成');
  await expect(runNativeUpdateAction(api, 'restart', async () => false)).rejects.toThrow();
  expect(calls).toEqual([]);
});
it('uses separate explicit IPC actions with fixed confirmation and no frontend policy overrides', async () => {
  const calls: unknown[] = [];
  const api = createNativeUpdateCommands(async <T,>(command: string, args?: Record<string, unknown>) => { calls.push([command, args]); return {status:'downloaded'} as T; });
  await api.check(); await api.download(); await runNativeUpdateAction(api,'install',()=>true); await runNativeUpdateAction(api,'restart',()=>true);
  expect(calls).toEqual([['check_native_update',undefined],['download_native_update',undefined],['install_native_update',{confirmed:true}],['restart_after_native_update',{confirmed:true}]]);
});
it('renders manual controls and replacement warning without checking updates on mount', () => {
  const api=createNativeUpdateCommands(async()=>{ throw Error('no startup IPC'); });
  const html=renderToStaticMarkup(<NativeUpdatePanel api={api} beforeInstall={()=>false} beforeRestart={()=>false}/>);
  expect(html).toContain('检查更新'); expect(html).toContain('替换'); expect(html).toContain('退出');
});
