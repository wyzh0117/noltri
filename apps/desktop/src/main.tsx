/**
 * Setup Manager (V1 §12 / M05): 「捕获」、「AI 连接」 and 「浏览器通道」.
 *
 * 捕获: honest Accessibility status (the grant belongs to macOS System Settings and is never
 * bypassed), a live one-shot capture test, gating knobs and the per-app opt-out lists.
 * AI 连接: detect → test → prepare → (optionally) write, per MCP client; Cursor / Codex / 其他 are
 * guided with a copyable entry instead of a written file. A written config receives a freshly minted
 * per-client grant (采集 + 读取) rather than the device credential, and both 撤销 and 卸载 retire it.
 * 浏览器通道: register / repair / retire the native-messaging entry, always pointing at the installed
 * app's own runtime instead of whatever a development run left behind.
 */
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import type { ReactElement } from 'react';
import type { IssueGrantResponse, PublicGrant } from '@noltri/api-client';
import { commands } from './lib/tauri';
import type { BrowserHostStatus, CaptureStateOut, ConfigBackup, ConnectionProbeOut, SettingsShape, TargetFacts } from './lib/types';
import {
  buildServerEntry,
  describeRemoval,
  mergeServerEntry,
  parseExistingConfig,
  removeServerEntry,
  serializeDocument,
  summarizeMerge,
} from './lib/mcp-config';
import {
  AGENT_PRIVACY_NOTE,
  MAX_GRANTED_PROJECTS,
  MAX_SNIPPET_CHARS,
  MIN_SNIPPET_CHARS,
  credentialFromMint,
  currentGrant,
  describeGrant,
  grantClientFor,
  grantLabelFor,
  grantOptionConflict,
  nodeSelectionFor,
  projectOptions,
  scopesFor,
  snippetCharsFor,
  snippetSetting,
  supersededGrants,
  toggleProject,
  type ProjectOption,
} from './lib/grants';
import { agentRows, canWriteConfig, hasOfficialEntry, supportLabel } from './lib/agent-matrix';
import {
  describeProbeVerdict,
  planProbe,
  readAgentProbe,
  runOwnProbe,
  type ProbeCheck,
  type ProbePlan,
  type ProbeVerdict,
} from './lib/probe';
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

      <section aria-labelledby="browser-heading">
        <h2 id="browser-heading">浏览器通道</h2>
        <BrowserChannel />
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

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Enough entropy to tell two probes apart; a probe marker is an identifier, never a secret. */
function newNonce(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

function ConnectionCard({ targetKey, hint, token }: { targetKey: string; hint: string; token: string }): ReactElement {
  const [facts, setFacts] = useState<TargetFacts | null>(null);
  const [local, setLocal] = useState<ConnectionProbeOut | null>(null);
  const [phase, setPhase] = useState<ConnectionPhase>('idle');
  const [detail, setDetail] = useState('');
  const [copied, setCopied] = useState(false);
  const [backups, setBackups] = useState<ConfigBackup[] | null>(null);
  const [grant, setGrant] = useState<PublicGrant | null>(null);
  /** The credential that actually went into this client's config file — the probe writes with it. */
  const [writtenCredential, setWrittenCredential] = useState('');
  const [plan, setPlan] = useState<ProbePlan | null>(null);
  const [ownProbe, setOwnProbe] = useState<ProbeVerdict | null>(null);
  const [agentProbe, setAgentProbe] = useState<ProbeCheck | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [captureOnly, setCaptureOnly] = useState(false);
  const [nodeIds, setNodeIds] = useState<string[]>([]);
  const [snippet, setSnippet] = useState('');
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);

  async function loadFacts(): Promise<TargetFacts> {
    const resolved = await commands.mcpConfigFor(targetKey);
    setFacts(resolved);
    void refreshGrant(resolved);
    return resolved;
  }

  /** Best effort: a Core that will not answer leaves the 授权 row empty, which is the honest state. */
  async function refreshGrant(resolved: TargetFacts): Promise<void> {
    try {
      setGrant(currentGrant(await grantClientFor(resolved, token).grants(), grantLabelFor(resolved)));
    } catch {
      setGrant(null);
    }
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
  const snippetChoice = snippetSetting(snippet);
  const conflict = grantOptionConflict({ captureOnly, nodeIds, snippetChars: snippetChoice.snippetChars });
  const blocked = conflict ?? snippetChoice.error;

  /** 限制项目 needs the real tree; loading it on mount for seven cards would be a request storm. */
  async function loadProjects(): Promise<void> {
    if (facts === null) return;
    try {
      setProjects(projectOptions((await grantClientFor(facts, token).tree()).nodes));
    } catch (error) {
      setProjects(null);
      setDetail(`读取项目列表失败：${reasonOf(error)}`);
    }
  }

  async function writeToConfig(): Promise<void> {
    if (facts === null || facts.configPath === null) return;
    if (blocked !== null) {
      setDetail(`未写入：${blocked}`);
      return;
    }
    const label = grantLabelFor(facts);

    // Read and parse first: a file we cannot even parse should not cost a credential.
    let raw: string | null;
    let document: Record<string, unknown>;
    try {
      raw = await commands.readConfigFile(facts.configPath);
      document = parseExistingConfig(raw);
    } catch (error) {
      setDetail(`未写入：${reasonOf(error)}`);
      return;
    }

    // §431: the credential in that file lives in an application this project does not control, so the
    // write mints a per-client grant with the smallest scopes instead of shipping the device key. Only
    // a deployment that never turned on 客户端授权 keeps using the old credential, and it says so.
    const options = { captureOnly, nodeIds, snippetChars: snippetChoice.snippetChars };
    const selected = nodeSelectionFor(options);
    const capped = snippetCharsFor(options);
    let minted: IssueGrantResponse | null = null;
    let mintError: unknown = null;
    try {
      minted = await grantClientFor(facts, token).issueGrant({
        label,
        client: facts.target,
        scopes: scopesFor(options),
        ...(selected === undefined ? {} : { nodeIds: selected }),
        ...(capped === undefined ? {} : { snippetChars: capped }),
      });
    } catch (error) {
      mintError = error;
    }
    const credential = credentialFromMint({ minted, error: mintError, deviceToken: token, label });
    if (!credential.ok) {
      setDetail(credential.detail);
      return;
    }

    // The pure merge runs here with the file's real current content; Rust re-validates before the
    // atomic write and refuses anything that would drop another server.
    const merged = mergeServerEntry(document, facts.serverName, buildServerEntry(facts.endpoint, credential.token));
    if (!merged.ok) {
      setDetail(`未写入：${merged.reason}${minted === null ? '' : '；刚签发的授权请点「撤销授权」。'}`);
      return;
    }
    const confirmed = window.confirm(
      `即将写入：${facts.configPath}\n\n${summarizeMerge(raw, facts.serverName)}\n\n${credential.note}\n\n` +
        '原文件会先备份为带时间戳的副本，确认写入？',
    );
    if (!confirmed) {
      if (minted === null) return;
      setDetail(`已取消写入。${await revokeGrantOrExplain(facts, minted.grant.id, '刚签发的授权已同步撤销。')}`);
      return;
    }
    try {
      await commands.writeMcpConfig(facts.target, facts.configPath, serializeDocument(merged.document));
    } catch (error) {
      if (minted === null) {
        setDetail(`写入被拒绝：${reasonOf(error)}`);
        return;
      }
      // A rejected write must not leave a live key that no config file points at.
      setDetail(
        `写入被拒绝：${reasonOf(error)}。${await revokeGrantOrExplain(facts, minted.grant.id, '刚签发的授权已撤销，没有留下可用凭据。')}`,
      );
      return;
    }
    setDetail(
      `已写入配置文件${minted === null ? '' : `，并为「${label}」签发专属授权`}。请重启对应客户端以加载知序服务器。`,
    );
    // A probe means something only with the credential that is now sitting in that file.
    setWrittenCredential(credential.token);
    setPlan(null);
    setOwnProbe(null);
    setAgentProbe(null);
    if (minted !== null) {
      setGrant(minted.grant);
      try {
        const client = grantClientFor(facts, token);
        const list = await client.grants();
        // M02 idempotency: re-writing the same client replaces its credential rather than
        // accumulating a pile of live grants.
        for (const stale of supersededGrants(list, label, minted.grant.id)) {
          try {
            await client.revokeGrant(stale.id);
          } catch {
            // The next refresh shows what is still live; 撤销 stays clickable here.
          }
        }
      } catch {
        // The fresh grant is already in the config file, so the connection works regardless.
      }
    }
    await loadFacts();
    await refreshBackups();
  }

  /** A revocation that must never mask the result it follows: report, but do not fail the caller. */
  async function revokeGrantOrExplain(resolved: TargetFacts, id: string, okText: string): Promise<string> {
    try {
      await grantClientFor(resolved, token).revokeGrant(id);
      return okText;
    } catch {
      return '授权未能自动撤销，请点击「撤销授权」。';
    }
  }

  async function revokeCurrentGrant(): Promise<void> {
    if (facts === null || grant === null) return;
    const confirmed = window.confirm(
      `撤销「${grant.label}」？\n\n该客户端的下一次请求会被拒绝，需要重新写入配置才能恢复。其他客户端不受影响。`,
    );
    if (!confirmed) return;
    try {
      setGrant(await grantClientFor(facts, token).revokeGrant(grant.id));
      setDetail('已撤销该客户端的授权；持旧凭据的连接会在下一次请求时失效。');
    } catch (error) {
      setDetail(`撤销失败：${reasonOf(error)}`);
    }
  }

  /** 卸载 = 删条目 + 让那条目的凭据失效；否则配置文件干净了，密钥却还活着。 */
  async function revokeLiveGrant(resolved: TargetFacts): Promise<string> {
    const label = grantLabelFor(resolved);
    try {
      const live = currentGrant(await grantClientFor(resolved, token).grants(), label);
      if (live === null) return '';
      return await revokeGrantOrExplain(resolved, live.id, `已同时撤销「${label}」的授权。`);
    } catch {
      return `无法确认「${label}」的授权状态，请在检测连接后复查。`;
    }
  }

  /** §433: write a probe the user agreed to, with the credential that is in this client's file. */
  async function startProbe(): Promise<void> {
    if (facts === null || writtenCredential === '') return;
    const next = planProbe(newNonce());
    const confirmed = window.confirm(
      `将向本机知识库写入一条诊断探针并读回：\n\n${next.own.text}\n\n` +
        '它由配置文件里那份凭据写入，用来证明「写入验证完成」，不是你的知识内容。' +
        '验证后可以在收件箱把它归档到诊断项目。\n\n确认写入？',
    );
    if (!confirmed) return;
    setProbeBusy(true);
    setPlan(next);
    setAgentProbe(null);
    try {
      setOwnProbe(await runOwnProbe(grantClientFor(facts, writtenCredential), next, facts.label));
    } catch (error) {
      setOwnProbe({ ok: false, detail: `探针执行异常：${reasonOf(error)}` });
    } finally {
      setProbeBusy(false);
    }
  }

  async function checkAgentProbe(): Promise<void> {
    if (facts === null || plan === null || writtenCredential === '') return;
    setProbeBusy(true);
    try {
      setAgentProbe(await readAgentProbe(grantClientFor(facts, writtenCredential), plan));
    } catch (error) {
      setAgentProbe({ ok: false, detail: `检查失败：${reasonOf(error)}` });
    } finally {
      setProbeBusy(false);
    }
  }

  /** 卸载 = 只删自己那一条。其余服务器与未知字段由 removeServerEntry 原样保留。 */
  async function removeFromConfig(): Promise<void> {
    if (facts === null || facts.configPath === null) return;
    let raw: string | null;
    let document: Record<string, unknown>;
    try {
      raw = await commands.readConfigFile(facts.configPath);
      document = parseExistingConfig(raw);
    } catch (error) {
      setDetail(`未移除：${reasonOf(error)}`);
      return;
    }
    const outcome = removeServerEntry(document, facts.serverName);
    if (!outcome.ok) {
      setDetail(`未移除：${outcome.reason}`);
      return;
    }
    if (!outcome.removed) {
      setDetail(`配置文件中没有「${facts.serverName}」条目，文件未做任何修改`);
      return;
    }
    const confirmed = window.confirm(
      `即将修改：${facts.configPath}\n\n${describeRemoval(raw, facts.serverName)}\n\n确认移除知序条目？`,
    );
    if (!confirmed) return;
    try {
      await commands.removeMcpConfig(facts.target, facts.configPath, serializeDocument(outcome.document));
    } catch (error) {
      setDetail(`移除被拒绝：${reasonOf(error)}`);
      return;
    }
    setDetail(`已移除知序条目，其它服务器保持不变。原文件已备份，可恢复。${await revokeLiveGrant(facts)}`);
    await loadFacts();
    await refreshBackups();
  }

  async function refreshBackups(): Promise<void> {
    if (facts === null || facts.configPath === null) return;
    try {
      setBackups(await commands.listConfigBackups(facts.target, facts.configPath));
    } catch (error) {
      setBackups(null);
      setDetail(`读取备份失败：${reasonOf(error)}`);
    }
  }

  async function restoreFrom(backup: ConfigBackup): Promise<void> {
    if (facts === null || facts.configPath === null) return;
    const confirmed = window.confirm(
      `将用 ${backup.madeAtLabel}（${String(backup.bytes)} 字节）覆盖：\n${facts.configPath}\n\n` +
        '当前内容会先写入新的备份，所以这次恢复本身也能撤销。\n\n确认恢复？',
    );
    if (!confirmed) return;
    try {
      await commands.restoreMcpConfig(facts.target, facts.configPath, backup.file);
      setDetail(`已恢复到 ${backup.madeAtLabel} 的内容。请重启对应客户端。`);
    } catch (error) {
      setDetail(`恢复失败：${reasonOf(error)}`);
      return;
    }
    await loadFacts();
    await refreshBackups();
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
      {facts !== null && (
        <p className="grant-row">
          授权：
          {grant === null ? '这个客户端当前没有生效中的专属授权；写入配置时会按客户端签发一份。' : describeGrant(grant)}
          {grant !== null && grant.revokedAt === null && (
            <button type="button" className="button-danger" onClick={() => void revokeCurrentGrant()}>
              撤销授权
            </button>
          )}
          <span className="muted">「复制 MCP 条目」仍沿用设备凭据，需要可撤销的授权请走「写入配置」。</span>
        </p>
      )}
      {facts !== null && (
        <div className="grant-options">
          <p className="privacy-note">{AGENT_PRIVACY_NOTE}</p>
          <label className="option">
            <input type="checkbox" checked={captureOnly} onChange={(event) => setCaptureOnly(event.target.checked)} />
            只写采集：允许这个客户端保存，但不允许读取或检索知识库
          </label>
          <label className="option">
            <input
              type="number"
              value={snippet}
              min={String(MIN_SNIPPET_CHARS)}
              max={String(MAX_SNIPPET_CHARS)}
              step="10"
              placeholder="不限制"
              onChange={(event) => setSnippet(event.target.value)}
            />
            <span>限制返回片段：这个客户端每次读回的正文最多这么多字（检索、上下文、节点与原文都受它约束）。</span>
          </label>
          {snippetChoice.error !== null && <p className="status-bad">{snippetChoice.error}</p>}
          <div className="row">
            <button type="button" onClick={() => void loadProjects()}>载入项目列表以限制范围</button>
            {nodeIds.length > 0 && (
              <button type="button" onClick={() => setNodeIds([])}>放开到全部项目</button>
            )}
          </div>
          {projects === null ? (
            <p className="muted">
              未载入时不限制项目。一份授权最多带 {String(MAX_GRANTED_PROJECTS)} 个项目，超出后复选框会停住。
            </p>
          ) : (
            <div className="project-list">
              {projects.map((option) => (
                <label key={option.id} className="option">
                  <input
                    type="checkbox"
                    checked={nodeIds.includes(option.id)}
                    disabled={!nodeIds.includes(option.id) && nodeIds.length >= MAX_GRANTED_PROJECTS}
                    onChange={() => setNodeIds((current) => toggleProject(current, option.id))}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          )}
          {conflict !== null && <p className="status-bad">{conflict}</p>}
        </div>
      )}
      {facts !== null && (
        <div className="probe">
          <div className="row">
            <button type="button" disabled={writtenCredential === '' || probeBusy} onClick={() => void startProbe()}>
              发起写入验证探针
            </button>
            {plan !== null && (
              <button type="button" disabled={probeBusy} onClick={() => void checkAgentProbe()}>
                检查 Agent 是否已写入
              </button>
            )}
          </div>
          <p className="muted">
            {writtenCredential === ''
              ? '「写入验证完成」需要用配置文件里那份凭据写入并读回一条专用探针；先完成「写入配置」，凭据才会留在本次会话里。'
              : '探针将以配置文件里那份凭据写入并读回。真实握手与 tools/list 只证明连接可用，不足以标记验证完成。'}
          </p>
          {ownProbe !== null && (
            <p className={ownProbe.ok ? 'status-ok' : 'status-bad'}>
              {ownProbe.ok ? `写入验证完成（本机凭据写入并读回）：${describeProbeVerdict(ownProbe)}` : `未验证：${ownProbe.detail}`}
            </p>
          )}
          {plan !== null && (
            <p className="muted">
              Agent 侧：请在「{facts.label}」里让 Agent 用知序工具保存这句话，然后回来检查。只有读回由知序工具写入的那条记录，才算「经
              Agent 写入验证完成」。
              <code className="probe-phrase">{plan.agent.text}</code>
            </p>
          )}
          {agentProbe !== null && (
            <p className={agentProbe.ok ? 'status-ok' : 'status-bad'}>
              {agentProbe.ok ? '写入验证完成（经该客户端的知序工具）：' : '未验证：'}
              {agentProbe.detail}
            </p>
          )}
        </div>
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
          <>
            <button type="button" onClick={() => void writeToConfig()}>
              写入 {facts.configPath}
            </button>
            <button type="button" className="button-danger" onClick={() => void removeFromConfig()}>
              移除知序条目
            </button>
          </>
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
      {writable && facts?.configPath != null && (
        <div className="undo">
          <div className="row">
            <button type="button" onClick={() => void refreshBackups()}>
              列出修改前备份
            </button>
          </div>
          {backups === null ? (
            <p className="muted">备份在每次写入或移除前自动创建；点击上方按钮查看可恢复的版本。</p>
          ) : backups.length === 0 ? (
            <p className="muted">这个文件还没有由知序创建的备份。</p>
          ) : (
            <ul className="backup-list">
              {backups.map((backup) => (
                <li key={backup.file}>
                  {backup.madeAtLabel}｜{String(backup.bytes)} 字节｜{backup.file}
                  <button type="button" onClick={() => void restoreFrom(backup)}>
                    恢复到此版本
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

const BROWSER_CHOICES = ['chrome', 'edge', 'brave', 'firefox'] as const;
type BrowserChoice = (typeof BROWSER_CHOICES)[number];

/**
 * M05: the native-messaging registration lives in a file *the browser* reads. The launcher that
 * gets registered is written by the Rust side into the app data directory and always execs this
 * bundle's runtime, so 修复 means "the manifest now points at the installed app again" — never at
 * a development directory. Preview is read-only; the write needs an explicit confirmation.
 */
function BrowserChannel(): ReactElement {
  const [status, setStatus] = useState<BrowserHostStatus | null>(null);
  const [extensionId, setExtensionId] = useState('');
  const [browser, setBrowser] = useState<BrowserChoice>('chrome');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await commands.browserHostStatus());
    } catch (error) {
      setOutput(`无法读取注册状态：${reasonOf(error)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: 'preview' | 'write' | 'uninstall'): Promise<void> {
    if (action === 'write') {
      const confirmed = window.confirm(
        `将为 ${browser} 注册知序本地入口：\n\n入口：${status?.launcherPath ?? '（随包入口）'}\n扩展：${extensionId.trim()}\n\n` +
          '入口会先写入应用数据目录；如果这台机器已有 manifest，会先备份再覆盖。确认写入？',
      );
      if (!confirmed) return;
    }
    if (action === 'uninstall') {
      const confirmed = window.confirm(
        `撤销 ${browser} 的知序 host 注册？\n\n如果注册前的 manifest 有备份，会恢复它；入口文件本身不会被删除。`,
      );
      if (!confirmed) return;
    }
    setBusy(true);
    setOutput(null);
    try {
      const text =
        action === 'uninstall'
          ? await commands.browserHostUninstall(browser)
          : await commands.browserHostRepair([extensionId.trim()], browser, action === 'write');
      setOutput(text);
      await refresh();
    } catch (error) {
      setOutput(
        `${action === 'preview' ? '预览' : action === 'write' ? '写入' : '撤销'}失败：${reasonOf(error)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="connection-card">
      <h3>浏览器采集通道（native messaging）</h3>
      <p className="muted">
        注册或修复后，浏览器启动的固定入口指向本应用随包运行时；这台机器上任何指向开发目录的旧注册，都可以用「修复注册」换掉。
      </p>
      {status === null ? (
        <p className="muted">正在读取注册状态…</p>
      ) : (
        <>
          {!status.serviceable ? (
            <p className="muted">{status.note}</p>
          ) : (
            <ul className="channel-facts">
              <li>
                随包入口：{status.launcherPath}（{status.launcherPresent ? '已写入' : '尚未写入，注册时创建'}）
              </li>
              <li>manifest：{status.manifestFile ?? '未能确定'}</li>
              <li>
                当前注册：
                {status.currentExecutable === null
                  ? '（没有已注册的 host）'
                  : `${status.currentExecutable}${
                      status.managed === true ? '（指向本应用，无需修复）' : '（不是本应用入口，需要修复）'
                    }`}
              </li>
            </ul>
          )}
          <div className="row">
            <input
              value={extensionId}
              onChange={(event) => setExtensionId(event.target.value)}
              placeholder="扩展 ID（chrome-extension:// 后的 32 位）"
              disabled={!status.serviceable}
            />
            <select value={browser} onChange={(event) => setBrowser(event.target.value as BrowserChoice)}>
              {BROWSER_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <button type="button" disabled={busy || !status.serviceable} onClick={() => void run('preview')}>
              预览注册
            </button>
            <button
              type="button"
              disabled={busy || !status.serviceable || extensionId.trim() === ''}
              onClick={() => void run('write')}
            >
              写入注册
            </button>
            <button
              type="button"
              className="button-danger"
              disabled={busy || !status.serviceable}
              onClick={() => void run('uninstall')}
            >
              撤销注册
            </button>
          </div>
          {output !== null && <pre className="cli-output">{output}</pre>}
        </>
      )}
    </article>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
