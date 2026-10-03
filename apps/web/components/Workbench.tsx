'use client';

import { useState } from 'react';
import type { ReactElement } from 'react';
import Workspace from './Workspace';
import ResearchWorkspace from './research/ResearchWorkspace';
import type { ProjectMode } from './ProjectTypeSwitch';
import type { SessionStrategy } from '@/lib/cookie';

export interface WorkbenchProps {
  strategy: SessionStrategy;
}

/**
 * Project Type shell: 知识库 (the knowledge tree, unchanged) is the default body and 研究项目 opens
 * the Research workbench from the same first screen. Switching never changes knowledge behaviour.
 */
export default function Workbench({ strategy }: WorkbenchProps): ReactElement {
  const [mode, setMode] = useState<ProjectMode>('knowledge');

  if (mode === 'research') {
    return <ResearchWorkspace strategy={strategy} mode={mode} onSwitchMode={setMode} />;
  }
  return <Workspace strategy={strategy} mode={mode} onSwitchMode={setMode} />;
}
