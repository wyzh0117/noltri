'use client';

import type { ReactElement } from 'react';
import type { TreeNode } from '@noltri/schema';
import { subtreeItemCount } from '@noltri/shared';

export interface DomainRailProps {
  domains: readonly TreeNode[];
  activeRootId: string | null;
  onSelectDomain: (rootId: string) => void;
}

/** 知识领域 is the set of tree roots — the rail never carries unrelated navigation. */
export default function DomainRail({ domains, activeRootId, onSelectDomain }: DomainRailProps): ReactElement {
  return (
    <div>
      <div className="column-title">知识领域</div>
      {domains.length === 0 ? (
        <p className="muted-note">还没有知识领域，收录第一条内容后会自动出现。</p>
      ) : (
        <ul className="domain-list">
          {domains.map((domain) => {
            const active = domain.id === activeRootId;
            return (
              <li key={domain.id}>
                <button
                  type="button"
                  className={`domain-item${active ? ' domain-item-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => onSelectDomain(domain.id)}
                >
                  <span className="domain-title">{domain.title}</span>
                  <span className="domain-count">{subtreeItemCount(domain)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
