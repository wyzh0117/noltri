import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { HealthResponse, TreeNode, TreeResponse } from '@noltri/schema';
import { summarizeTree } from '@noltri/shared';
import TopBar from './TopBar';
import KnowledgeWorkspace from './KnowledgeWorkspace';
import InboxWorkspace from './InboxWorkspace';
import ResearchWorkspace from './ResearchWorkspace';
import ConnectionPanel from './ConnectionPanel';
import { aiIsOffline, describeError } from './api';
import type { WorkbenchApi } from './api';

type WorkbenchView = 'inbox' | 'tree' | 'research' | 'connection';

const TAB_LABELS: Record<WorkbenchView, string> = {
  inbox: '收件箱',
  tree: '知识库',
  research: '研究',
  connection: '连接与设置',
};

const TAB_ORDER: readonly WorkbenchView[] = ['inbox', 'tree', 'research', 'connection'];

export interface WorkbenchAppProps {
  api: WorkbenchApi;
  apiBaseUrl: string;
  tokenConfigured: boolean;
  outsideTauri: boolean;
  onOpenSetup: () => void;
}

/**
 * The desktop workbench shell (V1_DEVELOPMENT §08 navigation). 研究 lands with P5-D's 研究工作台; 研究地图／
 * 偏移检查／上下文包 still wait for P6, so the tab shows what the Core of this build can actually answer.
 *
 * It owns what both tabs need — the Core health line and the full tree — and keeps the selected node here
 * so a search hit can move the user from 收件箱 into the knowledge tree.
 */
export default function WorkbenchApp({
  api,
  apiBaseUrl,
  tokenConfigured,
  outsideTauri,
  onOpenSetup,
}: WorkbenchAppProps): ReactElement {
  const [view, setView] = useState<WorkbenchView>('tree');
  const [fullNodes, setFullNodes] = useState<readonly TreeNode[]>([]);
  const [treeProblem, setTreeProblem] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthProblem, setHealthProblem] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const tree: TreeResponse = await api.tree();
        if (cancelled) return;
        setFullNodes(tree.nodes);
        setTreeProblem(null);
      } catch (error) {
        if (cancelled) return;
        setTreeProblem(describeError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.health();
        if (cancelled) return;
        setHealth(result);
        setHealthProblem(null);
      } catch (error) {
        if (cancelled) return;
        setHealth(null);
        setHealthProblem(describeError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, reloadToken]);

  const summary = useMemo(() => summarizeTree(fullNodes), [fullNodes]);

  function openNode(nodeId: string): void {
    setSelectedId(nodeId);
    setView('tree');
  }

  return (
    <div className="app-shell">
      <TopBar
        api={api}
        health={health}
        healthProblem={healthProblem}
        domainCount={summary.domainCount}
        nodeCount={summary.nodeCount}
        itemCount={summary.itemCount}
        onPickNode={openNode}
      />

      <nav className="workbench-tabs" aria-label="工作台导航">
        {TAB_ORDER.map((option) => (
          <button
            key={option}
            type="button"
            className={view === option ? 'workbench-tab workbench-tab-active' : 'workbench-tab'}
            aria-current={view === option}
            onClick={() => setView(option)}
          >
            {TAB_LABELS[option]}
          </button>
        ))}
        {treeProblem !== null ? <span className="workbench-tab-note">{treeProblem}</span> : null}
      </nav>

      {view === 'tree' ? (
        <KnowledgeWorkspace
          api={api}
          fullNodes={fullNodes}
          aiIsOffline={aiIsOffline(health)}
          selectedId={selectedId}
          onSelectNode={setSelectedId}
          onChanged={refresh}
        />
      ) : null}

      {view === 'inbox' ? (
        <div className="workbench-column">
          <InboxWorkspace api={api} nodes={fullNodes} onChanged={refresh} />
        </div>
      ) : null}

      {view === 'research' ? <ResearchWorkspace api={api} /> : null}

      {view === 'connection' ? (
        <div className="workbench-column">
          <ConnectionPanel
            health={health}
            healthProblem={healthProblem}
            apiBaseUrl={apiBaseUrl}
            tokenConfigured={tokenConfigured}
            outsideTauri={outsideTauri}
            onRecheck={refresh}
            onOpenSetup={onOpenSetup}
          />
        </div>
      ) : null}
    </div>
  );
}
