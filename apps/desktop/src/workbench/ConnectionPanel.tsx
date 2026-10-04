import type { ReactElement } from 'react';
import type { HealthResponse } from '@noltri/schema';

export interface ConnectionPanelProps {
  health: HealthResponse | null;
  healthProblem: string | null;
  apiBaseUrl: string;
  tokenConfigured: boolean;
  /** True when the window is not running inside Tauri (a plain `vite` preview), so Settings cannot be read. */
  outsideTauri: boolean;
  onRecheck: () => void;
  onOpenSetup: () => void;
}

/**
 * 连接与设置 as P2 needs it: what this window is actually talking to, and the way back to the Setup
 * Manager that owns those values. Editing them here would duplicate the Settings store, so it does not.
 */
export default function ConnectionPanel({
  health,
  healthProblem,
  apiBaseUrl,
  tokenConfigured,
  outsideTauri,
  onRecheck,
  onOpenSetup,
}: ConnectionPanelProps): ReactElement {
  return (
    <section className="workbench-card" aria-label="连接与设置">
      <div className="column-title">连接与设置</div>

      <dl className="connection-list">
        <dt>Knowledge Core 地址</dt>
        <dd>
          <code>{apiBaseUrl}</code>
        </dd>
        <dt>本机令牌</dt>
        <dd>{tokenConfigured ? '已配置' : '未配置（本机开放模式）'}</dd>
        <dt>服务状态</dt>
        <dd>{health === null ? `不可用：${healthProblem ?? '尚未检测'}` : `${health.status} · ${health.version}`}</dd>
        <dt>存储驱动</dt>
        <dd>{health?.storageDriver ?? '—'}</dd>
        <dt>AI Provider</dt>
        <dd>
          {health?.aiProvider ?? '—'}
          {health !== null && !health.requiresAiKey ? <span className="badge badge-quiet">无需模型密钥</span> : null}
        </dd>
        <dt>向量维度</dt>
        <dd>{health?.embeddingDim ?? '—'}</dd>
        {health ? (
          <>
            <dt>存储健康</dt>
            <dd>
              {health.storage.ok ? '正常' : '异常'}
              {Object.entries(health.storage.detail).map(([key, value]) => (
                <span key={key} className="badge badge-quiet">
                  {key} {String(value)}
                </span>
              ))}
            </dd>
          </>
        ) : null}
      </dl>

      <div className="inline-row">
        <button type="button" className="btn btn-primary" onClick={onRecheck}>
          重新检测
        </button>
        <button type="button" className="btn" onClick={onOpenSetup}>
          打开 Setup Manager
        </button>
      </div>

      <p className="muted-note">
        地址与令牌由 Setup Manager 写入系统配置目录，本窗口只读取。捕获开关、快捷键与 MCP 连接也在那里。
      </p>
      {outsideTauri ? (
        <p className="error-note">当前不在 Tauri 窗口内，读取不到本机设置，已使用默认地址 {apiBaseUrl}。</p>
      ) : null}
    </section>
  );
}
