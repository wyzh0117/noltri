/**
 * Setup Manager (V1 §12): two sections only — 「捕获」 and 「AI 连接」.
 *
 * 捕获: honest Accessibility status (the grant belongs to macOS System Settings and is never
 * bypassed), a live one-shot capture test, gating knobs and the per-app opt-out lists.
 * AI 连接: detect → test → prepare → (optionally) write, per MCP client; Cursor / Codex / 其他 are
 * guided with a copyable entry instead of a written file.
 */
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import type { ReactElement } from 'react';
import { commands } from './lib/tauri';
import type { CaptureStateOut, ConnectionProbeOut, SettingsShape, TargetFacts } from './lib/types';
import { buildServerEntry, mergeServerEntry, parseExistingConfig, serializeDocument, summarizeMerge } from './lib/mcp-config';
import { agentRows, canWriteConfig, hasOfficialEntry, supportLabel } from './lib/agent-matrix';
import { runConnectionProbe, type ConnectionPhase, type ProbeResult } from './lib/connection-status';

const CONNECTION_TARGETS: { key: string; hint: string }[] = [
  { key: 'claude', hint: 'Claude Desktop 的配置可由本应用代写' },
  { key: 'claude_code', hint: 'Claude Code 的 ~/.claude.json 可由本应用代写' },
  { key: 'cursor', hint: 'Cursor 只引导，不代写' },
  { key: 'chatgpt_codex', hint: 'Codex 使用 TOML 配置，只展示条目' },
  { key: 'hermes', hint: 'Hermes：本轮未核实其 MCP 注册方式，只做检测与人工引导' },
  { key: 'qoder', hint: 'Qoder：本轮未核实其 MCP 注册方式，只做检测与人工引导' },
  { key: 'other_mcp_client', hint: '任何支持 Streamable HTTP 的客户端' },
];

