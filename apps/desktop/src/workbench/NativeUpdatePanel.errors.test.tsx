import { afterAll, beforeAll, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createReviewBrowser } from './review-headless-test';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const browser = createReviewBrowser(`
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { NativeUpdatePanel } from './NativeUpdatePanel';
import { createNativeUpdateCommands } from '../lib/tauri';
const root = createRoot(document.getElementById('root'));
let revision = 0;
window.harness = {
  calls: [], busy: [],
  mount(code, kind = 'string', stage = 'download') {
    const calls = []; const busy = [];
    this.calls = calls; this.busy = busy;
    const failure = kind === 'error' ? new Error(code) : kind === 'object' ? { message: code, detail: 'DUMMY_PRIVATE_DETAIL' } : code;
    const api = createNativeUpdateCommands(async (command) => {
      calls.push(command);
      if (command === 'check_native_update') return {status: 'available', version: '3.0.0-test.2'};
      if (command === 'download_native_update') {
        if (stage === 'download') throw failure;
        return {status: 'downloaded'};
      }
      if (command === 'install_native_update') throw failure;
      throw Error('Unexpected restart in error test');
    });
    flushSync(() => root.render(<NativeUpdatePanel key={++revision} api={api} beforeInstall={() => { if (stage === 'guard-error') throw Error('https://dummy.invalid/?token=DUMMY_TOKEN /DUMMY_PRIVATE_PATH'); return stage !== 'guard'; }} beforeRestart={() => true} onBusyChange={value => busy.push(value)} />));
  },
  click(label) { [...document.querySelectorAll('button')].find(button => button.textContent === label)?.click(); },
  state() { return {status: document.querySelector('[role=status]').textContent, text: document.body.textContent,
    buttons: [...document.querySelectorAll('button')].map(button => ({label: button.textContent, disabled: button.disabled})), calls: this.calls, busy: this.busy}; }
};`, resolveDir);

type View = { status: string; text: string; buttons: {label: string; disabled: boolean}[]; calls: string[]; busy: boolean[] };
const state = () => browser.evaluate<View>('window.harness.state()');
async function click(label: string) { await browser.evaluate(`window.harness.click(${JSON.stringify(label)})`); }
async function mount(code: string, kind = 'string', stage = 'download') {
  await browser.evaluate(`window.harness.mount(${JSON.stringify(code)},${JSON.stringify(kind)},${JSON.stringify(stage)})`);
  await click('检查更新');
  await browser.until(state, view => view.status === '发现新版本。');
}
beforeAll(() => browser.start(), 20_000);
afterAll(async () => { await browser.close(); expect(browser.errors).toEqual([]); });

it.each([
  ['update_signature_invalid', /签名.*未通过/, 'string'],
  ['update_signature_invalid', /签名.*未通过/, 'error'],
  ['update_signed_version_mismatch', /签名版本.*不一致/, 'string'],
  ['update_signed_version_missing', /签名.*缺少版本/, 'string'],
  ['update_signature_metadata_invalid', /签名信息.*无效/, 'string'],
  ['update_download_http_failed', /下载服务器.*拒绝/, 'string'],
  ['update_download_network_failed', /网络连接.*失败/, 'string'],
  ['update_download_stream_failed', /下载.*中断/, 'string'],
  ['update_download_timeout', /下载.*超时/, 'string'],
])('shows the safe cause of %s (%s) without enabling installation', async (code, message, kind) => {
  await mount(code, kind);
  await click('下载并验证');
  const view = await browser.until(state, value => value.status !== '发现新版本。' && !value.busy.at(-1));
  expect(view.status).toMatch(message);
  if (code.includes('signature') || code.includes('signed_version')) expect(view.status).not.toMatch(/网络/);
  expect(view.buttons).toEqual([{label:'检查更新',disabled:false},{label:'下载并验证',disabled:false}]);
  expect(view.calls).toEqual(['check_native_update','download_native_update']);
  expect(view.busy).toEqual([true,false,true,false]);
});

