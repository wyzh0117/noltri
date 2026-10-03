'use client';

import { useState } from 'react';
import type { ReactElement } from 'react';
import type { HealthResponse } from '@noltri/schema';
import SearchBox from './SearchBox';
import { clearServerSession } from '@/lib/auth';
import type { SessionStrategy } from '@/lib/cookie';

export interface TopBarProps {
  strategy: SessionStrategy;
  health: HealthResponse | null;
  healthProblem: string | null;
  domainCount: number;
  nodeCount: number;
  itemCount: number;
  onPickNode: (nodeId: string) => void;
}

/** Top bar holds exactly four things: identity of the app, search, connection/user state, logout. */
export default function TopBar({
  strategy,
  health,
  healthProblem,
  domainCount,
  nodeCount,
  itemCount,
  onPickNode,
}: TopBarProps): ReactElement {
  const [signingOut, setSigningOut] = useState(false);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    await clearServerSession();
    window.location.assign('/login');
  }

  const state = describeConnection(health, healthProblem);

  return (
    <header className="top-bar">
      <div className="brand">
        知序
        <span className="brand-mark">Noltri</span>
      </div>

      <SearchBox onPickNode={onPickNode} />

      <div className="top-bar-spacer" />

      <div className="session-state">
        <span className={`dot dot-${state.tone}`} aria-hidden="true" />
        <span title={state.detail}>{state.label}</span>
        <span className="badge badge-quiet" title="知识领域 / 节点 / 知识点">
          {domainCount} 领域 · {nodeCount} 节点 · {itemCount} 知识点
        </span>
        <span className="badge">{strategy === 'supabase' ? 'Supabase 登录' : '本地开发登录'}</span>
        <button type="button" className="btn" onClick={() => void signOut()} disabled={signingOut}>
          {signingOut ? '正在退出…' : '退出登录'}
        </button>
      </div>
    </header>
  );
}

function describeConnection(
  health: HealthResponse | null,
  problem: string | null,
): { tone: 'ok' | 'warn' | 'bad'; label: string; detail: string } {
  if (health === null) {
    return { tone: 'bad', label: '知识服务不可用', detail: problem ?? '尚未取得知识服务状态。' };
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
