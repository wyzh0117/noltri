import { expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ screenshot: 'registered', openIntake: 'registered' })) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { commands } from './tauri';
it('saves structured shortcut bindings through the native command and returns status', async () => {
  const bindings = { screenshot: { key: 'Q', control: true, alt: true, shift: false, meta: false }, openIntake: { key: 'W', control: true, alt: false, shift: true, meta: false } };
  expect(await commands.saveIntakeShortcuts(bindings)).toEqual({ screenshot: 'registered', openIntake: 'registered' });
  expect(invoke).toHaveBeenLastCalledWith('save_intake_shortcuts', { bindings });
});
it('reads diagnostics through the dedicated native metadata command', async () => {
  await commands.getRuntimeDiagnostics();
  expect(invoke).toHaveBeenLastCalledWith('get_runtime_diagnostics');
});
