/**
 * The selection pill (V1 §11.3): a small always-on-top overlay that appears for an accepted
 * selection. One primary action (收纳), one dismiss; everything else lives in Setup Manager.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import type { ReactElement } from 'react';
import { commands, events } from './lib/tauri';
import { runCaptureFlow, type CaptureFlowOutcome } from './lib/capture-flow';
import type { Sample } from './lib/types';
import { listen } from '@tauri-apps/api/event';

type Phase = 'hidden' | 'ready' | 'sending' | 'done' | 'error';

function Pill(): ReactElement {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [sample, setSample] = useState<Sample | null>(null);
  const [outcome, setOutcome] = useState<CaptureFlowOutcome | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState('http://localhost:8787');
  const [apiToken, setApiToken] = useState('');

  useEffect(() => {
    void commands.captureState().then((state) => {
      setApiBaseUrl(state.apiBaseUrl);
    });
    void commands.getSettings().then((settings) => setApiToken(settings.apiToken)).catch(() => {
      // Token stays empty; capture then runs against an open local core.
    });

    const unlisteners: Promise<() => void>[] = [
      listen<Sample>(events.selectionChanged, (event) => {
        setOutcome(null);
        setSample(event.payload);
        setPhase('ready');
      }),
      listen<void>(events.pasteRequested, () => {
        // The native layer asks the paste window to open; the pill just steps aside.
        void commands.dismissOverlay();
      }),
    ];
    return () => {
      void unlisteners.forEach(async (promise) => (await promise)());
    };
  }, []);

  async function capture(): Promise<void> {
    if (sample === null) return;
    setPhase('sending');
    const result = await runCaptureFlow(
      { apiBaseUrl, apiToken },
      {
        text: sample.text,
        appName: sample.app_name,
        windowTitle: sample.window_title ?? undefined,
        via: 'pill',
      },
    );
    setOutcome(result);
    setPhase(result.ok ? 'done' : 'error');
  }

  if (phase === 'hidden') return <div className="pill pill-hidden" />;

  return (
    <div className="pill" role="status">
      <button
        type="button"
        className="pill-capture"
        disabled={phase === 'sending'}
        onClick={() => void capture()}
      >
        {phase === 'sending' ? '归纳中…' : '归纳知识点'}
      </button>
      <button type="button" className="pill-dismiss" aria-label="关闭" onClick={() => void commands.dismissOverlay()}>
        ×
      </button>
      {outcome !== null && <p className={`pill-outcome ${outcome.ok ? 'ok' : 'bad'}`}>{outcome.message}</p>}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Pill />);