function App(): ReactElement {
  const [state, setState] = useState<CaptureStateOut | null>(null);
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [probe, setProbe] = useState<{ ok: boolean; reason: string; preview: string; appName: string } | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(await commands.captureState());
      setSettings(await commands.getSettings());
    } catch {
      // Outside a Tauri runtime (e.g. plain browser preview) the panel stays empty.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function testSelection(): Promise<void> {
    setProbeBusy(true);
    setProbe(null);
    try {
      const result = await commands.testSelectionCapture();
      setProbe({ ok: result.ok, reason: result.reason, preview: result.preview, appName: result.appName });
    } catch (error) {
      setProbe({ ok: false, reason: error instanceof Error ? error.message : 'unknown', preview: '', appName: '' });
    } finally {
      setProbeBusy(false);
    }
  }

  if (state === null || settings === null) {
    return (
      <main className="setup">
        <h1>知序 · Setup Manager</h1>
        <p>正在连接本机 Companion…（若在浏览器中打开，此页不可用）</p>
      </main>
    );
  }

  return (
    <main className="setup">
      <header className="setup-header">
        <h1>知序 · Setup Manager</h1>
        <p className="muted">
          设备 {state.deviceId}｜全局快捷键 {state.globalShortcut}｜Core {state.apiBaseUrl}
        </p>
        <p>
          <button type="button" onClick={() => void commands.openWorkbench().catch(() => undefined)}>
            打开知识工作台
          </button>
          <span className="muted"> 知识树、收件箱、搜索与节点对话在工作台窗口，这里只管捕获与连接。</span>
        </p>
      </header>

      <section aria-labelledby="capture-heading">
        <h2 id="capture-heading">捕获</h2>
        <p className={state.accessibilityTrusted ? 'status-ok' : 'status-bad'}>
          macOS 辅助功能：{state.accessibilityTrusted ? '已授权' : '未授权'}
          {!state.accessibilityTrusted && (
            <>
              {' '}
              <button type="button" onClick={() => void commands.openAccessibilitySettings()}>
                打开系统设置
              </button>{' '}
              <button type="button" onClick={() => void commands.recheckPermission(true).then(refresh)}>
                我已授权，重新检查
              </button>
            </>
          )}
        </p>
        <p className="muted">
          授权必须由你在系统设置中完成，本应用不会也无法代替你授权。状态解释：辅助功能只用于读取你选中的文字。
        </p>

        <label className="row">
          <input
            type="checkbox"
            checked={state.captureEnabled}
            onChange={(event) => void commands.setCaptureEnabled(event.target.checked).then(setState)}
          />
          启用选区捕获（关闭后观察线程完全停止）
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={state.autoShowOverlay}
            onChange={(event) =>
              void commands
                .setSettings({ autoShowOverlay: event.target.checked })
                .then(setSettings)
                .then(refresh)
            }
          />
          有新选区时自动显示悬浮球（关闭 = 仅快捷键）
        </label>
        <label className="row">
          最短选区长度
          <input
            type="number"
            min={8}
            value={state.minSelectionLength}
            onChange={(event) =>
              void commands
                .setSettings({ minSelectionLength: Number(event.target.value) })
                .then(setSettings)
                .then(refresh)
            }
          />
        </label>

        <h3>测试选区捕获</h3>
        <p className="muted">读取一次当前选区并给出失败原因（不打扰目标应用）。</p>
        <button type="button" disabled={probeBusy} onClick={() => void testSelection()}>
          {probeBusy ? '读取中…' : '测试当前选区'}
        </button>
        {probe !== null && (
          <p className={probe.ok ? 'status-ok' : 'status-bad'}>
            {probe.ok ? '读取成功' : `未读取（${probe.reason}）`}｜{probe.appName}
            {probe.ok ? `：${probe.preview.slice(0, 80)}` : ''}
          </p>
        )}

        <h3>停用与不完全兼容的应用</h3>
        <DisabledApps state={state} onChanged={refresh} />
        <RecentList state={state} />
      </section>

      <section aria-labelledby="connect-heading">
        <h2 id="connect-heading">AI 连接</h2>
        <p className="muted">
          MCP endpoint：{settings.mcpEndpoint}
          （在下方各客户端中填入；Token 只写入你自己选择写入的配置文件，绝不回显在健康检查或日志里。）
        </p>
        {CONNECTION_TARGETS.map((target) => (
          <ConnectionCard key={target.key} targetKey={target.key} hint={target.hint} token={settings.apiToken} />
        ))}
      </section>

      <footer className="setup-footer muted">
        <p>原文永不改写｜结构可回滚｜本页所有状态都来自本机与 Knowledge Core 的真实应答。</p>
      </footer>
    </main>
  );
}

