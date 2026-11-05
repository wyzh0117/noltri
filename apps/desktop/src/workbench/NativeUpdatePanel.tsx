import { useRef, useState } from 'react';
import { createNativeUpdateCommands, type NativeUpdateCommands, type NativeUpdateStatus } from '../lib/tauri';
import './NativeUpdatePanel.css';
type Guard = () => boolean | Promise<boolean>;
type Action = 'check' | 'download' | 'install' | 'restart';
class ApplicationUpdatePreflightError extends Error {
  constructor(readonly code: 'update_application_preflight_blocked' | 'update_application_preflight_failed') {
    super('请先保存草稿并等待任务完成');
  }
}
export async function runNativeUpdateAction(api: NativeUpdateCommands, action: Action, guard: Guard): Promise<NativeUpdateStatus | void> {
  if (action === 'install' || action === 'restart') {
    let safe: boolean;
    try { safe = await guard(); } catch { throw new ApplicationUpdatePreflightError('update_application_preflight_failed'); }
    if (!safe) throw new ApplicationUpdatePreflightError('update_application_preflight_blocked');
  }
  return api[action]();
}
// Never display a native error verbatim: only exact, allowlisted codes cross this boundary.
function failureMessage(action: Action, failure: unknown): string {
  const code = failure instanceof ApplicationUpdatePreflightError ? failure.code : typeof failure === 'string' ? failure : failure instanceof Error ? failure.message : undefined;
  if (action === 'download') {
    switch (code) {
      case 'update_signature_invalid': return '更新包签名校验未通过，已拒绝安装。';
      case 'update_signed_version_mismatch': return '更新包的签名版本与更新清单不一致，已拒绝安装。';
      case 'update_signed_version_missing': return '更新包签名中缺少版本信息，已拒绝安装。';
      case 'update_signature_metadata_invalid': return '更新包签名信息无效，已拒绝安装。';
      case 'update_download_http_failed': return '下载服务器拒绝了更新包请求，尚未完成校验。';
      case 'update_download_network_failed': return '更新包的网络连接失败，尚未完成校验。';
      case 'update_download_stream_failed': return '更新包下载中断，尚未完成校验。';
      case 'update_download_timeout': return '更新包下载超时，尚未完成校验。';
      default: return '下载或校验未完成，原因未确定。';
    }
  }
  if (action === 'install') {
    switch (code) {
      case 'update_application_preflight_blocked': return '安装前检查未通过，本次未调用安装器。请先保存草稿并等待任务完成。';
      case 'update_application_preflight_failed': return '安装前检查未完成，本次未调用安装器。请先检查本机服务与任务状态。';
      case 'save_and_close_processing_console_first': return '请先保存并关闭规则与处理记录窗口，本次未调用安装器。';
      case 'main_window_required': return '请在主窗口明确确认安装，本次未调用安装器。';
      case 'explicit_confirmation_required': return '安装需要明确确认，本次未调用安装器。';
      case 'update_busy': return '更新任务仍在进行，本次未调用安装器。';
      case 'invalid_update_state': return '当前更新状态不允许安装，本次未调用安装器。';
      case 'missing_update': return '缺少已检查的更新信息，本次未调用安装器。';
      case 'missing_verified_download': return '缺少已验证的更新包，本次未调用安装器。';
      case 'update_install_permission_denied': return '安装遇到文件权限错误，请先人工检查应用状态。';
      case 'update_install_read_only': return '安装遇到只读文件系统错误，请先人工检查应用状态。';
      case 'update_install_disk_full': return '安装遇到存储空间错误，请先人工检查应用状态。';
      case 'update_install_missing_file': return '安装遇到文件缺失错误，请先人工检查应用状态。';
      case 'update_install_cross_device': return '安装遇到跨文件系统操作错误，请先人工检查应用状态。';
      case 'update_install_invalid_data': return '安装遇到数据格式错误，请先人工检查应用状态。';
      case 'update_install_wrong_volume': return '安装临时目录的文件系统不匹配，请先人工检查应用状态。';
      case 'update_install_backup_preserved': return '旧应用未能自动恢复，请先人工检查保留的备份和应用状态。';
      case 'update_install_failed_manual_recovery_required': return '更新包安装失败，请先人工检查应用状态，再决定如何恢复。';
      case 'update_install_outcome_uncertain': return '更新包安装结果未确定，请先人工检查应用状态，再决定如何恢复。';
      default: return '安装未完成或被安全检查阻止。如安装已开始，请先人工检查应用状态。';
    }
  }
  if (action === 'restart') return '重启被阻止，请先保存草稿并等待任务完成。';
  return '检查更新未完成，原因未确定。';
}
const nativeApi = createNativeUpdateCommands();
export function NativeUpdatePanel({ api = nativeApi, beforeInstall, beforeRestart, onBusyChange }: { api?: NativeUpdateCommands; beforeInstall: Guard; beforeRestart: Guard; onBusyChange?: (busy: boolean) => void }) {
  const [result,setResult]=useState<NativeUpdateStatus>();
  const [busy,setBusy]=useState(false); const lock=useRef(false);
  const [message,setMessage]=useState('仅在你点击时检查更新。');
  async function act(action:Action) {
    if(lock.current)return; lock.current=true;setBusy(true);onBusyChange?.(true);
    try {
      const next=await runNativeUpdateAction(api,action,action==='restart'?beforeRestart:beforeInstall);
      if(next)setResult(next);
      setMessage(action==='check'?(next?.status==='available'?'发现新版本。':'当前没有可用更新。'):action==='download'?'下载与签名校验完成；尚未安装。':action==='install'?'安装完成，重启后生效。':'正在重启。');
    } catch (failure) {
      setMessage(failureMessage(action, failure));
      // Do not offer an install retry after an uncertain native outcome.
      if(action==='install')setResult(undefined);
    } finally {lock.current=false;setBusy(false);onBusyChange?.(false);}
  }
  return <section className="native-update-panel" aria-label="应用更新">
    <h3>应用更新</h3>
    <p>更新包使用知序的更新签名校验。安装会替换当前应用，部分平台会退出应用；请先保存所有草稿并等待任务完成。</p>
    {result?.version&&<p>版本：{result.version}</p>}
    {result?.notes&&<pre>{result.notes}</pre>}
    <p role="status" aria-live="polite">{busy?'正在处理更新…':message}</p>
    <div>
      <button disabled={busy||result?.status==='installed'} onClick={()=>void act('check')}>检查更新</button>
      {result?.status==='available'&&<button disabled={busy} onClick={()=>void act('download')}>下载并验证</button>}
      {result?.status==='downloaded'&&<button disabled={busy} onClick={()=>void act('install')}>确认安装并替换应用</button>}
      {result?.status==='installed'&&<button disabled={busy} onClick={()=>void act('restart')}>确认重启应用</button>}
    </div>
  </section>;
}
