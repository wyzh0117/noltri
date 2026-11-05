import type { ShortcutBinding, ShortcutBindings } from '../lib/tauri';

export const DEFAULT_SHORTCUT_BINDINGS: ShortcutBindings = {
  screenshot: { key: 'S', control: true, alt: true, shift: false, meta: true },
  openIntake: { key: 'V', control: true, alt: true, shift: false, meta: true },
};

export function validShortcutBindings(value: unknown): value is ShortcutBindings {
  if (!value || typeof value !== 'object') return false;
  const bindings = value as ShortcutBindings;
  return [bindings.screenshot, bindings.openIntake].every(binding => binding && /^[A-Z]$/.test(binding.key)
    && [binding.control, binding.alt, binding.shift, binding.meta].every(modifier => typeof modifier === 'boolean'));
}

export function formatShortcutBinding(binding: ShortcutBinding): string {
  return `${binding.control ? '⌃' : ''}${binding.alt ? '⌥' : ''}${binding.shift ? '⇧' : ''}${binding.meta ? '⌘' : ''}${/^[A-Z]$/.test(binding.key) ? binding.key : '?'}`;
}

export function shortcutValidation(bindings: ShortcutBindings): string | null {
  if (!validShortcutBindings(bindings)) return '请选择 A–Z 字母。';
  if ([bindings.screenshot, bindings.openIntake].some(binding => [binding.control, binding.alt, binding.shift, binding.meta].filter(Boolean).length < 2)) return '每个快捷键至少选择两个修饰键。';
  if (formatShortcutBinding(bindings.screenshot) === formatShortcutBinding(bindings.openIntake)) return '两个快捷键不能相同。';
  return null;
}

export function shortcutErrorMessage(error: unknown): string {
  const code = typeof error === 'string' ? error : error && typeof error === 'object' && 'code' in error ? error.code : null;
  switch (code) {
    case 'shortcut_invalid_binding': return '快捷键格式无效，请选择字母和至少两个修饰键。';
    case 'shortcut_duplicate_bindings': return '两个快捷键不能相同。';
    case 'shortcut_conflict': return '快捷键冲突，请调整组合后重新保存。当前快捷键保持不变。';
    case 'shortcut_unavailable': return '全局快捷键暂不可用，请使用窗口按钮并稍后重试。';
    case 'shortcut_persistence_failed': return '快捷键配置无法保存，请稍后重试。';
    case 'shortcut_configuration_invalid': return '已保存的快捷键配置无效，请明确选择组合后保存。';
    case 'shortcut_cleanup_pending': return '新快捷键已保存；旧快捷键清理尚未确认，请重新注册当前快捷键。';
    case 'shortcut_main_thread_unavailable':
    case 'shortcut_state_unavailable': return '无法确认快捷键状态，请稍后重新读取或重试。';
    default: return '快捷键未能保存，请重新读取状态或明确重试。';
  }
}