it.each([
  ['update_download_failed_unknown', 'string'],
  ['update_download_or_signature_failed', 'string'],
  ['https://dummy.invalid/file?token=DUMMY_TOKEN /DUMMY_PRIVATE_PATH', 'error'],
  ['update_signature_invalid?token=DUMMY_TOKEN', 'string'],
  ['update_signature_invalid', 'object'],
])('keeps unknown or sensitive rejections neutral and redacted (%s)', async (code, kind) => {
  await mount(code, kind);
  await click('下载并验证');
  const view = await browser.until(state, value => value.status !== '发现新版本。' && !value.busy.at(-1));
  expect(view.status).toMatch(/原因未确定/);
  expect(view.text).not.toMatch(/网络|DUMMY_|dummy\.invalid|token=|update_signature_invalid/);
  expect(view.calls).toEqual(['check_native_update','download_native_update']);
  expect(view.buttons.some(button => /安装|重启/.test(button.label))).toBe(false);
});

it.each([
  ['update_install_permission_denied', /安装.*文件权限.*人工检查/],
  ['update_install_read_only', /安装.*只读文件系统.*人工检查/],
  ['update_install_disk_full', /安装.*存储空间.*人工检查/],
  ['update_install_missing_file', /安装.*文件缺失.*人工检查/],
  ['update_install_cross_device', /安装.*跨文件系统.*人工检查/],
  ['update_install_invalid_data', /安装.*数据格式.*人工检查/],
  ['update_install_wrong_volume', /安装.*临时目录.*文件系统.*人工检查/],
  ['update_install_backup_preserved', /旧应用.*恢复.*人工检查/],
  ['update_install_failed_manual_recovery_required', /安装失败.*人工检查/],
  ['update_install_outcome_uncertain', /安装结果未确定.*人工检查/],
  ['https://dummy.invalid/?token=DUMMY_TOKEN /DUMMY_PRIVATE_PATH', /人工检查/],
])('separates install failure from download errors and prevents blind retry (%s)', async (code, message) => {
  await mount(code, 'error', 'install');
  await click('下载并验证');
  await browser.until(state, view => view.buttons.some(button => button.label === '确认安装并替换应用'));
  await click('确认安装并替换应用');
  const view = await browser.until(state, value => value.status.includes('人工检查') && !value.busy.at(-1));
  expect(view.status).toMatch(message);
  expect(view.text).not.toMatch(/DUMMY_|dummy\.invalid|token=/);
  expect(view.buttons).toEqual([{label:'检查更新',disabled:false}]);
  expect(view.calls).toEqual(['check_native_update','download_native_update','install_native_update']);
});

 it.each([['guard', /安装前检查未通过.*本次未调用安装器/],['guard-error', /安装前检查未完成.*本次未调用安装器/]])('reports preflight %s separately from actual installer failure', async (stage, expected) => {
  await mount('unused', 'string', stage); await click('下载并验证');
  await browser.until(state, view => view.buttons.some(button => button.label === '确认安装并替换应用'));
  await click('确认安装并替换应用');
  const view = await browser.until(state, value => !value.busy.at(-1) && !value.buttons.some(button => button.label === '确认安装并替换应用'));
  expect(view.status).toMatch(expected); expect(view.text).not.toMatch(/DUMMY_|dummy\.invalid|token=/);
  expect(view.calls).toEqual(['check_native_update','download_native_update']);
  expect(view.buttons).toEqual([{label:'检查更新',disabled:false}]);
 });
 it.each([
  ['save_and_close_processing_console_first', /保存并关闭规则与处理记录窗口/],
  ['main_window_required', /主窗口/],
  ['explicit_confirmation_required', /明确确认/],
  ['update_busy', /更新任务仍在进行/],
  ['invalid_update_state', /更新状态/],
  ['missing_update', /更新信息/],
  ['missing_verified_download', /已验证的更新包/],
 ])('identifies native pre-install gate %s without claiming installer entry', async (code, reason) => {
  await mount(code, 'string', 'install'); await click('下载并验证');
  await browser.until(state, view => view.buttons.some(button => button.label === '确认安装并替换应用'));
  await click('确认安装并替换应用');
  const view = await browser.until(state, value => !value.busy.at(-1) && !value.buttons.some(button => button.label === '确认安装并替换应用'));
  expect(view.status).toMatch(reason); expect(view.status).toContain('本次未调用安装器');
  expect(view.buttons).toEqual([{label:'检查更新',disabled:false}]);
 });
