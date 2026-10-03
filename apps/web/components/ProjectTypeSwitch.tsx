'use client';

import type { ReactElement } from 'react';

export type ProjectMode = 'knowledge' | 'research';

export interface ProjectTypeSwitchProps {
  mode: ProjectMode;
  onSwitchMode: (mode: ProjectMode) => void;
}

/**
 * Project Type switch for the first screen: 知识库 stays the default body of the app and 研究项目 is
 * reachable from the same top bar, never replacing the knowledge tree on its own.
 */
export default function ProjectTypeSwitch({ mode, onSwitchMode }: ProjectTypeSwitchProps): ReactElement {
  return (
    <div className="mode-switch" role="group" aria-label="项目类型">
      <button
        type="button"
        className={`mode-option${mode === 'knowledge' ? ' mode-option-active' : ''}`}
        aria-pressed={mode === 'knowledge'}
        onClick={() => onSwitchMode('knowledge')}
      >
        知识库
      </button>
      <button
        type="button"
        className={`mode-option${mode === 'research' ? ' mode-option-active' : ''}`}
        aria-pressed={mode === 'research'}
        onClick={() => onSwitchMode('research')}
      >
        研究项目
      </button>
    </div>
  );
}
