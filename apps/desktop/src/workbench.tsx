/** Default desktop window: one visual library backed by the local Knowledge Core. */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactElement } from 'react';
import { commands } from './lib/tauri';
import type { DesktopSettings } from './lib/tauri';
import ModelSettings from './workbench/ModelSettings';
import { createWorkbenchApi } from './workbench/api';
import WorkbenchApp from './workbench/WorkbenchApp';
import './workbench/workbench.css';

interface Booted {
  readonly api: ReturnType<typeof createWorkbenchApi>;
  readonly apiBaseUrl: string;
  readonly mcpEndpoint: string;
  readonly tokenConfigured: boolean;
  readonly outsideTauri: boolean;
  readonly settings: DesktopSettings;
}

const DEV_CORE_URL: string = import.meta.env.VITE_NOLTRI_CORE_URL ?? 'http://localhost:8787';
const DEV_MCP_URL: string = import.meta.env.VITE_NOLTRI_MCP_URL ?? 'http://127.0.0.1:8790/mcp';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function WorkbenchBoot(): ReactElement {
  const [booted, setBooted] = useState<Booted | null>(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!isTauri()) {
        // `vite` alone still renders: useful for styling, and it says so on screen instead of faking a Core.
        if (cancelled) return;
        setBooted({
          api: createWorkbenchApi({ apiBaseUrl: DEV_CORE_URL, apiToken: '' }),
          apiBaseUrl: DEV_CORE_URL,
          mcpEndpoint: DEV_MCP_URL,
          tokenConfigured: false,
          outsideTauri: true,
          settings: { apiBaseUrl: DEV_CORE_URL, apiToken: '', mcpEndpoint: DEV_MCP_URL, providers: [], activeProviderId: null, activeModelId: null, runtimeStatus: 'dev' },
        });
        return;
      }
      try {
        const settings = await commands.getSettings();
        if (cancelled) return;
        setBooted({
          api: createWorkbenchApi({ apiBaseUrl: settings.apiBaseUrl, apiToken: settings.apiToken }),
          apiBaseUrl: settings.apiBaseUrl,
          mcpEndpoint: settings.mcpEndpoint,
          tokenConfigured: settings.apiToken.trim().length > 0,
          outsideTauri: false,
          settings,
        });
      } catch (failure) {
        if (!cancelled) setProblem(failure instanceof Error ? failure.message : '无法读取本机设置。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (problem !== null) {
    return (
        <main className="boot-error-state">
        <div className="boot-error-mark" aria-hidden="true">知</div>
        <h1>暂时无法连接知序</h1>
        <p className="boot-error-note">读取本机连接设置失败：{problem}</p>
        <p className="boot-error-note">请重新启动应用；你的资料仍保存在本机数据库中。</p>
      </main>
    );
  }

  if (booted === null) {
    return (
      <main className="boot-loading"><span className="loader" />正在打开模型设置…</main>
    );
  }

  const modelSettings = <ModelSettings
    settings={booted.settings}
    outsideTauri={booted.outsideTauri}
    welcome={showWelcome}
    onSaved={(models, runtimeStatus) => setBooted((current) => current ? { ...current, settings: { ...current.settings, ...models, runtimeStatus } } : current)}
    {...(showWelcome ? { onDone: () => setShowWelcome(false) } : {})}
  />;

  if (showWelcome) return <main className="model-onboarding">{modelSettings}</main>;

  return (
    <WorkbenchApp
      api={booted.api}
      apiBaseUrl={booted.apiBaseUrl}
      mcpEndpoint={booted.mcpEndpoint}
      tokenConfigured={booted.tokenConfigured}
      outsideTauri={booted.outsideTauri}
      modelSettings={modelSettings}
    />
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<WorkbenchBoot />);
