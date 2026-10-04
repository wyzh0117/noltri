import type { ReactElement } from 'react';
import type { HealthResponse } from '@noltri/schema';
import SearchBox from './SearchBox';
import type { WorkbenchApi } from './api';

export interface TopBarProps {
  api: WorkbenchApi;
  health: HealthResponse | null;
  healthProblem: string | null;
  domainCount: number;
  nodeCount: number;
  itemCount: number;
  onPickNode: (nodeId: string) => void;
}

/**
 * Top bar holds three things: the app, search, and how the local Core answers. There is no login and no
 * logout — the desktop workbench is the local Core, identified by the device token in Settings.
 */
export default function TopBar({
  api,
  health,
  healthProblem,
  domainCount,
  nodeCount,
  itemCount,
  onPickNode,
}: TopBarProps): ReactElement {
  const state = describeConnection(health, healthProblem);

  return (
    <header className="top-bar">
      <div className="brand">
        知序
        <span className="brand-mark">Noltri</span>
      </div>

      <SearchBox api={api} onPickNode={onPickNode} />

      <div className="top-bar-spacer" />

      <div className="session-state">
        <span className={`dot dot-${state.tone}`} aria-hidden="true" />
        <span title={state.detail}>{state.label}</span>
        <span className="badge badge-quiet" title="知识领域 / 节点 / 知识点">
          {domainCount} 领域 · {nodeCount} 节点 · {itemCount} 知识点
        </span>
      </div>
    </header>
  );
}

function describeConnection(
  health: HealthResponse | null,
  problem: string | null,
): { tone: 'ok' | 'warn' | 'bad'; label: string; detail: string } {
  if (health === null) {
    // While the first probe is still in flight nothing has failed yet, so the bar must not claim 不可用.
    if (problem === null) {
      return { tone: 'warn', label: '正在检测本机知识服务…', detail: '首次读取 Knowledge Core 状态。' };
    }
    return { tone: 'bad', label: '本机知识服务不可用', detail: problem };
  }
  if (health.status === 'degraded') {
    return {
      tone: 'warn',
      label: '知识服务降级',
      detail: `存储 ${health.storageDriver} · 模型 ${health.aiProvider}`,
    };
  }
  return {
    tone: 'ok',
    label: '知识服务已连接',
    detail: `${health.version} · 存储 ${health.storageDriver} · 模型 ${health.aiProvider} · 向量维度 ${health.embeddingDim}`,
  };
}
