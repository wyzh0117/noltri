/**
 * Knowledge workbench entry — the WebView that takes the web app's 知识树 / 收件箱 / 搜索 / 节点对话 onto the
 * desktop (V1_DEVELOPMENT §08). The Core address and token come from the Rust settings store; after that
 * this window only speaks the typed Core client, with no cookie, server action or SSR session left.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactElement } from 'react';
import { commands } from './lib/tauri';
import { createWorkbenchApi } from './workbench/api';
import WorkbenchApp from './workbench/WorkbenchApp';
import './workbench/workbench.css';

interface Booted {
  readonly api: ReturnType<typeof createWorkbenchApi>;
  readonly apiBaseUrl: string;
  readonly tokenConfigured: boolean;
  readonly outsideTauri: boolean;
}

const DEV_CORE_URL: string = import.meta.env.VITE_NOLTRI_CORE_URL ?? 'http://localhost:8787';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function WorkbenchBoot(): ReactElement {
  const [booted, setBooted] = useState<Booted | null>(null);
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
          tokenConfigured: false,
          outsideTauri: true,
        });
        return;
      }
      try {
        const settings = await commands.getSettings();
        if (cancelled) return;
        setBooted({
          api: createWorkbenchApi({ apiBaseUrl: settings.apiBaseUrl, apiToken: settings.apiToken }),
          apiBaseUrl: settings.apiBaseUrl,
          tokenConfigured: settings.apiToken.trim().length > 0,
          outsideTauri: false,
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
      <main className="workbench-column">
        <div className="column-title">知识工作台</div>
        <p className="error-note">读取本机设置失败：{problem}</p>
        <p className="muted-note">请在 Setup Manager 中确认 Knowledge Core 地址与令牌。</p>
      </main>
    );
  }

  if (booted === null) {
    return (
      <main className="workbench-column">
        <p className="muted-note">正在读取本机设置…</p>
      </main>
    );
  }

  return (
    <WorkbenchApp
      api={booted.api}
      apiBaseUrl={booted.apiBaseUrl}
      tokenConfigured={booted.tokenConfigured}
      outsideTauri={booted.outsideTauri}
      onOpenSetup={() => {
        // Outside a built app there is no Setup Manager to raise; the tab still shows what it read.
        void commands.openSetupManager().catch(() => undefined);
      }}
    />
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<WorkbenchBoot />);
