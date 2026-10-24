import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchGraph } from './src/workbench/WorkbenchGraph';
import './src/workbench/workbench-graph.css';

function graphData(count: number) {
  const nodes = Array.from({ length: count }, (_, index) => ({
    path: `notes/Note-${String(index).padStart(5, '0')}.md`,
    title: `Note ${index}`,
    basename: `Note-${index}`,
    type: 'note' as const,
    tags: index % 15 === 0 ? ['benchmark', 'graph'] : [],
    mtime: 1_700_000_000_000 + index * 1000,
    ctime: 1_699_000_000_000 + index * 1000,
  }));
  const edges = [] as Array<{ sourcePath: string; targetPath: string; count: number; resolved: boolean }>;
  for (let index = 0; index < count; index += 1) {
    for (const stride of [1, 7]) {
      const target = (index + stride) % count;
      if (target === index) continue;
      edges.push({ sourcePath: nodes[index]!.path, targetPath: nodes[target]!.path, count: 1, resolved: true });
    }
  }
  return { nodes, edges, revision: count };
}

function Harness() {
  const [count, setCount] = useState(100);
  const [data, setData] = useState(() => graphData(100));
  const [mode, setMode] = useState<'global' | 'local'>('global');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [status, setStatus] = useState('Ready');
  const [coreUrl, setCoreUrl] = useState<string | null>(null);
  const changeCount = (next: number) => {
    setStatus(`Loading ${next.toLocaleString()} nodes`);
    setCoreUrl(null);
    setData(graphData(next));
    setCount(next);
    window.setTimeout(() => setStatus('Ready'), 400);
  };
  const loadCoreGraph = async (url: string) => {
    setStatus(`Loading graph from ${url}`);
    const response = await fetch(`${url.replace(/\/$/, '')}/api/vault/graph`);
    if (!response.ok) throw new Error(`Graph API returned ${response.status}`);
    const graph = await response.json();
    setData(graph);
    setCount(graph.nodes.length);
    setCoreUrl(url.replace(/\/$/, ''));
    setStatus(`Core revision ${graph.revision}`);
  };
  Object.assign(window, { __graphHarnessSetCount: changeCount, __graphHarnessLoadCore: loadCoreGraph, __graphHarnessStatus: () => status, __graphHarnessCount: () => count, __graphHarnessData: () => data });
  return <main style={{ height: '100%', display: 'grid', gridTemplateRows: '40px minmax(0,1fr)', font: '12px system-ui,sans-serif' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '0 12px' }}>
      {[100, 1000, 5000].map((size) => <button type="button" key={size} onClick={() => changeCount(size)}>{size}</button>)}
      <strong>{count} nodes · {data.edges.length} edges</strong>
      <span>{status}</span>
    </div>
    <WorkbenchGraph data={data as never} vaultRoot={coreUrl ?? "/tmp/noltri-graph-smoke-vault"} mode={mode} focusedPath={mode === 'local' ? data.nodes[0]?.path ?? null : null} selectedPath={selectedPath} loading={false} error={null} evaluateQuery={async (query) => {
      if (coreUrl !== null) {
        const response = await fetch(`${coreUrl}/api/vault/match?q=${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error(`Match API returned ${response.status}`);
        return response.json();
      }
      return { revision: data.revision, paths: data.nodes.map((node) => node.path), matchingTags: [], attachmentPaths: [] };
    }} onModeChange={setMode} onNodeOpen={(path) => { setSelectedPath(path); setStatus(`Opened ${path}`); }} onTagOpen={(tag) => setStatus(`Opened tag ${tag}`)} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<Harness />);