function DisabledApps({
  state,
  onChanged,
}: {
  state: CaptureStateOut;
  onChanged: () => Promise<void>;
}): ReactElement {
  const [draft, setDraft] = useState('');
  return (
    <div>
      <ul className="chip-list">
        {state.disabledApps.map((app) => (
          <li key={app}>
            {app}{' '}
            <button
              type="button"
              onClick={() => void commands.setAppOptOut(app, false).then(onChanged)}
              aria-label={`恢复 ${app}`}
            >
              恢复
            </button>
          </li>
        ))}
        {state.disabledApps.length === 0 && <li className="muted">（无）</li>}
      </ul>
      <div className="row">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="输入应用名以停用捕获"
        />
        <button
          type="button"
          disabled={draft.trim() === ''}
          onClick={() => {
            void commands.setAppOptOut(draft, true).then(onChanged);
            setDraft('');
          }}
        >
          停用
        </button>
      </div>
      {state.incompatibleApps.length > 0 && (
        <div>
          <h4>不完全兼容</h4>
          <ul className="chip-list">
            {state.incompatibleApps.map((entry) => (
              <li key={entry.app}>
                {entry.app}（{entry.reason}，{String(entry.attempts)} 次）{' '}
                <button type="button" onClick={() => void commands.clearIncompatibleApp(entry.app).then(onChanged)}>
                  重试
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RecentList({ state }: { state: CaptureStateOut }): ReactElement {
  if (state.recent.length === 0) return <p className="muted">最近收纳：（暂无）</p>;
  return (
    <div>
      <h4>最近收纳</h4>
      <ul className="recent">
        {state.recent.map((entry) => (
          <li key={entry.at} className={entry.ok ? 'status-ok' : 'status-bad'}>
            [{entry.via}] {entry.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

const PHASE_LABEL: Record<ConnectionPhase, string> = {
  idle: '未检测',
  checking: '检测中…',
  reachable: '连接正常',
  degraded: '部分可用',
  unreachable: '不可达',
};

function ConnectionCard({ targetKey, hint, token }: { targetKey: string; hint: string; token: string }): ReactElement {
  const [facts, setFacts] = useState<TargetFacts | null>(null);
  const [local, setLocal] = useState<ConnectionProbeOut | null>(null);
  const [phase, setPhase] = useState<ConnectionPhase>('idle');
  const [detail, setDetail] = useState('');
  const [copied, setCopied] = useState(false);

  async function loadFacts(): Promise<TargetFacts> {
    const resolved = await commands.mcpConfigFor(targetKey);
    setFacts(resolved);
    return resolved;
  }

  useEffect(() => {
    void loadFacts().catch(() => setFacts(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  async function test(): Promise<void> {
    setPhase('checking');
    try {
      const [probed, resolved] = await Promise.all([commands.testConnection(targetKey), loadFacts()]);
      setLocal(probed);
      const result: ProbeResult = await runConnectionProbe(resolved.coreBaseUrl, resolved.endpoint, token);
      setPhase(result.phase);
      setDetail(result.detail);
    } catch (error) {
      setPhase('unreachable');
      setDetail(error instanceof Error ? error.message : '检测失败');
    }
  }

  const entry = facts === null ? null : buildServerEntry(facts.endpoint, token);
  const writable = facts !== null && canWriteConfig(facts);

  async function writeToConfig(): Promise<void> {
    if (facts === null || entry === null || facts.configPath === null) return;
    // The pure merge runs here with the file's real current content; Rust re-validates before the
    // atomic write and refuses anything that would drop another server.
    const raw = await commands.readConfigFile(facts.configPath);
    const merged = mergeServerEntry(parseExistingConfig(raw), facts.serverName, entry);
    if (!merged.ok) {
      setDetail(`未写入：${merged.reason}`);
      return;
    }
    const confirmed = window.confirm(
      `即将写入：${facts.configPath}\n\n${summarizeMerge(raw, facts.serverName)}\n\n确认写入？`,
    );
    if (!confirmed) return;
    await commands.writeMcpConfig(facts.target, facts.configPath, serializeDocument(merged.document));
    setDetail('已写入配置文件。请重启对应客户端以加载知序服务器。');
    await loadFacts();
  }

  return (
    <article className="connection-card">
      <h3>
        {facts?.label ?? targetKey}
        {facts !== null && <span className="pill-support">{supportLabel(facts.supportState)}</span>}
        {local !== null && local.installedApps.length > 0 && (
          <span className="pill-installed">检测到已安装：{local.installedApps.join('、')}</span>
        )}
      </h3>
      <p className="muted">{facts?.guidance ?? hint}</p>
      <p className="muted">
        状态：{PHASE_LABEL[phase]}
        {detail !== '' ? `｜${detail}` : ''}
        {local !== null && local.configEntryPresent
          ? '｜配置文件中已有知序条目'
          : local !== null && facts?.configPath !== null
            ? '｜配置文件中还没有知序条目'
            : ''}
      </p>
      {facts !== null && (
        <dl className="agent-matrix">
          {agentRows(facts).map((row) => (
            <div key={row.term} className="agent-row">
              <dt>{row.term}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="row">
        <button type="button" onClick={() => void test()}>
          测试连接
        </button>
        {entry !== null && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(JSON.stringify(entry, null, 2)).then(() => setCopied(true));
            }}
          >
            {copied ? '已复制' : '复制 MCP 条目'}
          </button>
        )}
        {writable && facts?.configPath != null && (
          <button type="button" onClick={() => void writeToConfig()}>
            写入 {facts.configPath}
          </button>
        )}
        {facts !== null && hasOfficialEntry(facts) && (
          <>
            {facts.officialSettingsUrl !== null && (
              <button type="button" onClick={() => void commands.openConnectionUrl(facts.target)}>
                打开官方设置
              </button>
            )}
            {facts.docsUrl !== null && (
              <button type="button" onClick={() => void commands.openDocumentation(facts.target)}>
                官方文档
              </button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
