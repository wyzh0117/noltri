'use client';

/**
 * Research Map (research doc §21): RQ → Evidence → Claim → Section → Contribution in readable,
 * column-first layout. No graph library — the map answers "how is my conclusion supported" as text.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { ResearchMapResponse } from '@noltri/schema';
import { researchProjectBase, type ResearchPanelProps } from './useResearchData';
import { apiGet, describeError } from '@/lib/client-api';
import { buildMapViewModel, incomingEdges, outgoingEdges } from '@/lib/research-view';

export default function MapPanel({ projectId, data, onChanged }: ResearchPanelProps): ReactElement {
  const [map, setMap] = useState<ResearchMapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await apiGet<ResearchMapResponse>(`${researchProjectBase(projectId)}/map`);
        if (cancelled) return;
        setMap(result);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        setError(describeError(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, data]);

  if (loading && map === null) return <p className="muted-note">正在生成 Research Map…</p>;
  if (error !== null && map === null) return <p className="error-note">{error}</p>;
  if (map === null) return <p className="muted-note">暂无 Research Map 数据。</p>;

  const model = buildMapViewModel(map);
  const selectedNode =
    model.layers.flatMap((layer) => layer.nodes).find((node) => node.id === selectedId) ?? null;

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="column-title column-title-tight">Research Map</h2>
        <span className="column-hint">
          研究结论是怎样被一步步支撑起来的：RQ → Evidence → Claim → Section → Contribution。
          {model.unsupportedClaimIds.length > 0 ? (
            <span className="badge badge-warn">{model.unsupportedClaimIds.length} 条 Claim 缺证据支持</span>
          ) : null}
        </span>
      </div>

      {error !== null ? <p className="error-note">{error}</p> : null}

      <div className="map-columns">
        {model.layers.map((layer) => (
          <div key={layer.key} className="map-column">
            <div className="column-title column-title-tight">{layer.title}</div>
            {layer.nodes.length === 0 ? (
              <p className="muted-note">{layer.emptyHint}</p>
            ) : (
              <ul className="map-node-list">
                {layer.nodes.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      className={`map-node map-node-${node.tone}${selectedId === node.id ? ' map-node-selected' : ''}`}
                      aria-pressed={selectedId === node.id}
                      onClick={() => setSelectedId((previous) => (previous === node.id ? null : node.id))}
                    >
                      {node.code !== null ? <span className="map-node-code">{node.code}</span> : null}
                      <span className="map-node-title">{node.title}</span>
                      {node.meta !== null ? <span className="map-node-meta">{node.meta}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {selectedNode === null ? (
        <p className="muted-note">点击任意节点可以查看它的来龙去脉（谁支持它、它支撑了什么）。</p>
      ) : (
        <div className="map-detail">
          <div className="card-head">
            {selectedNode.code !== null ? <span className="badge">{selectedNode.code}</span> : null}
            <strong className="item-text">{selectedNode.title}</strong>
          </div>
          <div className="map-edge-group">
            <div className="login-label">支撑这条结论的输入</div>
            {incomingEdges(model, selectedNode.id).length === 0 ? (
              <p className="muted-note">暂无输入关系。</p>
            ) : (
              <ul className="map-edge-list">
                {incomingEdges(model, selectedNode.id).map((edge) => (
                  <li key={edge.id} className="map-edge-line">
                    {edge.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="map-edge-group">
            <div className="login-label">这条结论支撑的输出</div>
            {outgoingEdges(model, selectedNode.id).length === 0 ? (
              <p className="muted-note">暂无输出关系。</p>
            ) : (
              <ul className="map-edge-list">
                {outgoingEdges(model, selectedNode.id).map((edge) => (
                  <li key={edge.id} className="map-edge-line">
                    {edge.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <details className="map-edge-group">
        <summary className="login-label">全部关系（{model.edges.length} 条）</summary>
        <ul className="map-edge-list">
          {model.edges.map((edge) => (
            <li key={edge.id} className="map-edge-line">
              {edge.text}
            </li>
          ))}
        </ul>
      </details>

      <p className="muted-note">
        改动 Claim、Evidence 或关系后回到这里即可看到最新结构；
        <button type="button" className="btn" onClick={onChanged}>
          刷新数据
        </button>
      </p>
    </section>
  );
}
